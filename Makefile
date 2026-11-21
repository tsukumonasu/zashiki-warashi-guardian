# Zashiki-Warashi Guardian
#
# make setup   create device/.venv with Python 3.13 and the dev tools
# make test    unit and property tests (device now; cloud and dashboard added by later specs)
# make lint    ruff check + format check, and bash -n on scripts/deploy_pi.sh
#              (device now; eslint and tsc added later)
# make fake    run the agent on a laptop with fake adapters (python -m warashi_agent --fake)
# make deploy  rsync /device to $PI_HOST and restart the service (scripts/deploy_pi.sh)
#
# HYPOTHESIS_PROFILE (for example "ci") is passed through to pytest when set:
#   make test HYPOTHESIS_PROFILE=ci
# Override the interpreter, for example in CI:  make test DEVICE_PY=python3

PYTHON    ?= python3.13
DEVICE_PY ?= .venv/bin/python

.PHONY: setup test lint test-device lint-device test-cloud lint-cloud fake deploy

# HYPOTHESIS_PROFILE needs no recipe code: make exports command-line and environment
# variables to recipes, and it stays unset (pytest default) when the caller omits it.

setup:
	cd device && $(PYTHON) -m venv .venv && .venv/bin/pip install -e ".[dev]"

test: test-device test-cloud

lint: lint-device lint-cloud

test-cloud:
	cd cloud && npx vitest --run

lint-cloud:
	cd cloud && npx eslint .
	cd cloud && npx tsc --noEmit

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
