"""Reads keys from secrets.txt (git-ignored) into the environment, so they never need to be typed into a command.

secrets.txt can hold lines like `GOOGLE_PLACES_API_KEY=...` or `GOOGLE_PLACES_API_KEY: ...`; failing that, a Google API
key (they start "AIza") anywhere in the file is taken as the Places key. Values already in the environment win."""
import os
import re
from pathlib import Path

SECRETS_FILE = Path(__file__).parent / "secrets.txt"
NAMES = ("GOOGLE_PLACES_API_KEY",)
GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z_\-]{35}")


def load_secrets():
    if not SECRETS_FILE.exists():
        return
    text = SECRETS_FILE.read_text(encoding="utf-8", errors="ignore")
    for name in NAMES:
        if os.environ.get(name):
            continue
        named = re.search(rf"^\s*(?:export\s+)?{name}\s*[=:]\s*['\"]?([^'\"\s#]+)", text, re.M)
        found = named.group(1) if named else (GOOGLE_KEY.search(text).group(0) if GOOGLE_KEY.search(text) else None)
        if found:
            os.environ[name] = found
