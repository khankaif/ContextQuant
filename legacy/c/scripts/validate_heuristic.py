#!/usr/bin/env python3
"""
validate_heuristic.py — compare heuristic tokenizer vs tiktoken ground truth

Runs the CLI on a file (--tally mode not yet in CLI, so we use heuristic output),
then compares against tiktoken. Also computes per-segment accuracy by chunking input.

Usage:
    python scripts/validate_heuristic.py <file> [json|csv|log|code]

Requires:
    pip install tiktoken
    make cli  (builds ./contextquant_cli)

Output: table showing heuristic vs exact, % error per chunk, overall delta
"""

import sys
import os
import json
import subprocess
import textwrap

try:
    import tiktoken
except ImportError:
    print("ERROR: pip install tiktoken")
    sys.exit(1)

ENCODING = "cl100k_base"
CLI      = "./contextquant_cli"
CHUNK_SZ = 2000   # characters per validation chunk

# ── heuristic (mirrors cq_tokenizer.c heuristic_v2_char_class) ─────────────
def heuristic_v2(text: str) -> int:
    """Python mirror of cq_tokenizer.c heuristic_v2_count (calibrated weights)."""
    total = 0.0
    i = 0
    while i < len(text):
        ch = text[i]
        b = ord(ch)
        if b >= 0x80:                          # UTF-8 multibyte
            total += 1.0 / 3.0
            i += 1
        elif ch in ' \t\n\r':                  # whitespace
            total += 1.0 / 2.5
            i += 1
        elif ch.isdigit():                     # digit
            total += 1.0 / 4.0
            i += 1
        elif ch.isalpha() or ch == '_':        # alpha run
            run = 0
            has_upper = False
            while i < len(text) and (text[i].isalnum() or text[i] == '_'):
                if text[i].isupper(): has_upper = True
                run += 1; i += 1
            weight = 3.5 if has_upper else 5.5
            total += run / weight
        else:                                  # ASCII punctuation
            total += 1.0 / 3.0
            i += 1
    return max(1, round(total))

# ── tiktoken exact ──────────────────────────────────────────────────────────
_enc = tiktoken.get_encoding(ENCODING)

def exact(text: str) -> int:
    return len(_enc.encode(text))

# ── main ────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file> [json|csv|log|code]")
        sys.exit(1)

    path = sys.argv[1]
    fmt  = sys.argv[2] if len(sys.argv) > 2 else "json"

    if not os.path.exists(path):
        print(f"File not found: {path}"); sys.exit(1)

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    # ── whole-file comparison ───────────────────────────────────────────────
    h_total = heuristic_v2(text)
    e_total = exact(text)
    delta   = h_total - e_total
    pct_err = delta / e_total * 100 if e_total else 0

    print(f"\n{'='*56}")
    print(f"  File      : {path}  ({len(text):,} chars)")
    print(f"  Encoding  : {ENCODING}")
    print(f"{'='*56}")
    print(f"  Exact (tiktoken) tokens : {e_total:>10,}")
    print(f"  Heuristic v2 tokens     : {h_total:>10,}")
    print(f"  Delta                   : {delta:>+10,}  ({pct_err:+.1f}%)")
    print(f"{'='*56}")

    # ── per-chunk analysis ──────────────────────────────────────────────────
    chunks = [text[i:i+CHUNK_SZ] for i in range(0, len(text), CHUNK_SZ)]
    errors = [abs(heuristic_v2(c) - exact(c)) / max(1, exact(c)) * 100 for c in chunks]
    avg_err = sum(errors) / len(errors) if errors else 0
    max_err = max(errors) if errors else 0
    within5 = sum(1 for e in errors if e <= 5) / len(errors) * 100 if errors else 0
    within15= sum(1 for e in errors if e <= 15)/ len(errors) * 100 if errors else 0

    print(f"\n  Chunk validation ({len(chunks)} x {CHUNK_SZ}-char chunks):")
    print(f"    Avg absolute error : {avg_err:.1f}%")
    print(f"    Max absolute error : {max_err:.1f}%")
    print(f"    Within  5% error   : {within5:.0f}% of chunks")
    print(f"    Within 15% error   : {within15:.0f}% of chunks")

    # ── verdict ─────────────────────────────────────────────────────────────
    print(f"\n  Verdict:")
    if abs(pct_err) <= 5:
        print("    EXCELLENT — heuristic within 5% of ground truth.")
    elif abs(pct_err) <= 15:
        print("    GOOD — heuristic within 15%; defensible for production use.")
    else:
        print(f"    NEEDS WORK — {abs(pct_err):.1f}% off; consider tuning weights.")

    # ── CLI compression stats (if CLI present) ──────────────────────────────
    if os.path.exists(CLI):
        print(f"\n  Running CLI compression ({fmt})...")
        try:
            result = subprocess.run(
                [CLI, path, fmt], capture_output=True, text=True, timeout=30
            )
            for line in result.stdout.splitlines():
                if any(k in line for k in ["Token", "Byte", "Symbol", "Dictionary"]):
                    print(f"    {line.strip()}")
        except Exception as ex:
            print(f"    CLI error: {ex}")
    else:
        print(f"\n  (CLI not found at {CLI} — run 'make cli' first)")

    print()

if __name__ == "__main__":
    main()
