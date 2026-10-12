import { shape } from "../shape.ts";
import { o200k } from "../tokens.ts";

/** Fits one full GitHub search page: largest measured live was 3,896 tokens (rust-lang/rust, 30 issues). */
export const DEFAULT_BUDGET_TOKENS = 5_000;
export const MAX_BUDGET_TOKENS = 8_192;

export interface ReceiptRender {
  raw: string;
  fields: string[];
  label: string;
  counts: string[];
  /** Adapter receipt lines, printed above shape()'s notes. */
  receipt: string[];
  /** Tool to call again with a bigger budget_tokens. */
  tool: string;
  maxTokens: number;
}

/** What the model reads, plus the numbers telemetry needs. */
export interface Rendered {
  text: string;
  /** Records in this upstream page. */
  records: number;
  /** Records that fit the budget. */
  shown: number;
  /** Left-out field paths. */
  leftOut: number;
}

export const emptyRendered = (text: string): Rendered => ({ text, records: 0, shown: 0, leftOut: 0 });

/**
 * Receipt + shaped records within maxTokens. Rows cut for budget can't be reached by paging
 * (the next page starts after them), so the note gives the exact budget_tokens that shows them all.
 */
export function renderWithReceipt(o: ReceiptRender): Rendered {
  const opts = { fields: o.fields, label: o.label, counts: o.counts, ids: false as const };
  const full = shape(o.raw, opts);
  if (!full.stats) throw new Error(`${o.label} payload could not be shaped: ${full.passthrough ?? "unknown error"}`);
  const { records, leftOut } = full.stats;
  const fullText = [...o.receipt, full.text].join("\n");
  const fullTokens = o200k.count(fullText);
  if (fullTokens <= o.maxTokens) return { text: fullText, records, shown: records, leftOut: leftOut.length };

  const need = Math.ceil(fullTokens / 100) * 100;
  const more = need <= MAX_BUDGET_TOKENS
    ? `call ${o.tool} again with budget_tokens=${need} to see all ${records}`
    : `narrow the query to see them; all ${records} need over ${MAX_BUDGET_TOKENS} tokens`;
  let remaining = o.maxTokens - o200k.count(o.receipt.join("\n")) - 1;
  while (remaining >= 64) {
    const cut = shape(o.raw, { ...opts, maxTokens: remaining, more });
    const text = [...o.receipt, cut.text].join("\n");
    const overflow = o200k.count(text) - o.maxTokens;
    if (overflow <= 0) return { text, records, shown: cut.stats?.shown ?? 0, leftOut: leftOut.length };
    remaining -= overflow;
  }
  throw new Error("token budget is too small to render the ContextQuant receipt");
}
