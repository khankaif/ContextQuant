# Findings

What I measured in this repo, in the order I learned it. Token counts use real tokenizers
(js-tiktoken, o200k unless noted), not a characters-per-token guess.

## 1. Dictionary compression saves nothing (v1, dead end)

v1 was a C program that replaced common JSON keys and values with rare Unicode symbols
(private-use characters), on the theory that one symbol = one token.

On a 4 MB fixture of payment charges:

| Tokenizer | Change |
|---|---|
| cl100k | −4.2% |
| o200k | +1.6% |

A private-use character costs 2–3 tokens, not 1. The heuristic I used to estimate savings was wrong,
and I only found out once I counted with a real tokenizer. Code is on the
[`only-c` branch](https://github.com/khankaif/ContextQuant/tree/only-c).

Lesson: BPE tokenizers already compress common English and JSON syntax well. Rewriting text to look
shorter doesn't help. Removing content does.

## 2. Flattening to CSV makes things bigger

Same fixture, flattened to CSV: **+47–48% tokens**. Adding short ID aliases on top: about +50%.
Nested JSON flattened into columns produces many sparse columns, and the header plus empty cells cost
more than the keys they replaced.

Tabular formats (CSV, TSV, TOON) also lose 10–15 points on filtering questions with small models, per
the literature (see [literature.md](literature.md#formats)). So the default output stays compact JSON,
one record per line.

## 3. Field selection is where the savings are

Picking fields and printing values shared by every record once gives the 85–90% in the README.

| Payload | Raw | Shaped | Saved |
|---|---|---|---|
| reference GitHub MCP server, 18 issues | 37,903 | 5,556 | 85.3% |
| reference GitHub MCP server, 30 issues | 66,234 | 6,477 | 90.2% |
| GitHub hosted MCP server, 30 issues | 70,393 | 7,749 | 89.0% |

No configuration in these runs. In separate runs through the built-in gateway (hand-tuned fields),
a script compared every shown value and count against GitHub's raw response: zero mismatches across
six repositories.

Factoring shared values on its own is worth about 30% in published work (JTON). Most of the rest comes
from dropping fields and rows, so that's the part where accuracy has to be checked.

### 3b. Five live searches, replayed byte for byte (2026-11-08)

`bench/compare/`: `capture.ts` saves 30-issue `search_issues` results from the reference GitHub MCP
server; `compare.ts` replays the same bytes through each arm and counts o200k tokens. "Facts kept" is
the share of issue numbers, title prefixes, assignee logins and `total_count` from the raw response
that appear in the arm's output.

| Search | Raw | ContextQuant (default, 8k budget) |
|---|---|---|
| modelcontextprotocol/typescript-sdk, open, "auth" | 60,158 · 100% | 7,968 · 100% |
| oven-sh/bun, open, "crash" | 67,516 · 100% | 6,995 · 100% |
| microsoft/vscode, open, label:bug | 82,843 · 100% | 7,795 · 88% |
| rust-lang/rust, open, label:C-bug | 97,609 · 100% | 7,904 · 65% |
| vercel/next.js, open | 65,237 · 100% | 7,221 · 100% |
| **Total** | **373,363** | **37,883 (−89.9%) · 90%** |

The facts that are missing all belong to whole records cut to fit the budget (vscode shows 26 of 30,
rust about 20 of 30), and each cut is declared with the offset to fetch the rest. Rust issues are wide
(long labels, template bodies), so fewer fit.

What fills the budget, looking at the output: `id` and `node_id` sit at the front of every row next to
`html_url` (which already has the number), and each label carries `color`, `default` and
`description`. Dropping those would fit more records. See [next.md](next.md).

### 3c. Against other tools, same five searches (2026-11-09)

`bun bench/compare/compare.ts --arms raw,cq,trunc,headroom`. Default settings for each tool.

| Tool | Tokens (5 searches) | Facts visible |
|---|---|---|
| raw | 373,363 | 100% |
| ContextQuant 0.3.1 | 37,883 (−90%) | 90%, the rest declared and recoverable |
| mcp-trunc-proxy 0.2.2 | 9,165 (−98%) | 3% |
| headroom-ai 0.43.1 `compress()` | 312,290 (−16%) | 99% |

- **mcp-trunc-proxy** stores anything over 80 KB and returns the first and last 60 lines of the
  pretty-printed JSON, which is about one issue. Everything else is behind its grep/range tool.
- **headroom** turned two searches into a compact table (MCP SDK 60k → 34k, vscode 83k → 48k) and
  left the other three unchanged. Its result lists only `router:protected:user_message` for those, and
  `protect_recent=0, target_ratio=0.2` (its most aggressive documented settings) changed nothing. The
  result object gives no reason (`diagnostics: None`).
- headroom compresses the messages sent to the model API, so in Claude Code it would only ever see a
  result *after* the client saved it to a file. That's why it has no agent arm below.

## 4. Declaring cuts changes agent behaviour

People-search eval: synthetic data, 36 questions × 3 runs per arm, graded in code. The harness was
removed in the November cleanup (its raw results were never committed); it is in git history before
the `cleanup` merge. Treat this section as an early signal; section 5 is the eval with committed results.

| Arm | Tokens | Gemini 3.8 Flash | Gemma 4 26B | Made-up answers (Gemma) |
|---|---|---|---|---|
| Full JSON | 30,320 | 92% | didn't fit rate limit | — |
| Query fields only, cuts not declared | 5,394 | 97% | 94% | 6 |
| ContextQuant | 5,693 | 100% | 100% | 0 |

All 6 made-up answers come from one trap question ("What is X's headline?"). Without the note saying
the headline was left out, Gemma answered with the job title every time. With the note, it said the
field wasn't shown.

GitHub spot check, one run, Gemini 3.8 Flash, "list the open auth bugs and who is assigned":

| Tool output | Correct | Tool calls | Input tokens |
|---|---|---|---|
| Raw JSON | yes | 3 | 84,271 |
| Fields dropped, cuts not declared | yes | 10 | 52,226 |
| ContextQuant | yes | 1 | 29,990 |

With silent cuts the agent didn't invent anything, but it went looking for what was missing,
including guessing assignee names in search queries.

**How much this shows.** Silent trimming makes agents guess or thrash, and declaring the cuts fixes
that. It does not yet show ContextQuant beats raw JSON on accuracy at scale: the fabrication result
is one question on synthetic data, the margin is about ±18 points, and the tool-call result is one
run of one model.

## 5. Agent eval on live GitHub data (2026-11-08)

`eval/github-agent.ts`. Two of the captured searches, replayed to the agent: MCP SDK "auth" (all 30
issues fit in the default budget) and rust `C-bug` (only 20 of 30 fit, so some answers need a recovery
call). Six questions per search, derived from the raw JSON and graded in code: unassigned count, total
matches, author of the last issue, issues with a given label, and whether two issue bodies mention a
word (one yes, one no). Bodies are left out by default, so those always need `contextquant_more`.
Three arms: raw, ContextQuant default (8k budget), ContextQuant `--budget 6000`. 3 runs each.

The agents get the MCP server and nothing else: no shell, no file reads. That's the setting of a chat
client or connector without code execution. Both clients save a large tool result to a file and
hand the model a path (Claude Code above 25k tokens, agy above ~27k characters), so on the raw arm the
model never sees the data unless it can run code on that file.

| Model (client) | Raw | ContextQuant | ContextQuant 6k | Made-up answers |
|---|---|---|---|---|
| Gemini 3.8 Flash low (agy) | 19/36 | 33/36 | 32/36 | 0 |
| Claude Haiku (Claude Code) | 0/36 | 36/36 | 36/36 | 0 |
| Claude Sonnet (Claude Code) | 0/36 | 36/36 | 36/36 | 0 |
| **All** | **19/108** | **105/108** | **104/108** | **0** |

- **Raw, Claude:** every run said it couldn't read the result ("returned about 310,000 characters…").
  No guesses. Correct behaviour, zero answers.
- **Raw, Flash:** agy also spills, but Flash read the file in chunks with agy's built-in file reader
  and answered the lookups (total count, author of a given issue: 12/12). For counting and filtering
  it tried to run `node` on the file, was denied, and ended with no answer (17 of 36).
- **ContextQuant misses (Flash only):** all 7 are the same pattern, trying a shell command instead of
  reading. Never a wrong value.
- **Recovery calls:** 0.7–1.8 per task on average. Models used `contextquant_more` as intended, e.g.
  `{"handle":"r1","offset":20,"fields":["number","user.login"]}` to find the author of a cut record.
- **Tokens:** ContextQuant tasks used *more* input tokens than raw (Sonnet 35.6k vs 8.5k), because raw
  runs stop at the first call with nothing to work on. Per *correct* answer, raw has no denominator.
  Claude Code's reported cost for the graded runs: $6.51 ($6.13 Sonnet, $0.38 Haiku).
- **6k vs 8k budget:** no real difference for Claude. Smaller pages mean slightly more recovery calls.

### 5b. With code execution, and against mcp-trunc-proxy (2026-11-09)

Same 12 questions, 3 runs. "Shell" arms give the agent `Read`, `Grep` and a Bash limited to
`jq grep head tail wc sort uniq cat` (Claude Code only; agy can't restrict commands that finely).

**Without a shell** (all three models, 108 runs per arm):

| Arm | Correct | Confidently wrong | Avg seconds (Haiku / Sonnet) | Cost (Haiku / Sonnet) |
|---|---|---|---|---|
| raw | 19/108 | 0 | 8 / 8 | $0.05 / $0.65 |
| **ContextQuant** | **105/108** | **0** | **8 / 9** | $0.16 / $2.79 |
| mcp-trunc-proxy | 93/108 | 6 | 25 / 18 | $0.23 / $2.13 |

**With a read-only shell** (Haiku + Sonnet, 72 runs per arm):

| Arm | Correct | Avg turns (Sonnet) | Avg seconds (Sonnet) | Cost (Haiku + Sonnet) |
|---|---|---|---|---|
| raw | 71/72 | 3.9 | 11 | **$1.22** |
| ContextQuant | 71/72 | **2.7** | **8** | $2.97 |
| mcp-trunc-proxy | 71/72 | 7.0 | 18 | $2.41 |

What this says:

- **With a shell, raw is as accurate and the cheapest.** Claude Code saves the big result to a file
  and the agent pulls out a few values with `jq`, so little reaches its context. ContextQuant puts
  ~8k tokens inline, which are re-read on every turn: 2.4× the cost on these tasks, for ~30% less time
  and fewer turns. So ContextQuant doesn't save money for agents that can run code. It's for agents
  that can't, and for speed.
- **Without a shell, ContextQuant is the only arm that is both right and never wrong.** mcp-trunc-proxy
  gets most answers through its grep tool but is 2–3× slower and gave 6 confident wrong answers, all
  the same pattern: grep returns matching JSON lines with no record boundary, and the model attached
  the line to the wrong issue (a label to #165520 instead of #165385; "macOS" to #3033). Declared,
  per-record output avoids that.
- **Misses with a shell:** ContextQuant's was arithmetic (Sonnet listed 18 + 7 unassigned, wrote 24);
  raw's missed one of two labelled issues; mcp-trunc-proxy's claimed "linux" in a body that has none.
- Per correct answer on Sonnet without a shell, mcp-trunc-proxy is cheaper ($0.063 vs $0.077): its
  preview is small. ContextQuant is faster and has no wrong answers.

Still: 2 searches, 12 questions, my own tasks, one replay each.

Harness lessons, each found from a wrong grade and fixed before the numbers above:
- `agy` loads globally configured MCP servers in every run; one model called the real GitHub server
  instead of the replay. The prompt now names the server, and calls to other servers are retried as
  harness errors.
- A "does it mention Linux?" question had `x86_64-unknown-linux-gnu` in the "no" body. Task words now
  appear exactly in the yes body and in no case at all in the no body.
- Graders read the last line: one model put a two-number answer on two lines; another wrote "I can't
  say yes or no", which matched "yes". Fixed and covered in `test/github-grade.test.ts`.
- Runs graded under a superseded task or grader are kept in `discarded-*.jsonl` next to the results.

### 5c. A smaller budget doesn't fix the shell cost (2026-11-09)

Haiku with the read-only shell, same 12 tasks. `cq-4k` and `cq-2k` run the proxy with `--budget 4000`
and `--budget 2000`. Cache tokens are averages per run.

| Arm | Correct | Cost per run | Turns | Cache write | Cache read |
|---|---|---|---|---|---|
| raw | 48/48 | **$0.0028** | 4.7 | 9.2k | 43k |
| ContextQuant (8k) | 48/48 | $0.0051 | 2.9 | 22.4k | 32k |
| ContextQuant 4k | 36/36 | $0.0045 | 4.3 | 17.5k | 55k |
| ContextQuant 2k | 35/36 | $0.0046 | 5.7 | 15.6k | 79k |

The cost driver is the cache write: whatever enters the context gets written to the prompt cache
once (more expensive than plain input), then read on every later turn. Raw stays cheap because the
result goes to a file and never enters the context. A smaller budget shrinks the write but makes the
agent call `contextquant_more` for the rows it cut, so turns and cache reads rise and the saving is
gone. Conclusion: with a shell, keeping data out of the context beats compressing it into the context.
Not pursued further.

## 6. Bugs that taught me something

- **Infinite recovery loop (found by the agent eval).** A single record larger than the whole budget
  (rust issue #165551: 31,479-character body) came back as "showing 0 of 30 (records 10–9)" with a
  hint to call again at the *same* offset. Agents called it up to 10 times and gave up. Now the record
  is shown with long text cut to fit, the cut is declared, and the offset moves on
  (`test/oversized-record.test.ts`).

- **Alias collisions.** Short ID aliases were first `#n`. Real data already contains `#123` (issue
  numbers, Slack channels), so the proxy rewrote arguments it shouldn't have. Switched to `@n`, scoped
  per session rather than per response so the same ID keeps the same alias (also keeps output stable
  for prompt caching).
- **Readable IDs got aliased.** SKUs and slugs like `blue-shirt-xl` looked "opaque". The check now
  rejects strings with readable word segments and needs several character-class changes.
- **Page count read as total.** The agent took "showing 30" as the total number of matches. Count lines
  now say "in this response" and print `total_count` separately when the server gives one.
- **Metadata ate the budget.** Big sibling arrays next to the record list used up the token budget.
  They're now shown as `[N items]`.
- **Silent nulls.** An early version dropped fields that were null everywhere without saying so. They're
  now listed under "empty (null) in every record", because "nobody is assigned" is an answer.
