import { AliasMap, isOpaqueId } from "./ids.ts";
import { o200k, type Tokenizer } from "./tokens.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export interface ShapeOptions {
  /** Dotted paths to keep in each record (arrays are walked through). Default: all. */
  fields?: string[];
  /** Hard cap on output tokens. Rows that don't fit are declared, never dropped silently. */
  maxTokens?: number;
  /** "json" = one compact JSON record per line (default). "tsv" = table; use only for models that pass the eval. */
  format?: "json" | "tsv";
  /** Session alias map for opaque IDs; false turns aliasing off. Default: a fresh map per call. */
  ids?: AliasMap | false;
  tokenizer?: Tokenizer;
  /** Name in the summary line. Default: the key holding the records. */
  label?: string;
  /** How the agent gets rows that were cut, e.g. `call again with cursor="…"`. */
  more?: string;
  /** Dotted paths to count values of, over every record (before any budget cut), so the model reads counts instead of counting. */
  counts?: string[];
}

export interface ShapeStats {
  records: number;
  shown: number;
  leftOut: string[];
  notInData: string[];
  aliased: number;
  inputBytes: number;
  outputBytes: number;
}

export interface ShapeResult {
  text: string;
  /** Set when the input came back unchanged, with the reason. */
  passthrough?: "not_json" | "no_records" | "no_gain";
  stats?: ShapeStats;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Shape a JSON tool result for an agent: keep the fields the task needs, drop empty
 * values, shorten opaque IDs, fit a token budget, and say in the output what was left out.
 * Fails open: anything it can't handle comes back unchanged.
 */
export function shape(input: string, opts: ShapeOptions = {}): ShapeResult {
  let root: Json;
  try {
    root = JSON.parse(input);
  } catch {
    return { text: input, passthrough: "not_json" };
  }
  const found = findRecords(root);
  if (!found) return { text: input, passthrough: "no_records" };

  const tok = opts.tokenizer ?? o200k;
  const fields = opts.fields?.length ? opts.fields : undefined;
  const cleaned = found.records.map((r) => (clean(r) ?? {}) as Obj);
  const picked = fields ? cleaned.map((r) => (pick(r, fields.map((f) => f.split("."))) ?? {}) as Obj) : cleaned;
  const { leftOut, notInData } = fields ? diffPaths(cleaned, fields) : { leftOut: [], notInData: [] };

  const ids = opts.ids === false ? undefined : (opts.ids ?? new AliasMap());
  let aliased = 0;
  const rows = ids
    ? picked.map((r) =>
        mapStrings(r, (s) => {
          const a = isOpaqueId(s) ? ids.tryAlias(s, tok) : undefined;
          if (a) aliased++;
          return a ?? s;
        }),
      )
    : picked;

  const { head, body } = opts.format === "tsv" ? tsv(rows as Obj[]) : { head: [], body: rows.map((r) => JSON.stringify(r)) };
  const total = body.length;
  const label = opts.label ?? found.key ?? "records";
  const meta = Object.entries(found.meta).map(([k, v]) => `${k}=${metaValue(v)}`);
  const countLines = (opts.counts ?? []).map((f) => countLine(cleaned, f, total)).filter((l) => l !== undefined);

  // Squeeze levels when the budget is tight: 0 everything, 1 left-out list shortened to a number,
  // 2 count lines dropped too (and said so). Rows always go first.
  const notes = (n: number, level: number): string[] => {
    const out = [`# ${label}: showing ${n} of ${total}${meta.length ? ` · ${meta.join(" · ")}` : ""}`];
    if (leftOut.length) out.push(`# left out fields: ${level >= 1 ? `${leftOut.length} (list too long for budget)` : nameFields(leftOut)}`);
    if (notInData.length) out.push(`# not in data (null or missing in every record): ${notInData.join(", ")}`);
    if (n < total) out.push(`# ${total - n} records not shown${opts.more ? ` · ${opts.more}` : ""}`);
    if (level < 2) out.push(...countLines);
    else if (countLines.length) out.push(`# ${countLines.length} count lines left out for budget`);
    if (aliased) out.push("# @1, @2… are short ids; pass them unchanged in tool calls");
    return out;
  };
  const render = (n: number, level = 0) =>
    [...notes(n, level), ...(n ? head : []), ...body.slice(0, n)].join("\n");

  let n = total;
  let text: string;
  if (opts.maxTokens === undefined) {
    text = render(n);
    if (!fields && text.length >= input.length) return { text: input, passthrough: "no_gain" };
  } else {
    const max = opts.maxTokens;
    // Count each row once, take the prefix that fits, then verify the real total
    // (BPE can merge across lines, so the sum is close but not exact).
    let used = tok.count([...notes(total, 0), ...head].join("\n"));
    n = 0;
    for (const line of body) {
      used += tok.count(line) + 1;
      if (used > max) break;
      n++;
    }
    while (n > 0 && tok.count(render(n)) > max) n--;
    text = render(n);
    for (let level = 1; level <= 2 && tok.count(text) > max; level++) text = render(n, level);
    // ponytail: last resort is one short line without meta; budgets under ~40 tokens still exceed it.
    if (tok.count(text) > max) {
      n = 0;
      text = `# ${label}: showing 0 of ${total}; budget too small${opts.more ? ` · ${opts.more}` : ", raise maxTokens"}`;
    }
  }

  return {
    text,
    stats: { records: total, shown: n, leftOut, notInData, aliased, inputBytes: input.length, outputBytes: text.length },
  };
}

/** Same envelope with records cut to `fields` and nothing else changed. For fair benchmarks. */
export function projectRecords(input: string, fields: string[]): Json {
  const root: Json = JSON.parse(input);
  const found = findRecords(root);
  if (!found) return root;
  const records = found.records.map((r) => pick(r, fields.map((f) => f.split("."))) ?? {});
  return found.key ? { ...found.meta, [found.key]: records } : records;
}

// The record list is the largest array whose items are all objects, at most 3 levels deep.
// Everything outside it (total_count, next_cursor…) becomes meta, keyed by dotted path; empty values are dropped.
function findRecords(root: Json): { records: Obj[]; key?: string; meta: Obj } | undefined {
  let best: { records: Obj[]; path: string[] } | undefined;
  const visit = (v: Json, path: string[]) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(isObj) && (!best || v.length > best.records.length)) best = { records: v as Obj[], path };
    } else if (isObj(v) && path.length < 3) {
      for (const [k, c] of Object.entries(v)) visit(c, [...path, k]);
    }
  };
  visit(root, []);
  if (!best) return undefined;

  const meta: Obj = {};
  let node: Json = root;
  for (let i = 0; i < best.path.length && isObj(node); i++) {
    const step = best.path[i]!;
    for (const [k, v] of Object.entries(node)) {
      const c = k === step ? undefined : clean(v);
      if (c !== undefined) meta[[...best.path.slice(0, i), k].join(".")] = c;
    }
    node = node[step]!;
  }
  return { records: best.records, key: best.path.at(-1), meta };
}

// Drop null, "", [] and {} recursively. Inside arrays an emptied item becomes null to keep positions.
function clean(v: Json): Json | undefined {
  if (v === null || v === "") return undefined;
  if (Array.isArray(v)) {
    const a = v.map((x) => clean(x) ?? null);
    return a.some((x) => x !== null) ? a : undefined;
  }
  if (isObj(v)) {
    const o: Obj = {};
    for (const [k, c] of Object.entries(v)) {
      const x = clean(c);
      if (x !== undefined) o[k] = x;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}

// Keep only `paths`. Arrays are transparent: `a.b` keeps `b` in every item of array `a`.
// Output keeps the input's key order, so it doesn't depend on the order fields were asked in.
function pick(v: Json, paths: string[][]): Json | undefined {
  if (paths.some((p) => p.length === 0)) return v;
  if (Array.isArray(v)) {
    const a = v.map((x) => pick(x, paths) ?? null);
    return a.some((x) => x !== null) ? a : undefined;
  }
  if (!isObj(v)) return undefined;
  const out: Obj = {};
  for (const [k, c] of Object.entries(v)) {
    const sub = paths.filter((p) => p[0] === k).map((p) => p.slice(1));
    if (!sub.length) continue;
    const x = pick(c, sub);
    if (x !== undefined) out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

// Which leaf paths in the data were dropped (collapsed to the highest fully-dropped
// parent), and which requested fields don't exist in the data at all.
function diffPaths(records: Obj[], fields: string[]): { leftOut: string[]; notInData: string[] } {
  type Node = { kids: Map<string, Node>; kept: boolean };
  const tree: Node = { kids: new Map(), kept: false };
  const leaves = new Set<string>();
  const covers = (f: string, leaf: string) => leaf === f || leaf.startsWith(`${f}.`);

  const walk = (v: Json, path: string[]) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, path));
    if (isObj(v) && Object.keys(v).length) return Object.entries(v).forEach(([k, c]) => walk(c, [...path, k]));
    const leaf = path.join(".");
    if (leaves.has(leaf)) return;
    leaves.add(leaf);
    const kept = fields.some((f) => covers(f, leaf));
    let node = tree;
    for (const k of path) {
      if (!node.kids.has(k)) node.kids.set(k, { kids: new Map(), kept: false });
      node = node.kids.get(k)!;
      node.kept ||= kept;
    }
  };
  records.forEach((r) => walk(r, []));

  const leftOut: string[] = [];
  const collapse = (node: Node, prefix: string) => {
    for (const [k, kid] of node.kids) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!kid.kept) leftOut.push(p);
      else collapse(kid, p);
    }
  };
  collapse(tree, "");
  const notInData = fields.filter((f) => ![...leaves].some((l) => covers(f, l)));
  return { leftOut, notInData };
}

// Name the left-out fields an agent could ask about; only count API links and internal ids
// (url, html_url, node_id…), which on GitHub are half the list and never answer a question.
function nameFields(paths: string[]): string {
  const noise = (p: string) => /(?:^|_)(?:url|id)$/i.test(p.slice(p.lastIndexOf(".") + 1));
  const named = paths.filter((p) => !noise(p));
  const n = paths.length - named.length;
  return [...named, ...(n ? [`+${n} URL/ID fields`] : [])].join(", ");
}

// "# count by <path> (all N records in this response): value k · …", most common first.
// "in this response" because N is one page, not the API's total_count.
// ponytail: top 20 values only; high-cardinality fields (names, ids) aren't worth counting anyway.
function countLine(records: Obj[], path: string, total: number): string | undefined {
  const tally = new Map<string, number>();
  const leaves = (v: Json | undefined, p: string[], out: Set<string>): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => leaves(x, p, out));
    else if (p.length === 0) { if (v !== undefined && v !== null && typeof v !== "object") out.add(String(v)); }
    else if (isObj(v)) leaves(v[p[0]!], p.slice(1), out);
    return out;
  };
  // Each record counts once per distinct value.
  for (const r of records) for (const v of leaves(r, path.split("."), new Set())) tally.set(v, (tally.get(v) ?? 0) + 1);
  if (!tally.size) return undefined;
  const top = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = top.slice(0, 20).map(([v, k]) => `${v} ${k}`);
  if (top.length > 20) shown.push(`+${top.length - 20} more values`);
  return `# count by ${path} (all ${total} records in this response): ${shown.join(" · ")}`;
}

// Sibling values (total_count, next_cursor…) go in the summary line as JSON. A big one (a second
// list, facets) would eat the budget meant for records, so it's only named with its size.
// ponytail: 120-char cutoff; shape the sibling too if agents need what's in it.
function metaValue(v: Json): string {
  const j = JSON.stringify(v);
  if (j.length <= 120 || !v || typeof v !== "object") return j;
  return Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).length} keys}`;
}

function mapStrings(v: Json, fn: (s: string) => string): Json {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, mapStrings(c, fn)]));
  return v;
}

// Nested objects flatten to dotted columns; arrays stay as one JSON cell.
// Cells escape only \, tab, newline and CR, so there are no quoting rules to learn.
// A line starting with # gets a \ in front so it can't pass for a note line.
function tsv(rows: Obj[]): { head: string[]; body: string[] } {
  const flat = rows.map((r) => {
    const out: Record<string, Json> = {};
    const walk = (v: Json, p: string) => {
      if (isObj(v)) for (const [k, c] of Object.entries(v)) walk(c, p ? `${p}.${k}` : k);
      else out[p] = v;
    };
    walk(r, "");
    return out;
  });
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const cell = (v: Json | undefined) =>
    v === undefined || v === null
      ? ""
      : (typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/[\\\t\n\r]/g, (c) => ESC[c]!);
  const line = (cells: string[]) => cells.join("\t").replace(/^#/, "\\#");
  return { head: [line(cols.map((c) => cell(c)))], body: flat.map((r) => line(cols.map((c) => cell(r[c])))) };
}
const ESC: Record<string, string> = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" };
