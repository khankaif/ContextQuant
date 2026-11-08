# Literature

Grouped by the question each paper helps answer. Most 2026 entries are preprints. I haven't found a
paper that tests declared vs. silent field omission in tool outputs directly, which is the core
claim here.

## Does telling the model what's missing help?

- **Sufficient Context** ([2411.06037](https://arxiv.org/abs/2411.06037)): strong models often
  answer instead of abstaining when context is insufficient. Adding a sufficiency signal improves
  correct-when-answering by 2–10%.
- **AbstentionBench** ([2506.09038](https://arxiv.org/abs/2506.09038)): reasoning fine-tuning makes
  abstention worse, by 24% on average.
- **The Reasoning Trap** ([2510.22977](https://arxiv.org/abs/2510.22977)): reasoning gains come with
  more tool hallucination.

Implication: silent truncation makes insufficient context look sufficient. Smarter models don't make
the declaration unnecessary and may make it matter more. My 6 → 0 Gemma result fits this, at small n.

## Does keeping cut data recoverable matter?

- **DTOC** ([2609.26121](https://arxiv.org/abs/2609.26121), preprint): compression without
  on-demand restore hurt performance; placeholder + restore cut cost per solved task 3–3.5× on two
  frontier models.
- **The Complexity Trap** ([2508.21433](https://arxiv.org/abs/2508.21433)): simple deterministic
  masking of old observations matched LLM summarization at about half the cost.
- **TRACER** ([2608.29363](https://arxiv.org/abs/2608.29363), preprint): names the
  "compression–consequence gap": cutting too much triggers costly re-fetches. Query-conditioned
  per-tool retention beat a fixed per-tool policy by 15–18%.

Implication: support for `contextquant_more` and for keeping LLMs out of the shaping step. I should
measure how often the agent calls `contextquant_more`, and per tool.

## Does length itself hurt?

- [2510.05381](https://arxiv.org/abs/2510.05381): accuracy fell 13.9–85% with longer inputs even with
  perfect retrieval.
- **Lost in the Middle** ([2307.03172](https://arxiv.org/abs/2307.03172)): information in the middle of the context is used least. Cut notes should go
  at the top of the result, which is where they are.
- **MCPGauge** ([2508.12566](https://arxiv.org/abs/2508.12566)): adding MCP tools lowered task
  performance 9.5% on average and inflated input tokens 3.25× to 236.5×.
- **MCP-Atlas** ([2602.00933](https://arxiv.org/abs/2602.00933)): 63.3% of failures were
  "cognitive", many after a tool call that had succeeded. Cleaner results should help here; nobody
  has measured it for result shaping.

None of these isolate "irrelevant JSON fields per record" as the distractor. The evidence is from
prose and needle-in-haystack setups.

## Formats

- No format wins across models. Differences are small for frontier models and can be large for
  weaker ones.
- **JTON** ([2604.05865](https://arxiv.org/abs/2604.05865)): factoring headers saves about 28.5% with
  neutral comprehension.
- [2402.12424](https://arxiv.org/abs/2402.12424): column-major JSON was the worst table format tested.
- **Notation Matters** ([2605.29676](https://arxiv.org/abs/2605.29676)): new notations like TOON
  break down in multi-turn agent loops.

Implication: stay close to formats models already know, one record per row, short legend.
Matches what I found in [findings.md](findings.md#2-flattening-to-csv-makes-things-bigger).

## Selection vs. token pruning

- Extractive selection beats token pruning and abstractive summaries at high compression
  ([2407.08892](https://arxiv.org/abs/2407.08892)).
- LLMLingua-style token dropping is built for prose. On JSON it can delete characters inside IDs and
  break syntax, and it isn't reversible. I found no paper testing it on JSON.
- LongLLMLingua ([2310.06839](https://arxiv.org/abs/2310.06839)) gains partly from being
  query-aware. ContextQuant already reads field names from filter arguments; it could use all tool
  arguments.

## Token savings ≠ cost savings

The most important caveat for this project.

- [2607.12161](https://arxiv.org/abs/2607.12161) (preprint): against plain Claude Code, the biggest
  compression setup cut tool-output tokens 38.4% and *raised* billed cost 6.8%. Token cut and cost
  cut correlated at r = 0.15, because cache reads and writes dominate input cost and compression
  added retrieval turns.
- [2609.22114](https://arxiv.org/abs/2609.22114) (preprint, production gateway): filtering tool
  schemas was the only clearly positive lever. Content compression saved ~2% of the cached prefix per
  turn, compounding past schema filtering after about six turns. Single-shot compression benchmarks
  "must not be cited as a cost-saving argument" for multi-turn agents.
- [2609.32961](https://arxiv.org/abs/2609.32961) (preprint, ~35,000 runs): policies using a third of
  the tokens sometimes took 20–80% longer, and policies with equal success rates solved different
  tasks.

Implication: "−85% tokens" is the wrong headline. The claims worth testing are fewer calls, fewer
made-up answers, staying under client limits, and cost per *successful* task with cache pricing.
ContextQuant rewrites a result once, when it arrives, so it shouldn't break cached prefixes, but
nobody has measured that setup.
