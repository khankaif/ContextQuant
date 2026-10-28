# ContextQuant

**An MCP proxy that shrinks tool results for AI agents, says exactly what it cut, and gives the agent
a tool to get it back.**

Wrap any stdio MCP server. Large JSON results (search hits, issues, CRM records) come back with the
fields an agent can use, values shared by every record printed once, and a receipt for everything
else. Nothing is dropped silently, so the agent doesn't have to guess.

The reference GitHub MCP server, one `search_issues` call (18 open auth bugs in
`modelcontextprotocol/typescript-sdk`), no configuration:

```
raw server:      37,903 tokens
through cq:       5,556 tokens  (−85.3%, all 18 issues shown)
```

```
# contextquant: handle="r1" holds the full response · contextquant_more(handle, offset, fields) returns cut records or left-out fields
# search_issues: showing 18 of 18 · total_count=18 · incomplete_results=false · search_type="lexical"
# same in every record: user.type="User" · user.user_view_type="public" · user.site_admin=false · state="open" · locked=false · …
# empty (null) in every record: closed_at, type, active_lock_reason, state_reason, milestone.due_on, …
# a field missing from a row is empty (null) in that record
# left out fields: body, +66 URL/ID fields
{"html_url":"https://github.com/modelcontextprotocol/typescript-sdk/issues/2510","id":4908917026,"node_id":"I_kwDOM2nl2s8AAAABJJghIg","number":2510,"title":"Mid-session re-auth after refresh-token expiry dead-ends: …","user":{"login":"evdbogaard",…},"labels":[{"name":"bug",…},…],…}
…
```

## Quick start

Needs [Bun](https://bun.sh) 1.1+.

```bash
git clone https://github.com/khankaif/ContextQuant.git && cd ContextQuant && bun install

# Claude Code: wrap any MCP server by putting it after --
# (the token is needed for private repositories and write tools; public read-only search works without it)
claude mcp add --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_... github-cq \
  -- bun "$PWD/src/cli.ts" proxy -- npx -y @modelcontextprotocol/server-github
```

Any MCP client works the same way: the command is `bun /path/to/ContextQuant/src/cli.ts proxy -- <the server's own command>`.
Environment variables (API tokens) are passed through to the wrapped server. Each shaped call
logs its saving to stderr: `contextquant search_issues: 37903 → 5556 tokens (o200k)`.

## What the agent sees

| Line | Meaning | What the agent can do |
|---|---|---|
| `showing 18 of 18` | Records in this response, and how many are shown | — |
| `same in every record: …` | Fields with one value across all records, printed once | Read them; nothing is missing |
| `empty (null) in every record: …` | Fields that exist but hold no value anywhere | Treat as empty (e.g. nobody assigned), not as hidden |
| `left out fields: body, …` | Fields left out of the rows | `contextquant_more(handle, fields=["number","body"])` |
| `12 records not shown · call contextquant_more with handle="r1" and offset=18` | Records cut to fit the token budget, with the exact next offset | Call it as written |
| `count by labels.name: bug 20 · crash 10` | Value counts over all records (when configured) | Read the count instead of counting rows |

Fields are chosen from the data itself when a tool isn't configured: short values stay; long text
(over ~200 characters on average), API self-links, image URLs and ids nested inside sub-objects are
left out. Top-level ids and human-facing links stay, because agents pass them to the next call. The
rules can be aggressive because every cut is declared and one call away.

Results that aren't a JSON list of records (plain text, single objects, images, errors) pass through
unchanged, as do results that wouldn't get smaller and results whose tool declares an output schema
(their `structuredContent` must stay as the server sent it).

## Configure (optional)

```bash
bun src/cli.ts proxy --budget 8000 --config contextquant.json -- <server command>
```

```json
{
  "budget_tokens": 8000,
  "tools": {
    "search_issues": { "fields": ["number", "title", "state", "labels.name", "assignee.login"], "counts": ["labels.name", "assignee.login"] },
    "get_file_contents": { "skip": true }
  }
}
```

The default budget is 8,000 tokens per result (o200k), aiming under Claude Code's 10,000-token
warning; Claude's own tokenizer counts somewhat differently, so lower it if you see the warning.
Per-tool `fields` replaces the automatic choice, `counts` adds value counts, `skip` passes a tool through.

## Measured

All token counts use a real tokenizer (o200k), not a characters-per-token estimate.

**Token savings, live GitHub data**

| Setup | Payload | Raw | ContextQuant | Saved |
|---|---|---|---|---|
| Proxy, no config | reference GitHub MCP server, 18 issues | 37,903 | 5,556 | 85.3% |
| Proxy, no config | reference GitHub MCP server, 30 issues (`oven-sh/bun` crashes) | 66,234 | 6,477 | 90.2% |
| Proxy, no config | GitHub search, 30 issues (MCP SDK bugs) | 68,815 | 7,802 | 88.7% |
| Built-in gateway, tuned fields | 30-issue pages from vscode, rust, go, bun, nacos | 46k–91k | 2.8k–3.9k | 93.9–95.7% |

In the gateway runs a script compared every shown value (title, author, assignee, labels) and every
count against GitHub's raw response: zero mismatches across six repositories. Shaping a 69k-token
page takes about 120 ms, mostly token counting.

**Agent behaviour, live GitHub (Gemini 3.8 Flash via agy, one run each)**

"List the open auth bugs and who is assigned" (18 issues; exactly one is assigned):

| Tool output | Correct | Tool calls | Input tokens | Time |
|---|---|---|---|---|
| Raw JSON | yes | 3 | 84,271 | 71 s |
| Fields only, cuts not declared | yes | 10 | 52,226 | 115 s |
| ContextQuant | yes | 1 | 29,990 | 54 s |

With fields dropped silently, the agent didn't make anything up; it searched for what was missing,
including guessing assignee names in queries. Four more questions (a page-1 count that isn't the
total, the oldest bug beyond page 1, an empty result, a field only in an issue body) were all answered
correctly through ContextQuant. These are spot checks, not a benchmark: one model, one run per question.

**Accuracy, people-search eval** (synthetic data, 36 questions × 3 runs per arm, graded in code, `eval/`)

| | Tokens | Gemini 3.8 Flash | Gemma 4 26B | count questions (Flash) | made-up answers (Gemma) |
|---|---|---|---|---|---|
| minified JSON (full response) | 30,320 | 92% | doesn't fit (free tier: 16k tokens/min) | 61% | — |
| query fields only (API `fields`) | 5,394 | 97% | 94% | 83% | **6** |
| **cq json** | 5,693 | **100%** | **100%** | **100%** | **0** |

The 6 made-up answers are one trap: without the left-out note, Gemma answered "What is X's headline?"
with X's job title in every run; with the note it said the field wasn't shown. Caveats: synthetic data
and 36 questions (about ±18 points for small differences). Raw run results aren't committed;
`eval/run-all.sh` regenerates them under `.claude/hillclimb/` (needs model API keys in `.env`).

## When to skip it

- Results that are prose, code, or logs. ContextQuant works on JSON lists of records; tools like
  [headroom](https://github.com/headroomlabs-ai/headroom) and [rtk](https://github.com/rtk-ai/rtk) cover those.
- Small results. Under the budget and nothing to leave out, the original passes through.
- Agents that need every field of every record every time. Use `skip` for those tools.

## Compared to

| | What it reduces | How |
|---|---|---|
| **ContextQuant** | JSON tool results from any MCP server | Picks fields, prints shared values once, declares every cut, recovery tool |
| [headroom](https://github.com/headroomlabs-ai/headroom) | All agent context: JSON, code, logs, history | Content-aware compressors, originals retrievable |
| [rtk](https://github.com/rtk-ai/rtk) | Shell command output | Per-command filters |
| [TOON](https://github.com/toon-format/toon) | JSON in prompts | A more compact notation for the same data |
| [mcp-compressor](https://github.com/atlassian-labs/mcp-compressor) | MCP tool descriptions and schemas | Shows a small tool surface first |

These were not measured on the same payloads; numbers in each project's README use different data.

## Also in this repo

- **Built-in gateway** (`bun src/cli.ts gateway`): GitHub issues, Jira and HubSpot CRM tools with hand-tuned
  fields, counts and detail tools. GitHub needs no token for public repositories (`GITHUB_TOKEN` raises
  rate limits); Jira and HubSpot need credentials and have only been tested against fixtures.
- **Library**: `import { shape, shapeToolText } from "./src/index.ts"`, e.g.
  `shape(responseText, { fields: "auto", maxTokens: 4000 })`.
- **CLI**: `bun src/cli.ts shape <file> --fields a,b.c --max-tokens 1500`, `bun src/cli.ts bench`.

## Development

```bash
bun test                 # 77 tests, including stress tests and an end-to-end proxy test
bunx tsc --noEmit -p .
bun run bench            # token comparison on the people fixture (incl. TOON)
eval/run-all.sh          # accuracy eval; bun eval/summary.ts prints the tables
```

v1 was a C dictionary compressor ([`only-c` branch](https://github.com/khankaif/ContextQuant/tree/only-c)). Measured with real tokenizers it saved
nothing (−4.2% cl100k, +1.6% o200k): rare symbols cost more tokens than the words they replaced.
That result is why this version picks fields instead of compressing text.

## License

MIT
