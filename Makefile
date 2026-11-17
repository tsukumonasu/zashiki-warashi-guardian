# Makefile — Zashiki-Warashi Guardian
#
# Targets added here as specs are implemented:
#   test  — device (now) | cloud, dashboard (added by later specs)
#   lint  — device (now) | cloud, dashboard (added by later specs)
#
# Prerequisites on a development laptop:
#   cd device && python3.13 -m venv .venv && .venv/bin/pip install -e ".[dev]"

DEVICE_PY := device/.venv/bin/python

.PHONY: test lint test-device lint-device

# ---------------------------------------------------------------------------
# Default targets
# ---------------------------------------------------------------------------

test: test-device

lint: lint-device

# ---------------------------------------------------------------------------
# Device
# ---------------------------------------------------------------------------

test-device:
	cd device && ../${DEVICE_PY} -m pytest

lint-device:
	cd device && ../${DEVICE_PY} -m ruff check warashi_agent tests tools
	cd device && ../${DEVICE_PY} -m ruff format --check warashi_agent tests tools
