#!/usr/bin/env bash
# Deploy /device to the doll's Raspberry Pi and (re)start the warashi-agent service.
#
#   PI_HOST=<user>@<hostname>.local scripts/deploy_pi.sh
#   PI_DIR   remote directory, default ~/warashi/device (relative to the login home)
#
# Steps: copy, user query, unit installation, restart. A failing step prints its
# name and stops the script with a non-zero code; no later step runs (R28.6).
# No host, user or secret is stored here (R28.7). The sudo calls use `ssh -t`, so a Pi whose
# sudo asks for a password prompts in your terminal (once per call); passwordless sudo works too.
set -euo pipefail

fail() {
    # fail <step> <message> [code]
    echo "deploy_pi: step '$1' failed: $2" >&2
    exit "${3:-1}"
}

# Step 1: PI_HOST check, before any network call (R28.2).
if [ -z "${PI_HOST:-}" ]; then
    echo "PI_HOST is not set (example: PI_HOST=<user>@<hostname>.local)" >&2
    exit 1
fi

# Step 2: PI_DIR. A leading "~/" is stripped: a relative remote path is
# relative to the login home on both rsync and openrsync.
PI_DIR="${PI_DIR:-~/warashi/device}"
case "$PI_DIR" in
    "~/"*) PI_DIR="${PI_DIR#\~/}" ;;
esac
PI_DIR="${PI_DIR%/}"
# The value is used inside remote shell commands, so allow plain path characters only.
if ! [[ "$PI_DIR" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$PI_DIR" == -* ]] || [[ "$PI_DIR" == *..* ]]; then
    fail "PI_DIR" "unsupported characters in PI_DIR (allowed: A-Z a-z 0-9 . _ / -)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE_SRC="$SCRIPT_DIR/../device/"
UNIT_NAME="warashi-agent"

# Step 3: copy. No --delete, so nothing on the Pi is removed (R28.3, R28.4).
# openrsync (macOS) has no --mkpath, hence the remote mkdir through --rsync-path.
rsync -a \
    --rsync-path="mkdir -p '$PI_DIR' && rsync" \
    --exclude=config.toml \
    --exclude=.venv \
    --exclude=__pycache__ \
    --exclude=.pytest_cache \
    --exclude=.ruff_cache \
    --exclude='*.egg-info' \
    --exclude=last_pose.json \
    "$DEVICE_SRC" "$PI_HOST:$PI_DIR/" || fail "copy" "rsync returned an error"

# Step 4: user query (R28.5, R28.8).
PI_USER="$(ssh "$PI_HOST" id -un)" || fail "user query" "ssh id -un returned an error"
if [ "$PI_USER" = "root" ]; then
    fail "user query" "the service must not run as root"
fi
if ! [[ "$PI_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    fail "user query" "unexpected user name from the Pi"
fi

# Step 5: unit installation with the absolute working directory.
WORKDIR="$(ssh "$PI_HOST" "cd '$PI_DIR' && pwd")" \
    || fail "unit installation" "could not resolve the working directory"
if ! [[ "$WORKDIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    fail "unit installation" "unexpected working directory from the Pi"
fi
ssh -t "$PI_HOST" "sed -e 's|@WORKDIR@|$WORKDIR|g' -e 's|@USER@|$PI_USER|g' '$PI_DIR/systemd/$UNIT_NAME.service' | sudo tee /etc/systemd/system/$UNIT_NAME.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable $UNIT_NAME" \
    || fail "unit installation" "could not install or enable the unit"

# Step 6: restart.
ssh -t "$PI_HOST" sudo systemctl restart "$UNIT_NAME" || fail "restart" "could not restart $UNIT_NAME"

echo "deploy_pi: done ($UNIT_NAME restarted)"
