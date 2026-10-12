# ContextQuant

**Shape search results for AI agents: only the fields the query needs, a hard token budget, and a
clear note of what was left out.**

```
# profiles: showing 3 of 25 · next_cursor="9KvKW9…" · total_count=12400
# left out fields: basic_profile.headline, basic_profile.profile_picture_permalink, education, …
# count by basic_profile.location.raw (all 25 records in this response): London, England, United Kingdom 6 · Toronto, Ontario, Canada 5 · …
# 22 records not shown · call again with cursor=next_cursor
{"crustdata_person_id":5571966,"basic_profile":{"name":"Ananya Okafor","current_title":"Head of Data",…}}
…
```

## Why

Agents read API responses built for programs. Most of each record is irrelevant to the question,
it costs tokens, and long irrelevant context lowers accuracy. When responses get cut to fit, the
agent usually isn't told. ContextQuant keeps what the query asked about and says what it removed.

## Measured

Person-search page modelled on Crustdata's `POST /person/search` docs, 25 profiles, o200k tokens
(`bun run bench`):

| | Tokens | vs minified JSON |
|---|---|---|
| pretty JSON | 21,033 | +33.4% |
| minified JSON | 15,768 | — |
| TOON | 15,063 | −4.5% |
| cq, fields from the query | 2,885 | **−81.7%** |
| cq, fields from the query, TSV | 1,933 | −87.7% |

Almost all the saving is field selection, which an API's own `fields` parameter can also do if the
agent sets it right. What ContextQuant adds shows up in accuracy. 50 profiles, eval round 2:

| | Tokens | Gemini 3.8 Flash | Gemma 4 26B | count questions (Flash) | made-up answers (Gemma) |
|---|---|---|---|---|---|
| minified JSON (full response) | 30,320 | 92% | doesn't fit (free tier: 16k tokens/min) | 61% | — |
| query fields only (API `fields`) | 5,394 | 97% | 94% | 83% | **6** |
| **cq json** | 5,693 | **100%** | **100%** | **100%** | **0** |
| cq tsv | 3,753 | 100% | 100% | 100% | 0 |

36 questions × 3 runs per arm, answers graded in code (`eval/`). Questions: lookups, URL copies,
counts, filters, total count, a field that was left out, and "partial" traps where related fields are
shown (headline missing but title shown). The 6 made-up answers are all one trap: without the
left-out note, Gemma answered "What is X's headline?" with X's title, in all 3 runs on both
headline questions; with the note it answered NOT_SHOWN. Counts are 100% because cq writes value
counts for the query's filter fields. Caveats: synthetic data, 36 questions (about ±18 points per
arm for small differences), the count questions use the same fields the counts come from.

## Use

```bash
bun install
bun test
bun run bench

bun src/cli.ts gen people --n 25 > bench/out/people.json
bun src/cli.ts shape bench/out/people.json \
  --people-query '{"filters":{"field":"basic_profile.location.full_location","type":"(.)","value":"San Francisco"}}' \
  --max-tokens 1500 --more 'call again with cursor=next_cursor'
```

```ts
import { shape, fieldsFromFilters, PEOPLE_BASE, PEOPLE_RENAME, AliasMap } from "./src/index.ts";

const ids = new AliasMap(); // one per agent session
const fields = fieldsFromFilters(request.filters, PEOPLE_BASE, PEOPLE_RENAME);
const { text, stats } = shape(responseText, { fields, maxTokens: 4000, ids, more: "call again with cursor=next_cursor" });
const args = ids.rewriteArgs(toolCallArgs); // #n back to real IDs
```

## MCP gateway prototype

The gateway (`src/gateway/server.ts`) exposes six tools over stdio: a search tool and a detail
tool each for GitHub issues, Jira, and HubSpot CRM. GitHub needs no token for public repositories;
set `GITHUB_TOKEN` for higher rate limits or private repositories. Jira and HubSpot need their own
credentials and have only been tested against fixtures.

```bash
GITHUB_TOKEN=... bun run mcp
```

Each search result starts with a receipt: what was left out, counts over the whole page, the next
page, and, when rows were cut for the token budget, the exact `budget_tokens` that shows them all.
The detail tool returns only the fields the agent asks for. Session handles are in memory only; see
the [production HLD](docs/HLD.md).

## Docs

- Eval: `eval/` (cases, grader, runner); `eval/run-all.sh` runs it, `bun eval/summary.ts` prints results
- [One pager](docs/ONE_PAGER.md) · [HLD](docs/HLD.md) · [LLD](docs/LLD.md)
- [Research: strongest business use case](docs/research/Context%20shaping%20business%20use%20case.md) · [arXiv review notes](docs/research/notes)
- v1 (C, symbolic dictionary compression) lives in [`.legacy/c/`](.legacy/c). Measured with real
  tokenizers it saved nothing (−4.2% cl100k, +1.6% o200k), which is why v2 exists.
