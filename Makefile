# Zashiki-Warashi Guardian
#
# make setup   create device/.venv with Python 3.13 and the dev tools
# make test    unit and property tests (device, cloud, dashboard) + voice catalog drift check
# make lint    ruff check + format check, and bash -n on scripts/deploy_pi.sh
#              (device), eslint + tsc --noEmit (cloud, dashboard)
# make fake    run the agent on a laptop with fake adapters (python -m warashi_agent --fake)
# make deploy  rsync /device to $PI_HOST and restart the service (scripts/deploy_pi.sh)
#
# HYPOTHESIS_PROFILE (for example "ci") is passed through to pytest when set:
#   make test HYPOTHESIS_PROFILE=ci
# Override the interpreter, for example in CI:  make test DEVICE_PY=python3

PYTHON    ?= python3.13
DEVICE_PY ?= .venv/bin/python

.PHONY: setup test lint test-device lint-device test-cloud lint-cloud test-dashboard lint-dashboard fake deploy

# HYPOTHESIS_PROFILE needs no recipe code: make exports command-line and environment
# variables to recipes, and it stays unset (pytest default) when the caller omits it.

setup:
	cd device && $(PYTHON) -m venv .venv && .venv/bin/pip install -e ".[dev]"

test: test-device test-cloud test-dashboard

lint: lint-device lint-cloud lint-dashboard

test-cloud:
	cd cloud && npx vitest --run

lint-cloud:
	cd cloud && npx eslint .
	cd cloud && npx tsc --noEmit

# The voice catalog check fails when device/warashi_agent/voice/lines.toml and the bundled
# dashboard catalog drift apart. scripts/export_voice_catalog.py is created by the
# dashboard-simulation task 5.1; until then this target fails on the missing script.
test-dashboard:
	cd dashboard && npx vitest --run
	$(PYTHON) scripts/export_voice_catalog.py --check

lint-dashboard:
	cd dashboard && npx eslint .
	cd dashboard && npx tsc --noEmit

test-device:
	cd device && $(DEVICE_PY) -m pytest

lint-device:
	cd device && $(DEVICE_PY) -m ruff check .
	cd device && $(DEVICE_PY) -m ruff format --check .
	bash -n scripts/deploy_pi.sh

# Run the agent on a laptop: fake adapters, keyboard input, no hardware.
fake:
	cd device && $(DEVICE_PY) -m warashi_agent --fake

# Deploy to the Pi (needs PI_HOST; see scripts/deploy_pi.sh).
deploy:
	scripts/deploy_pi.sh
