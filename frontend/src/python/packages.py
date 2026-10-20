"""Installs PyPI packages with micropip and reports what got installed."""

from importlib import metadata

import micropip
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


async def install(specs: list[str]) -> list[dict]:
    results = []
    for spec in specs:
        try:
            name = canonicalize_name(Requirement(spec).name)
        except Exception as exc:  # noqa: BLE001
            results.append({"spec": spec, "error": f"Invalid package name: {exc}"})
            continue
        try:
            await micropip.install(spec)
            results.append({"spec": spec, "name": name, "version": metadata.version(name)})
        except Exception as exc:  # noqa: BLE001 - report every failure to the UI
            message = str(exc).strip().splitlines()
            results.append({"spec": spec, "name": name, "error": message[0] if message else type(exc).__name__})
    return results
