# Next

## The experiment that matters

Everything in [findings.md](findings.md) is small-n. Before adding features, run a proper eval:

- **Unit:** a task, not a payload.
- **Arms:** raw JSON, silent field trim, ContextQuant, headroom, `jq_filter`, (later) TOON and code mode.
- **Tasks:** public MCP benchmarks (MCP-Universe, MCP-Bench, MCPMark, MCP-Atlas) plus trap questions
  that ask about cut fields. GitHub, Jira and a Splunk-shaped fixture.
- **Models:** at least three, including one Claude and one small model. Repeated runs. Report per
  model, never pooled.
- **Metrics:** success rate, made-up answers, tool calls, `contextquant_more` calls, wall time, and
  cost per successful task *with prompt-cache pricing*.

**Stop condition:** if declared cuts don't beat silent trimming on made-up answers or extra calls,
with confidence intervals and without raising cache-priced cost, this is a library feature (a
FastMCP middleware or a headroom contribution), not a standalone tool. That result would still be
worth publishing.

### Status (2026-11-09)

Done: no-shell and shell arms, raw / ContextQuant / mcp-trunc-proxy, token comparison incl. headroom
([findings.md §3c, §5, §5b](findings.md)). The headline that survived: **for agents without code
execution, ContextQuant is the only arm that is both right and never confidently wrong; with code
execution, raw + jq is as accurate and cheaper, ContextQuant is faster.** Not done yet:

- **Cut ContextQuant's cost when the agent has a shell.** The ~8k-token inline result is re-read every
  turn. Options to test: a smaller default budget when the client can run code, or putting only the
  receipt inline and the rows behind the handle. Measure with `--arms raw-shell,cq-shell`.
- **Public benchmark questions** (MCP-Bench / MCP-Atlas) instead of my own 12.
- **More models** via agy (Sonnet 4.6, GPT-OSS 120B) once its quota resets; the eval resumes.
- **Cost for agy runs.** Claude Code reports `total_cost_usd`; agy doesn't.

## Open questions

- Does shaping on arrival keep prompt caches stable across a long session? It should, since output
  is byte-identical for identical input, but it's unmeasured.
- How often does the agent call `contextquant_more`, and for which fields? If it's often for one
  field on one tool, that field should be kept by default.
- Does putting the receipt at the top vs. the bottom of the result change anything?
- Do strong models benefit less than weak ones? The literature predicts the opposite for made-up
  answers.

## Design changes I'd make

- **Split the core.** `shape(result, context) → { view, manifest, handle }`. The manifest is typed
  JSON listing every cut; a renderer turns it into the lines the model reads. Testable on its own, and
  could be written up as a format spec.
- **Completeness guard.** Copy `truncated` / `total` / cursor fields from `structuredContent` into the
  receipt; flag `totalCount == maxResults` with no cursor as "completeness unknown". Covers the
  Splunk and Jira cases in [problem.md](problem.md).
- **Store behind `put` / `get`.** Originals live in an in-process `Map` capped at 50, so they die with
  the proxy. Hooks run as one short process per call, so they'd need SQLite. Stored originals can
  contain personal data, so local first.
- **Claude Code hook adapter.** PostToolUse `updatedToolOutput` can replace any tool's output and
  sees the tool arguments, so users wouldn't need to rewire their MCP config. A hook can't register
  `contextquant_more`, so it needs a tiny companion server that reads the same store.
- **Query-aware fields.** Keep any field named in the tool arguments, not only filter fields.
- **Page through one long field.** An oversized record is now shown cut to fit, but the rest of that
  field can't be fetched. A `chars_from` argument on `contextquant_more` would allow it.
- **Cheaper rows.** Leave out `node_id` (GraphQL id, rarely passed on) and label `color` / `default` /
  `description` by default, then re-run `bench/compare` to see how many more records fit.
- **Budget per client.** The 8k default is tuned for Claude Code's 25k cap. agy (Antigravity) saves any
  result over ~27k characters to a file, and 8k tokens of JSON is 23–28k characters, so some results
  spill there. Either measure characters as well as tokens, or ship per-client presets.
- **Rules that stay fixed:** never shape error results, never alter `structuredContent` bytes, same
  input → same output.

Not doing: an LLM in the shaping path (latency, injection surface, and masking already matches
summarization), hosted mode (holds credentials and personal data), tool-description compression
(mcp-compressor does it).
