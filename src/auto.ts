import type { Json } from "./shape.ts";

type Obj = { [k: string]: Json };

/** Longer average string than this is "long text" (issue bodies, descriptions): left out, recoverable. */
const LONG_TEXT = 200;

// Every non-empty leaf value per dotted path, in first-seen order. Arrays are walked through.
function leafValues(records: Obj[]): Map<string, Json[]> {
  const out = new Map<string, Json[]>();
  const walk = (v: Json, path: string[]) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, path));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, c]) => walk(c, [...path, k]));
    if (v === null || v === "") return;
    const key = path.join(".");
    (out.get(key) ?? out.set(key, []).get(key)!).push(v);
  };
  records.forEach((r) => walk(r, []));
  return out;
}

// Links for programs, not people: API self-links (api.github.com, /rest/api/…) and images.
function machineUrl(s: string): boolean {
  if (!/^https?:\/\//.test(s)) return false;
  try {
    const u = new URL(s);
    return /^api\.|\.api\.|avatar/.test(u.hostname) || /\/(api|rest)\//.test(u.pathname) || /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Pick fields from the data itself, for tools nobody configured: keep short values, leave out
 * long text, machine links and ids nested inside sub-objects. Top-level ids stay, since agents pass
 * them to the next call. Everything left out is declared by shape() and recoverable, so the rule
 * can afford to be aggressive.
 */
export function autoFields(records: Obj[]): string[] {
  const keep: string[] = [];
  for (const [path, values] of leafValues(records)) {
    const strings = values.filter((v): v is string => typeof v === "string");
    const avg = strings.length ? strings.reduce((a, s) => a + s.length, 0) / strings.length : 0;
    const nestedId = path.includes(".") && /(?:^|_)id$/i.test(path.slice(path.lastIndexOf(".") + 1));
    const links = strings.length > 0 && strings.filter(machineUrl).length * 2 > strings.length;
    if (avg <= LONG_TEXT && !nestedId && !links) keep.push(path);
  }
  return keep;
}

/**
 * Fields with the same value in every record (3+ records), e.g. state=open on an "is:open" search.
 * shape() prints them once instead of in every row.
 */
export function constantFields(records: Obj[], paths: string[]): Record<string, Json> {
  if (records.length < 3) return {};
  const perRecord = records.map((r) => leafValues([r]));
  const out: Record<string, Json> = {};
  for (const path of paths) {
    const keys = perRecord.map((m) => JSON.stringify(m.get(path) ?? []));
    if (keys[0] === "[]" || keys.some((k) => k !== keys[0])) continue;
    const vals = perRecord[0]!.get(path)!;
    out[path] = vals.length === 1 ? vals[0]! : vals;
  }
  return out;
}
