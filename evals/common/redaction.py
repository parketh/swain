"""Exact known-secret redaction for wrapper command/result diagnostics.

This is a defense-in-depth layer on top of Swain's own redaction: the wrappers
capture Swain NDJSON and surface exec output in errors, so exact known secret
values are scrubbed before anything is logged. The guarantee is exact-value
replacement only; a model that transforms/splits a secret is out of scope.
"""

from __future__ import annotations

from collections.abc import Iterable

REDACTED = "[REDACTED]"

# Values shorter than this are not globally replaced, so ordinary text is not
# corrupted. Real API keys comfortably exceed it.
MIN_SECRET_LENGTH = 12


def _usable_secrets(secrets: Iterable[str]) -> list[str]:
    # Replace longest-first so a secret that contains a shorter one is handled
    # before the substring match.
    usable = {s for s in secrets if s and len(s) >= MIN_SECRET_LENGTH}
    return sorted(usable, key=len, reverse=True)


def redact_text(text: str, secrets: Iterable[str]) -> str:
    """Replace every exact occurrence of each qualifying secret with ``[REDACTED]``."""
    for secret in _usable_secrets(secrets):
        text = text.replace(secret, REDACTED)
    return text


def redact_value(value: object, secrets: Iterable[str]) -> object:
    """Recursively redact qualifying secrets from strings in a JSON-like value."""
    usable = _usable_secrets(secrets)
    if not usable:
        return value
    return _redact(value, usable)


def _redact(value: object, secrets: list[str]) -> object:
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, REDACTED)
        return value
    if isinstance(value, dict):
        return {k: _redact(v, secrets) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v, secrets) for v in value]
    return value
