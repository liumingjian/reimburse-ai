#!/usr/bin/env python3
"""Run the pinned, offline MarkItDown converter and return one JSON envelope."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()

    try:
        payload: dict[str, Any]
        from markitdown import MarkItDown

        # Plugins and the Azure converters are deliberately disabled. The caller
        # owns the original bytes and this process only extracts local text.
        result = MarkItDown(enable_plugins=False).convert(pathlib.Path(args.input))
        markdown = result.markdown if isinstance(result.markdown, str) else ""
        payload = {
            "status": "converted" if markdown.strip() else "empty",
            "markdown": markdown,
            "title": result.title if isinstance(result.title, str) else None,
        }
    except Exception as error:  # pragma: no cover - exercised through the Node boundary
        payload = {
            "status": "failed",
            "markdown": "",
            "title": None,
            "error": {"type": type(error).__name__, "message": str(error)},
        }

    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
