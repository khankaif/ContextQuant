# ContextQuant

**Symbolic compression for LLM context windows.**

When you feed structured data to an LLM — API responses, logs, database exports — most of the tokens are structural boilerplate: repeated keys, punctuation, prefixes, enum values. ContextQuant strips that boilerplate using a dictionary-based symbolic substitution, then hands the LLM a compact payload + a small dictionary it can use to decode on demand.

The goal is not smaller files. The goal is more signal per token inside a context window.

---

## Why this exists

LLMs are billed per token, not per byte. A 4 MB Stripe API response contains ~1.1M tokens — but fewer than 30% of those are actual business data. The rest is structural syntax (`"`, `:`, `{`, `}`, repeated key names, repeated enum values) that the model still has to read and attend to.

ContextQuant targets exactly that waste.

```
Input:  {"status":"succeeded","currency":"usd","amount":1000} × 5720 records
Output: {㠀:㠁,㠂:㠃,㠄:1000} × 5720 + [CQ-DICT] 㠀="status" 㠁="succeeded" ...
```

The model receives the compressed payload and the dictionary in a single prompt block. Expansion is deterministic and lossless.

---

## How it works

**1. N-gram scan** — walks the input once with an FNV-1a hash table, tracking frequency of every candidate string. Candidates are scored by net token savings:

```
score = (tokens_saved_per_use × frequency) − dict_line_cost
```

Only candidates with `score > 0` become symbols. The tokenizer is pluggable; the default is a character-class weighted heuristic calibrated against cl100k_base.

**2. Symbol assignment** — top-N candidates get assigned symbols from one of three schemes:

| Scheme | Symbol | Token cost | Best for |
|---|---|---|---|
| `pua_unicode` (default) | `㠀`…`㿿` | 1 token | Maximum token ROI |
| `tilde_alpha` | `~A`…`~z` | 2 tokens | ASCII-safe pipelines |
| `caret_decimal` | `^0`…`^255` | 2–3 tokens | Legacy/debug |

**3. Format-aware rewrite** — a format-specific pass (JSON, CSV, LOG, CODE) replaces each matched string with its symbol. Quoted fields are handled correctly; round-trip fidelity is tested.

**4. Dictionary block** — a compact `[CQ-DICT]` header maps every symbol back to its original string, designed to be re-injected into the prompt after context compaction.

---

## Benchmarks

Measured on a 4 MB synthetic Stripe-style JSON corpus (5720 charge records). Token counts via heuristic tokenizer calibrated against tiktoken cl100k_base.

| Format | Token reduction | Byte reduction | Throughput |
|---|---|---|---|
| JSON | ~14% | ~19% | ~53 MB/s |

> **Note on token metrics:** Token reduction is estimated via a character-class weighted heuristic. The heuristic has been validated against tiktoken (cl100k_base) — see `scripts/validate_heuristic.py` for the comparison tooling. Exact integration via the pluggable tokenizer interface is on the roadmap.

---

## Build

```bash
make all        # CLI + test binaries + data generators
make test       # run all 4 test suites
make wasm       # Emscripten build (requires emcc in PATH)
```

---

## Usage

```bash
# Compress a file
./contextquant_cli payload.json json

# Select symbol scheme
./contextquant_cli payload.json json --tilde     # ASCII-safe
./contextquant_cli payload.json json --caret     # legacy format

# Generate test corpus
./synthetic_json_gen payload.json 4mb charges 42

# Validate heuristic tokenizer against tiktoken
pip install tiktoken
python scripts/validate_heuristic.py payload.json json
```

---

## Architecture

```
cq_tokenizer   — pluggable token-count interface (heuristic or exact via FFI)
cq_ngram       — frequency scan + token-aware candidate scoring
cq_dict        — symbol assignment + multi-scheme emission
cq_compress    — format-aware rewrite (JSON / CSV / LOG / CODE) + expand
cq_cache       — SQLite-backed result cache (WAL mode, keyed by SHA-256)
cq_session     — multi-turn session tracking for context compaction recovery
```

The core (`cq_ngram`, `cq_dict`, `cq_compress`, `cq_tokenizer`) has no external dependencies and compiles to WebAssembly. The cache and session layers require SQLite and are excluded from Wasm builds via `CQ_NO_SQLITE`.

---

## Roadmap

- [ ] Exact tokenizer integration (tiktoken via Python FFI or native port)
- [ ] TypeScript/Node.js SDK wrapping the Wasm build
- [ ] Streaming mode for payloads that arrive incrementally
- [ ] Symbol hallucination guard — validate that LLM output contains no bare symbols

---

## Status

`v1.0.0-alpha` — core compression, expand, cache, and session are production-ready. Token metrics are heuristic until exact tokenizer integration lands.
