# Landscape

Star counts checked with `gh api` on 2026-10-30. Savings figures are each project's own claims,
measured on different data, so they aren't comparable to each other or to mine.

## Result compressors

| Tool | What it does | Declares what was cut? |
|---|---|---|
| [headroom](https://github.com/headroomlabs-ai/headroom) (~78k stars) | Library, proxy and MCP server for all agent context. JSON-specific compressor, originals retrievable via `headroom_retrieve` (default expiry 1,800 s), Teams/Enterprise tier | A count and a hash ("1000 items compressed to 20"). Docs don't say which fields were cut |
| [rtk](https://github.com/rtk-ai/rtk) (~85k stars) | Shell command output, moving to "everything your agent reads". Now Apache/BUSL | — |
| [mcp_trunc_proxy](https://github.com/marco-jardim/mcp_trunc_proxy) | Stores large results, returns a preview and a retrieval tool. Claims 90–98% | Preview only |
| [mcp-compression-proxy](https://github.com/kdpa-llc/mcp-compression-proxy) | Results over 10k characters saved to disk | — |
| sqz, llmtrim, mcp-rtk, clov, mcpack | Small proxies with static presets or opaque handles, under ~35 stars | — |
| MuleSoft MCP Payload Optimization ([doc](https://docs.mulesoft.com/gateway/latest/policies-included-mcp-payload-optimization)) | Enterprise gateway policy: cleanup, optional LLM call per response, TOON | No, and no recovery |

Measured on the same data (2026-11-09, [findings.md §3c, §5b](findings.md)): mcp-trunc-proxy is the
closest in design and works with agents, but its grep tool loses record boundaries (6 wrong answers in
108); headroom left 3 of 5 GitHub searches uncompressed. Headroom is the closest in reach. The concrete difference is field-level declarations ("left out: body,
+66 URL/ID fields"), and headroom could add that in a release.

## Other ways around the problem

- **Source-side jq filters.** Stainless adds a model-written `jq_filter` parameter to generated MCP
  servers ([changelog](https://www.stainless.com/changelog/mcp-servers-now-support-response-data-filtering-using-jq/)).
  Free projection, but the model has to know the schema, and the first call comes back unshaped.
- **Code mode.** The model writes code that calls tools, so data never enters context. Anthropic cut
  one workflow from 150,000 to 2,000 tokens
  ([post](https://www.anthropic.com/engineering/code-execution-with-mcp)). An independent GPT-4.1 test
  found input tokens down 77% but output tokens up ~120%
  ([aimultiple](https://research.aimultiple.com/code-execution-with-mcp)). Good when the model never
  has to read the records (ETL). Bad for triage, where it does. Needs a sandbox most clients don't
  have.
- **Clearing old results.** Anthropic context editing (84% fewer tokens in a 100-turn eval,
  [blog](https://claude.com/blog/context-management)) and OpenAI's `ToolOutputTrimmer` act on old
  results after they've already been paid for once, keep a preview, no recovery.
- **Schema compression.** [mcp-compressor](https://github.com/atlassian-labs/mcp-compressor) and tool
  search shrink tool *descriptions*. Different problem; stacks with this.

All of these work alongside ContextQuant, and they all make "we save tokens" a weak claim on its own.

## What nobody seems to do yet

1. Field-level declaration of every cut, deterministic, no LLM in the path.
2. Zero-config field choice derived from the data, for any MCP server.
3. A published accuracy eval on real MCP tasks comparing raw, silent trim, headroom, TOON, jq and
   code mode.
4. Per-tool policies learned from which cut fields the agent asks for back.
5. Per-tool token-spend reporting at the MCP layer, for any client.

(1) and (2) exist here. (3) is the most useful thing to build next. See [next.md](next.md).
