# Kiro usage journal

A running record of how Kiro was used to build this project. It feeds the "How we used Kiro"
section of the submission, so every line must be true and point to evidence in the repository.

Format: `YYYY-MM-DD | spec or vibe | what Kiro produced | what the human changed or rejected | evidence (file or commit)`

<!-- Add new entries below, newest last. -->

2026-11-17 | vibe | Repository scaffold: LICENSE, README stub, .gitignore, device/ package (pyproject.toml with pytest + Hypothesis + ruff, stub modules, voice/lines.toml, config.example.toml), Makefile (test + lint), device/tools/*.py translated to English, device/tools/README.md | Supplied the Pi's Python version (3.13.5) when Kiro asked; had Kiro use a local Python 3.13 venv instead of the laptop's 3.11 | commit 7c6c508
2026-11-17 | vibe | Second-pass review of the scaffold. Found: `config.toml` was not git-ignored (a trailing comment had become part of the pattern); `[tool.hypothesis]` in pyproject.toml is never read by Hypothesis; the tools README described the wrong bring-up order and missed that gpiozero snaps each servo to 0° on creation and that `warashi_test.py servo` tilts to ±30°; the first pass had replaced the owner's user and host name in an scp hint without saying so (now commented in the code) | Asked for the review | .gitignore, device/tests/conftest.py, device/tools/README.md, device/tools/warashi_check.py
