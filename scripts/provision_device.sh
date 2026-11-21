#!/usr/bin/env bash
# Provision one doll for AWS IoT Core: thing, certificate, policy attachment, endpoint,
# Amazon Root CA 1 and a warashi-aws.toml for the device config.
#
#   scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
#       --policy <DevicePolicyName> [--region ap-northeast-1] [--rotate] [--pi-dir /home/pi/.warashi]
#
#   --policy  the device policy name, a stack output of the cloud app.
#   --rotate  issue a new certificate; the old one is deactivated only after the new one
#             is attached to both the policy and the thing.
#
# Safety rules (R21):
#   * --out must resolve (symlinks followed) to a place outside any git work tree, so keys
#     never reach the repository. The check runs before any file or AWS resource exists.
#   * umask 077 is set before the first file; --out is 0700, the private key 0600.
#   * The private key is written by the AWS CLI straight into --out. Nothing derived from it
#     is printed or logged. AWS output is reduced with --query to a single non-secret value.
# AWS CLI v2 and curl only; no jq. Steps are idempotent, so a re-run changes nothing.
set -euo pipefail
umask 077

DEFAULT_REGION="ap-northeast-1"
CA_URL="https://www.amazontrust.com/repository/AmazonRootCA1.pem"
CERT_FILE_NAME="device.pem.crt"
KEY_FILE_NAME="device.private.key"
CA_FILE_NAME="AmazonRootCA1.pem"
ARN_FILE_NAME="certificate-arn.txt"
TOML_FILE_NAME="warashi-aws.toml"

usage() {
    cat >&2 <<'EOF'
Usage: provision_device.sh --thing <name> --out <dir> --policy <policy-name>
                           [--region <region>] [--rotate] [--pi-dir <dir on the Pi>]

  --thing    IoT thing name, for example warashi-01
  --out      directory for the certificate, key, CA and warashi-aws.toml;
             must be outside any git work tree
  --policy   device policy name (stack output of the cloud app)
  --region   AWS Region (default: ap-northeast-1)
  --rotate   create a new certificate and retire the old one
  --pi-dir   directory on the Pi used for the paths in warashi-aws.toml
             (default: /home/pi/.warashi)
EOF
}

fail() {
    # fail <step> <message>
    echo "provision_device: step '$1' failed: $2" >&2
    exit 1
}

THING=""
OUT=""
POLICY=""
REGION="$DEFAULT_REGION"
ROTATE=0
PI_DIR="/home/pi/.warashi"

# Step 1: arguments. Nothing is created before they are valid (R21.10).
while [ $# -gt 0 ]; do
    case "$1" in
        --thing)  [ $# -ge 2 ] || { usage; exit 2; }; THING="$2"; shift 2 ;;
        --out)    [ $# -ge 2 ] || { usage; exit 2; }; OUT="$2"; shift 2 ;;
        --policy) [ $# -ge 2 ] || { usage; exit 2; }; POLICY="$2"; shift 2 ;;
        --region) [ $# -ge 2 ] || { usage; exit 2; }; REGION="$2"; shift 2 ;;
        --pi-dir) [ $# -ge 2 ] || { usage; exit 2; }; PI_DIR="$2"; shift 2 ;;
        --rotate) ROTATE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "provision_device: unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

if [ -z "$THING" ] || [ -z "$OUT" ] || [ -z "$POLICY" ]; then
    echo "provision_device: --thing, --out and --policy are required and must not be empty" >&2
    usage
    exit 2
fi
if [ -z "$REGION" ] || [ -z "$PI_DIR" ]; then
    echo "provision_device: --region and --pi-dir must not be empty" >&2
    usage
    exit 2
fi
# Names go into AWS calls and a TOML file: allow plain characters only.
if ! [[ "$THING" =~ ^[A-Za-z0-9:_-]{1,128}$ ]]; then
    fail "arguments" "--thing allows A-Z a-z 0-9 : _ - (1 to 128 characters)"
fi
if ! [[ "$POLICY" =~ ^[A-Za-z0-9+=,.@_-]{1,128}$ ]]; then
    fail "arguments" "--policy allows A-Z a-z 0-9 + = , . @ _ - (1 to 128 characters)"
fi
if ! [[ "$REGION" =~ ^[a-z0-9-]{1,32}$ ]]; then
    fail "arguments" "--region has an unexpected format"
fi
if ! [[ "$PI_DIR" =~ ^/[A-Za-z0-9._/-]*$ ]]; then
    fail "arguments" "--pi-dir must be an absolute path of plain characters"
fi
PI_DIR="${PI_DIR%/}"

# Step 2: refuse an --out inside a git work tree (R21.4). The deepest existing ancestor is
# resolved with symlinks followed (the missing tail cannot be a link), then asked to git.
case "$OUT" in
    /*) ABS_OUT="$OUT" ;;
    *)  ABS_OUT="$PWD/$OUT" ;;
esac
ABS_OUT="${ABS_OUT%/}"
probe="$ABS_OUT"
tail_part=""
while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do
    tail_part="/$(basename "$probe")$tail_part"
    probe="$(dirname "$probe")"
done
probe_real="$(cd -P "$probe" 2>/dev/null && pwd -P)" \
    || fail "output directory check" "cannot resolve the path of --out"
RESOLVED_OUT="${probe_real%/}$tail_part"
if [ "$(git -C "$probe_real" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ]; then
    echo "provision_device: --out resolves to $RESOLVED_OUT, which is inside a git work tree. Keys must never be stored in a repository; choose a directory outside it." >&2
    exit 1
fi
OUT="$RESOLVED_OUT"

command -v aws >/dev/null 2>&1 || fail "prerequisites" "the AWS CLI (v2) is not installed"
command -v curl >/dev/null 2>&1 || fail "prerequisites" "curl is not installed"

# Every AWS call carries the Region (R21.11). Output is always reduced by --query to a
# single non-secret value, so nothing from the response can leak key material.
aws_iot() {
    aws iot "$@" --region "$REGION"
}

CERT_FILE="$OUT/$CERT_FILE_NAME"
KEY_FILE="$OUT/$KEY_FILE_NAME"
CA_FILE="$OUT/$CA_FILE_NAME"
ARN_FILE="$OUT/$ARN_FILE_NAME"
TOML_FILE="$OUT/$TOML_FILE_NAME"
NEW_CERT_FILE="$OUT/.new.$CERT_FILE_NAME"
NEW_KEY_FILE="$OUT/.new.$KEY_FILE_NAME"
NEW_ARN_FILE="$OUT/.new.$ARN_FILE_NAME"
TMP_CA="$OUT/.tmp.$CA_FILE_NAME"
TMP_TOML="$OUT/.tmp.$TOML_FILE_NAME"

cleanup_temp() {
    rm -f "$NEW_CERT_FILE" "$NEW_KEY_FILE" "$NEW_ARN_FILE" "$TMP_CA" "$TMP_TOML"
}
trap cleanup_temp EXIT

# Step 3: output directory, mode 0700 (R21.3).
mkdir -p "$OUT"
chmod 700 "$OUT"

# create_certificate <cert-file> <key-file> -> prints the certificate ARN.
# The files are created empty first, under umask 077, so the key is never wider than 0600.
create_certificate() {
    local cert_path="$1" key_path="$2" arn
    : > "$cert_path"
    : > "$key_path"
    chmod 600 "$cert_path" "$key_path"
    arn="$(aws_iot create-keys-and-certificate --set-as-active \
        --certificate-pem-outfile "$cert_path" \
        --private-key-outfile "$key_path" \
        --query certificateArn --output text)" || return 1
    chmod 600 "$cert_path" "$key_path"
    [ -n "$arn" ] || return 1
    printf '%s' "$arn"
}

# attach_certificate <arn>: policy first, then thing. Both calls are idempotent.
attach_certificate() {
    local arn="$1"
    aws_iot attach-policy --policy-name "$POLICY" --target "$arn" \
        || { echo "provision_device: step 'attach policy' failed" >&2; return 1; }
    aws_iot attach-thing-principal --thing-name "$THING" --principal "$arn" \
        || { echo "provision_device: step 'attach thing principal' failed" >&2; return 1; }
}

# Step 4: the thing exists (R21.1).
if ! aws_iot describe-thing --thing-name "$THING" --query thingName --output text >/dev/null 2>&1; then
    aws_iot create-thing --thing-name "$THING" --query thingName --output text >/dev/null \
        || fail "create thing" "could not create thing $THING"
fi

# Step 5: certificate.
if [ -e "$KEY_FILE" ] || [ -e "$CERT_FILE" ] || [ -e "$ARN_FILE" ]; then
    HAVE_CERT=1
    if [ ! -s "$KEY_FILE" ] || [ ! -s "$CERT_FILE" ] || [ ! -s "$ARN_FILE" ]; then
        fail "existing certificate" "$OUT holds an incomplete set of files; remove them or choose another --out"
    fi
else
    HAVE_CERT=0
fi

if [ "$ROTATE" -eq 1 ] && [ "$HAVE_CERT" -eq 1 ]; then
    # Rotation (R21.7, R21.8): nothing about the old certificate changes until the new one
    # is attached to both the policy and the thing.
    OLD_ARN="$(cat "$ARN_FILE")"
    NEW_ARN=""
    rotation_failed() {
        # Best effort: retire the unused new certificate. The old one stays active.
        if [ -n "$NEW_ARN" ]; then
            aws_iot update-certificate --certificate-id "${NEW_ARN##*/}" --new-status INACTIVE >/dev/null 2>&1 || true
            aws_iot detach-thing-principal --thing-name "$THING" --principal "$NEW_ARN" >/dev/null 2>&1 || true
            aws_iot detach-policy --policy-name "$POLICY" --target "$NEW_ARN" >/dev/null 2>&1 || true
        fi
        fail "rotate: $1" "the old certificate is still active and attached"
    }
    NEW_ARN="$(create_certificate "$NEW_CERT_FILE" "$NEW_KEY_FILE")" \
        || { NEW_ARN=""; rotation_failed "create certificate"; }
    aws_iot attach-policy --policy-name "$POLICY" --target "$NEW_ARN" \
        || rotation_failed "attach policy"
    aws_iot attach-thing-principal --thing-name "$THING" --principal "$NEW_ARN" \
        || rotation_failed "attach thing principal"
    # Both attachments succeeded: retire the old certificate.
    aws_iot update-certificate --certificate-id "${OLD_ARN##*/}" --new-status INACTIVE \
        || fail "rotate: deactivate old certificate" "the old certificate may still be active"
    aws_iot detach-thing-principal --thing-name "$THING" --principal "$OLD_ARN" \
        || fail "rotate: detach old certificate from thing" "the old certificate is inactive but still attached"
    aws_iot detach-policy --policy-name "$POLICY" --target "$OLD_ARN" \
        || fail "rotate: detach old certificate from policy" "the old certificate is inactive but still attached"
    printf '%s' "$NEW_ARN" > "$NEW_ARN_FILE"
    mv -f "$NEW_CERT_FILE" "$CERT_FILE"
    mv -f "$NEW_KEY_FILE" "$KEY_FILE"
    mv -f "$NEW_ARN_FILE" "$ARN_FILE"
    CERT_ARN="$NEW_ARN"
elif [ "$HAVE_CERT" -eq 1 ]; then
    # Second run (R21.2): keep the existing files and make sure the attachments exist.
    CERT_ARN="$(cat "$ARN_FILE")"
    attach_certificate "$CERT_ARN" || fail "attach" "could not attach the existing certificate"
else
    CERT_ARN="$(create_certificate "$CERT_FILE" "$KEY_FILE")" \
        || { rm -f "$CERT_FILE" "$KEY_FILE"; fail "create certificate" "create-keys-and-certificate returned an error"; }
    printf '%s' "$CERT_ARN" > "$ARN_FILE"
    attach_certificate "$CERT_ARN" || fail "attach" "the certificate is created but not fully attached; run the script again"
fi

# Step 6: endpoint and Amazon Root CA 1. A failure here writes no warashi-aws.toml (R21.6).
ENDPOINT="$(aws_iot describe-endpoint --endpoint-type iot:Data-ATS \
    --query endpointAddress --output text)" \
    || fail "read endpoint" "describe-endpoint returned an error"
if ! [[ "$ENDPOINT" =~ ^[A-Za-z0-9.-]+$ ]]; then
    fail "read endpoint" "the endpoint has an unexpected format"
fi

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$TMP_CA" "$CA_URL" \
    || fail "download Amazon Root CA 1" "curl returned an error"
if ! grep -q "BEGIN CERTIFICATE" "$TMP_CA"; then
    fail "download Amazon Root CA 1" "the downloaded file is not a PEM certificate"
fi
mv -f "$TMP_CA" "$CA_FILE"
chmod 644 "$CA_FILE"

# Step 7: warashi-aws.toml, written to a temporary file first (R21.5).
cat > "$TMP_TOML" <<EOF
# Generated by scripts/provision_device.sh. Copy the three files it names to the Pi,
# then merge this table into the device config.toml. No key material is stored here.
[aws]
enabled = true
endpoint = "$ENDPOINT"
port = 8883
ca_file = "$PI_DIR/$CA_FILE_NAME"
cert_file = "$PI_DIR/$CERT_FILE_NAME"
key_file = "$PI_DIR/$KEY_FILE_NAME"
keepalive_s = 60
reconnect_min_s = 1
reconnect_max_s = 60
EOF
mv -f "$TMP_TOML" "$TOML_FILE"

echo "provision_device: done. Thing '$THING' is ready in $REGION."
echo "Copy the files to the Pi (replace <user>@<host>; the key is not printed):"
echo "  ssh <user>@<host> 'mkdir -p -m 700 $PI_DIR'"
echo "  scp '$CERT_FILE' '$KEY_FILE' '$CA_FILE' '$TOML_FILE' <user>@<host>:$PI_DIR/"
echo "Then merge the [aws] table of $TOML_FILE_NAME into the device config.toml."
