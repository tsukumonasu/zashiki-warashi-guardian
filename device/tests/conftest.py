"""Shared pytest configuration.

Hypothesis does not read pyproject.toml, so its settings live here as profiles.
Select one with HYPOTHESIS_PROFILE=ci (default: dev).
"""

import os

from hypothesis import settings

settings.register_profile("dev", max_examples=100)
settings.register_profile("ci", max_examples=500, deadline=None, print_blob=True)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))
