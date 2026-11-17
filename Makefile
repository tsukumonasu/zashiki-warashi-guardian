# Zashiki-Warashi Guardian
#
# make setup   create device/.venv with Python 3.13 and the dev tools
# make test    unit and property tests (device now; cloud and dashboard added by later specs)
# make lint    ruff check + format check (device now; eslint and tsc added later)
#
# Override the interpreter, for example in CI:  make test DEVICE_PY=python3

PYTHON    ?= python3.13
DEVICE_PY ?= .venv/bin/python

.PHONY: setup test lint test-device lint-device

setup:
	cd device && $(PYTHON) -m venv .venv && .venv/bin/pip install -e ".[dev]"

test: test-device

lint: lint-device

test-device:
	cd device && $(DEVICE_PY) -m pytest

lint-device:
	cd device && $(DEVICE_PY) -m ruff check .
	cd device && $(DEVICE_PY) -m ruff format --check .
