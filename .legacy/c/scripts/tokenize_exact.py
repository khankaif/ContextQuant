#!/usr/bin/env python3
"""
tokenize_exact.py — exact token count via tiktoken (cl100k_base)

Usage:
    python scripts/tokenize_exact.py <file>
    echo "some text" | python scripts/tokenize_exact.py -

Output (JSON):
    {"tokens": 1234, "file": "foo.json", "encoding": "cl100k_base"}

Install dep:
    pip install tiktoken
"""

import sys
import json
import os

try:
    import tiktoken
except ImportError:
    print(json.dumps({"error": "tiktoken not installed — run: pip install tiktoken"}))
    sys.exit(1)

def count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    enc = tiktoken.get_encoding(encoding_name)
    return len(enc.encode(text))

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file|->\n", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    encoding = sys.argv[2] if len(sys.argv) > 2 else "cl100k_base"

    if path == "-":
        text = sys.stdin.read()
        label = "<stdin>"
    else:
        if not os.path.exists(path):
            print(json.dumps({"error": f"File not found: {path}"}))
            sys.exit(1)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        label = path

    n = count_tokens(text, encoding)
    print(json.dumps({"tokens": n, "file": label, "encoding": encoding}))

if __name__ == "__main__":
    main()
