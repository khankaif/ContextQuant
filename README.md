# ContextQuant

**Infrastructure-grade symbolic compression for the LLM era.**

ContextQuant is a high-performance C library designed to solve "Context Bloat"—the primary driver of LLM latency and cost. By using symbolic substitution to compress structured data like JSON, logs, and code, it allows AI agents to ingest significantly larger datasets while staying within context window limits and reducing API expenditures by up to 70%.

## The Problem: Context Rot & Token Tax
Every byte of structural boilerplate—like repeating JSON keys, log timestamps, or HTML tags—costs money and consumes valuable context space. 
1.  **High Cost**: Large payloads (Stripe API responses, server logs) often consist of 40–60% repetitive syntax.
2.  **Context Rot**: As conversations grow and "compact," models lose track of past data, leading to hallucinations or performance collapse.
3.  **Latency**: Larger prompts take longer for the LLM to process.

## Technical Core
ContextQuant is built as a zero-dependency C core for maximum portability and speed.
* **FNV-1a Hash Table**: Utilizes an O(1) hash table with linear probing for blistering fast pattern detection.
* **24MB String Pool**: Managed memory pool for tracking repeating N-grams across datasets up to 500MB+.
* **Stateless Architecture**: The core compressor is fully stateless and thread-safe.
* **Embedded SHA-256**: Features a self-contained, minimal SHA-256 implementation for deterministic data fingerprinting.

## Key Features

### 1. Multi-Format Mastery
Specialized extractors and rewriters optimize tokenization based on the data type:
* **JSON**: Replaces quoted keys and enum values.
* **LOG**: Tokenizes by whitespace and delimiters to crush repeating prefixes and levels.
* **CSV**: Optimized for tabular data and column-value repetitions.
* **CODE**: Identifies and compresses long identifiers and string literals.

### 2. Persistent SQLite Cache
A sophisticated cache layer powered by SQLite (WAL mode) stores dictionary blocks keyed by input hash. 
* **Sub-millisecond Recovery**: If the same data is encountered twice, the engine retrieves the dictionary and re-compresses the payload in ~1ms, bypassing the N-gram scan entirely.
* **Meaning Preservation**: Re-injects dictionaries into LLM prompts after context compaction without needing the original source file.

### 3. Intent-Aware Filtering
Balance lossless compression with "smart" lossy summarization using the `cq_intent_t` API:
* **`keep_keys`**: Prioritize specific fields (e.g., `status`, `currency`) for symbol assignment to ensure they are always compressed.
* **`drop_keys`**: Physically strip irrelevant metadata (e.g., `audit_logs`, `internal_id`) from the payload to minimize token count.

### 4. Session Continuity
The Session Layer links multiple compression results to a single conversation ID.
* **Compaction Recovery**: Automatically builds consolidated `[CQ-SESSION]` blocks for re-injection after an LLM context window rolls over.

## Benchmarks
Results from 100MB stress tests on standard hardware:

| Format | Avg. Reduction | Throughput | Fidelity |
| :--- | :--- | :--- | :--- |
| **LOG** | ~70% | 145 MB/s | Lossless |
| **JSON** | ~43% | 147 MB/s | Lossless |
| **CODE** | ~23% | 150 MB/s | Lossless |
| **CSV** | ~16% | 155 MB/s | Lossless |

## Build & Usage

### Compilation
Build the CLI tool and synthetic data generators:
```bash
make all
```

### Compressing Data
```bash
./contextquant_cli payload.json json
```

### Generating Test Data
Generate a 64MB deterministic Stripe-style JSON payload:
```bash
./synthetic_json_gen payload.json 64mb charges 42
```

## Project Status
ContextQuant is currently in **v1.0.0-alpha**. Upcoming milestones include:
1.  **Wasm Bridge**: Compiling the C core and SQLite to WebAssembly for browser-based demos.
2.  **TypeScript SDK**: Providing high-level wrappers for Node.js and AI Agent platforms.
3.  **Safety Interceptor**: Deterministic validation of LLM outputs to prevent symbol hallucination.
