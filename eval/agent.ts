// Multi-turn eval: an agent answers questions by calling a simulated person_search API.
// It can filter, page with a cursor and ask for extra fields, so a left-out field is a
// call away, not a dead end. Same tool, same schema in every variant; only the tool
// result's rendering changes:
//   raw    full API JSON page
//   fields only base + filter + requested fields, as JSON (what an API `fields` param gives)
//   cq     ContextQuant: same fields, plus notes on what was left out, counts, how to page
//
//   bun eval/agent.ts run --model ollama:gpt-oss:20b [--variants raw,fields,cq] [--reps 3] [--tasks a,b] [--concurrency 1]
//   bun eval/agent.ts summary
//   bun eval/agent.ts tasks          print the tasks and expected answers
//
// Backends: ollama:<name> (local), gemini:<model> (GEMINI_API_KEY), openrouter:<id> (OPENROUTER_API_KEY).
// Results: .claude/agent-eval/<model>/results.jsonl, one trace per run next to it.
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { peopleSearch, PEOPLE_BASE, PEOPLE_RENAME } from "../bench/people.ts";
import { fieldsFromFilters, filterFields } from "../src/intent.ts";
import { projectRecords, shape, type Json } from "../src/shape.ts";
import { o200k } from "../src/tokens.ts";

export const DB = { n: 400, seed: 7, page: 25 };
export const VARIANTS = ["raw", "fields", "cq"] as const;
export type Variant = (typeof VARIANTS)[number];
const MAX_TURNS = 8;
const OUT = ".claude/agent-eval";

type Person = {
  crustdata_person_id: number;
  basic_profile: { name: string; headline: string; current_title: string; location: { raw: string; city: string; country: string } };
  experience: { employment_details: { current: { name: string; title: string }[]; past: { name: string }[] } };
  education: { schools: { school: string }[] };
};
export const people = (peopleSearch(DB.n, DB.seed) as { profiles: Person[] }).profiles;

// --- the simulated API -------------------------------------------------------

type Filter = { op?: string; conditions?: Filter[]; field?: string; type?: string; value?: Json };

// Every leaf value at a dotted path, walking through arrays.
function leaves(v: Json | undefined, path: string[]): Json[] {
  if (Array.isArray(v)) return v.flatMap((x) => leaves(x, path));
  if (!path.length) return v === undefined || v === null ? [] : [v];
  return v && typeof v === "object" ? leaves((v as Record<string, Json>)[path[0]!], path.slice(1)) : [];
}

function matches(p: Json, f: Filter): boolean {
  if (f.op !== undefined) {
    if (!Array.isArray(f.conditions)) throw new Error("filter with op needs a conditions list");
    if (f.op === "and") return f.conditions.every((c) => matches(p, c));
    if (f.op === "or") return f.conditions.some((c) => matches(p, c));
    throw new Error(`unknown op: ${f.op}`);
  }
  if (typeof f.field !== "string") throw new Error("condition needs a string field");
  const vals = leaves(p, (PEOPLE_RENAME[f.field] ?? f.field).split(".")).map((x) => String(x).toLowerCase());
  const want = (x: Json) => String(x).toLowerCase();
  switch (f.type) {
    case "(.)": return vals.some((x) => x.includes(want(f.value!)));
    case "=": return vals.includes(want(f.value!));
    case "!=": return !vals.includes(want(f.value!));
    case "in": return Array.isArray(f.value) && f.value.some((w) => vals.includes(want(w)));
    default: throw new Error(`unknown condition type: ${f.type}`);
  }
}

export interface SearchArgs { filters?: Filter; cursor?: string; fields?: string[] }

/** The API response for one page, shaped like Crustdata's person search. */
export function search(args: SearchArgs): Json {
  if (!args.filters || typeof args.filters !== "object") throw new Error("filters is required");
  const hits = people.filter((p) => matches(p as unknown as Json, args.filters!));
  let offset = 0;
  if (args.cursor) {
    try { offset = Number(atob(args.cursor).slice(4)); } catch { offset = NaN; }
    if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid cursor: pass next_cursor from a previous response, or omit it for the first page");
  }
  const page = hits.slice(offset, offset + DB.page);
  const next = offset + DB.page < hits.length ? btoa(`page${offset + DB.page}`) : null;
  return { profiles: page as unknown as Json, next_cursor: next, total_count: hits.length };
}

/** The tool result text the agent sees, per variant. */
export function toolResult(variant: Variant, args: SearchArgs): string {
  let res: Json;
  try {
    res = search(args);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
  const raw = JSON.stringify(res);
  if (variant === "raw") return raw;
  const extra = Array.isArray(args.fields) ? args.fields.filter((f) => typeof f === "string") : [];
  const fields = [...new Set([...fieldsFromFilters(args.filters, PEOPLE_BASE, PEOPLE_RENAME), ...extra.map((f) => PEOPLE_RENAME[f] ?? f)])];
  if (variant === "fields") return JSON.stringify(projectRecords(raw, fields));
  return shape(raw, {
    fields,
    counts: filterFields(args.filters, PEOPLE_RENAME),
    more: "call again with the same filters and cursor=next_cursor",
  }).text;
}

export const TOOL = {
  name: "person_search",
  description:
    "Search the people database. Returns up to 25 profiles per page, plus total_count (all matches) and next_cursor. " +
    "Profiles cover basic profile (name, headline, current title, location), social handles, current and past employment, and education.",
  parameters: {
    type: "object",
    properties: {
      filters: {
        type: "object",
        description:
          'Filter tree: {"op":"and"|"or","conditions":[...]} where each condition is a nested filter or {"field","type","value"}. ' +
          'type: "(.)" contains (case-insensitive), "=" equals, "!=" not equal, "in" (value is a list). ' +
          "Filterable fields: basic_profile.name, experience.employment_details.current.title, " +
          'experience.employment_details.current.name (company), basic_profile.location.full_location ("City, State, Country").',
      },
      cursor: { type: "string", description: "next_cursor from the previous response, to get the next page." },
      fields: { type: "array", items: { type: "string" }, description: "Extra dotted response field paths to include in each profile." },
    },
    required: ["filters"],
  },
};

const SYSTEM =
  "You answer questions about people using the person_search tool. Call it as many times as you need: " +
  "results are paginated, and you can ask for more fields. When you are done, reply with only the final answer: " +
  "one value, or a comma-separated list. If the database can't answer the question, reply exactly NOT_FOUND.";

// --- tasks: expected answers computed from the database, never hand-written ------

export interface Task { id: string; kind: "text" | "set" | "ids" | "number"; prompt: string; expected: string | number | string[] | number[]; universe?: string[] }

export function buildTasks(): Task[] {
  const tasks: Task[] = [];
  const nameCount = new Map<string, number>();
  for (const p of people) nameCount.set(p.basic_profile.name, (nameCount.get(p.basic_profile.name) ?? 0) + 1);
  const uniq = people.filter((p) => nameCount.get(p.basic_profile.name) === 1);
  const who = (p: Person) => `${p.basic_profile.name} (${p.basic_profile.current_title} at ${p.experience.employment_details.current[0]!.name})`;
  const company = (p: Person) => p.experience.employment_details.current[0]!.name;
  const companies = [...new Set(people.map(company))].sort();
  const schools = [...new Set(people.flatMap((p) => p.education.schools.map((s) => s.school)))].sort();

  uniq.slice(0, 2).forEach((p, k) =>
    tasks.push({ id: `headline-${k + 1}`, kind: "text", prompt: `What is the profile headline of ${who(p)}? Reply with it exactly as written.`, expected: p.basic_profile.headline }),
  );
  uniq.slice(2, 4).forEach((p, k) =>
    tasks.push({ id: `schools-${k + 1}`, kind: "set", prompt: `Which schools did ${who(p)} attend? Comma-separated.`, expected: [...new Set(p.education.schools.map((s) => s.school))], universe: schools }),
  );
  uniq.slice(4, 5).forEach((p, k) =>
    tasks.push({ id: `past-${k + 1}`, kind: "set", prompt: `Which companies did ${who(p)} work at before their current job? Comma-separated.`, expected: [...new Set(p.experience.employment_details.past.map((r) => r.name))], universe: companies }),
  );

  // Totals: one filtered search's total_count answers it, whatever the page size.
  [["Head of", "London"], ["Co-Founder", "San Francisco"]].forEach(([title, city], k) =>
    tasks.push({
      id: `total-${k + 1}`, kind: "number",
      prompt: `How many people in the database have a current title containing '${title}' and are located in ${city}?`,
      expected: people.filter((p) => p.basic_profile.current_title.includes(title!) && p.basic_profile.location.city === city).length,
    }),
  );

  // Lists that span two pages: the agent must follow next_cursor.
  const byCompanyCountry = new Map<string, Person[]>();
  for (const p of people) {
    const key = `${company(p)}|${p.basic_profile.location.country}`;
    byCompanyCountry.set(key, [...(byCompanyCountry.get(key) ?? []), p]);
  }
  [...byCompanyCountry].filter(([, ps]) => ps.length > DB.page && ps.length <= 2 * DB.page).sort().slice(0, 2).forEach(([key, ps], k) => {
    const [co, country] = key.split("|");
    tasks.push({ id: `list-${k + 1}`, kind: "ids", prompt: `List the crustdata_person_id of every person currently working at ${co} who is located in ${country}.`, expected: ps.map((p) => p.crustdata_person_id).sort((a, b) => a - b) });
  });

  // Aggregate over every match: page counts alone aren't enough when results span pages.
  const top = companies.map((co) => {
    const tally = new Map<string, number>();
    for (const p of people.filter((q) => company(q) === co)) tally.set(p.basic_profile.location.city, (tally.get(p.basic_profile.location.city) ?? 0) + 1);
    const sorted = [...tally].sort((a, b) => b[1] - a[1]);
    return { co, n: people.filter((q) => company(q) === co).length, city: sorted[0]![0], clear: sorted[0]![1] > (sorted[1]?.[1] ?? 0) };
  }).find((x) => x.clear && x.n > DB.page);
  if (top) tasks.push({ id: "topcity-1", kind: "text", prompt: `Among people currently working at ${top.co}, which city has the most of them? Reply with the city name.`, expected: top.city });

  return tasks;
}

// --- grading: code, not a model ------------------------------------------------

const norm = (s: string) => s.trim().replace(/^["'`*]+|["'`*.]+$/g, "").replace(/\s+/g, " ").toLowerCase();

export function grade(t: Task, answer: string): boolean {
  const a = norm(answer);
  switch (t.kind) {
    case "text": return a.includes(norm(String(t.expected))) && a.length <= String(t.expected).length * 2 + 10;
    case "number": return Number((answer.replace(/(\d),(\d{3})\b/g, "$1$2").match(/\d+/) ?? [])[0]) === t.expected;
    case "ids": {
      const got = [...new Set((answer.match(/\d{7,}/g) ?? []).map(Number))].sort((x, y) => x - y);
      return JSON.stringify(got) === JSON.stringify(t.expected);
    }
    case "set": {
      // Every expected value named, and no other value from the same universe.
      const want = (t.expected as string[]).map(norm);
      const named = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(a);
      return want.every(named) && t.universe!.map(norm).every((u) => want.includes(u) || !named(u));
    }
  }
}

// --- model backends ------------------------------------------------------------

type Msg = Record<string, unknown>;
type Call = { id?: string; name: string; args: unknown };
type Turn = { message: Msg; content: string; calls: Call[]; inTok: number; outTok: number; clipped: boolean };

const OLLAMA_CTX = 32768;

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    if (res.ok) return res.json();
    const text = await res.text(); // body only: request headers (keys) never reach errors
    if (attempt < 6 && (res.status === 429 || res.status >= 500)) {
      // Per-minute quotas say how long to wait ("retryDelay": "37s"); otherwise back off.
      const hint = Number(text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1]);
      await Bun.sleep(hint ? hint * 1000 + 1000 : 2 ** attempt * 2000 * (0.5 + Math.random()));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

function key(name: string): string {
  const k = process.env[name];
  if (!k) throw new Error(`${name} is not set (.env)`);
  return k;
}

async function chat(model: string, messages: Msg[]): Promise<Turn> {
  const [backend, ...rest] = model.split(":");
  const name = rest.join(":");
  if (backend === "ollama") {
    const j = await post("http://localhost:11434/api/chat", {
      model: name, messages, stream: false, tools: [{ type: "function", function: TOOL }], options: { num_ctx: OLLAMA_CTX },
    });
    const m = j.message ?? {};
    return {
      message: m, content: m.content ?? "",
      calls: (m.tool_calls ?? []).map((c: any) => ({ name: c.function?.name, args: c.function?.arguments })),
      inTok: j.prompt_eval_count ?? 0, outTok: j.eval_count ?? 0,
      // Ollama silently drops the start of a prompt longer than num_ctx.
      clipped: (j.prompt_eval_count ?? 0) >= OLLAMA_CTX - 1,
    };
  }
  const url =
    backend === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    : backend === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions"
    : undefined;
  if (!url) throw new Error(`unknown backend: ${backend}`);
  const auth = { authorization: `Bearer ${key(backend === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY")}` };
  const j = await post(url, { model: name, messages, tools: [{ type: "function", function: TOOL }] }, auth);
  const m = j.choices?.[0]?.message ?? {};
  return {
    message: m, content: m.content ?? "",
    calls: (m.tool_calls ?? []).map((c: any) => {
      let args: unknown;
      try { args = JSON.parse(c.function?.arguments ?? "{}"); } catch { args = undefined; }
      return { id: c.id, name: c.function?.name, args };
    }),
    inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0, clipped: false,
  };
}

// --- one run ---------------------------------------------------------------------

export interface Row {
  task: string; variant: Variant; rep: number; model: string;
  status: "ok" | "error"; error?: string;
  answer?: string; correct?: boolean; calls: number; turns: number; hit_max_turns: boolean; clipped: boolean;
  input_tokens: number; output_tokens: number; tool_result_tokens: number; seconds: number;
}

// agy can't take a tool definition, so person_search reaches it as an MCP server
// (eval/mcp-server.ts) configured in a fresh workspace per run. The server logs each
// call, which gives calls and tool-result tokens. agy's input_tokens include its own
// harness prompt (~19k) and any globally configured MCP tools, the same in every variant.
// Never --dangerously-skip-permissions: only mcp(people/person_search) may be allowed.
// No --sandbox: it keeps the MCP server from starting. Headless mode still denies shell commands.
// agy's harness offers shell tools; in headless mode a denied one ends the turn with no answer.
const AGY_NOTE = "person_search is your only tool: shell commands and files are not available, so count and combine results yourself.";

async function runAgy(model: string, t: Task, variant: Variant, row: Row): Promise<unknown> {
  // Outside any git repo: agy takes the repo root as the project and would miss this .agents/.
  const ws = mkdtempSync(`${tmpdir()}/cq-agy-`);
  mkdirSync(`${ws}/.agents`, { recursive: true });
  const calls = `${ws}/calls.jsonl`;
  writeFileSync(calls, "");
  writeFileSync(`${ws}/.agents/mcp_config.json`, JSON.stringify({
    mcpServers: { people: { command: process.execPath, args: [`${import.meta.dir}/mcp-server.ts`], env: { CQ_VARIANT: variant, CQ_LOG: calls } } },
  }));
  const p = Bun.spawn(
    ["agy", "-p", `${SYSTEM} ${AGY_NOTE}\n\nQuestion: ${t.prompt}`, "--model", model.slice("agy:".length), "--output-format", "json",
      "--print-timeout", "600s", "--disable-slash-commands"],
    { cwd: ws, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  await p.exited;
  let j: any;
  try { j = JSON.parse(out); } catch { throw new Error(`agy exit ${p.exitCode}: ${(err || out).replace(/\s+/g, " ").slice(0, 300)}`); }
  for (const c of readFileSync(calls, "utf8").split("\n").filter(Boolean)) {
    row.calls++;
    row.tool_result_tokens += (JSON.parse(c) as { tokens: number }).tokens;
  }
  row.turns = j.num_turns ?? 0;
  row.input_tokens = j.usage?.input_tokens ?? 0;
  row.output_tokens = (j.usage?.output_tokens ?? 0) + (j.usage?.thinking_tokens ?? 0);
  if ((j.denied_actions ?? []).some((d: { action?: string }) => d.action === "mcp"))
    throw new Error("agy denied the MCP call: add mcp(people/person_search) to permissions.allow in ~/.gemini/antigravity-cli/settings.json");
  // A denied shell command ends the turn early: a harness failure, retried, never graded as wrong.
  if (!String(j.response ?? "").trim() && (j.denied_actions ?? []).some((d: { action?: string }) => d.action === "command"))
    throw new Error("agy ended the turn on a denied shell command");
  if (j.status !== "SUCCESS") throw new Error(`agy status ${j.status}: ${String(err).replace(/\s+/g, " ").slice(0, 200)}`);
  row.answer = String(j.response ?? "").trim();
  const trace = { agy: j, calls: readFileSync(calls, "utf8") };
  rmSync(ws, { recursive: true, force: true });
  return trace;
}

async function runOne(model: string, t: Task, variant: Variant, rep: number, traceFile: string): Promise<Row> {
  const messages: Msg[] = [{ role: "system", content: SYSTEM }, { role: "user", content: t.prompt }];
  const row: Row = { task: t.id, variant, rep, model, status: "ok", calls: 0, turns: 0, hit_max_turns: false, clipped: false, input_tokens: 0, output_tokens: 0, tool_result_tokens: 0, seconds: 0 };
  const t0 = performance.now();
  let agyTrace: unknown;
  try {
    if (model.startsWith("agy:")) agyTrace = await runAgy(model, t, variant, row);
    else for (;;) {
      if (row.turns === MAX_TURNS) { row.hit_max_turns = true; break; }
      const turn = await chat(model, messages);
      row.turns++;
      row.input_tokens += turn.inTok;
      row.output_tokens += turn.outTok;
      row.clipped ||= turn.clipped;
      messages.push(turn.message);
      if (!turn.calls.length) { row.answer = turn.content.trim(); break; }
      for (const c of turn.calls) {
        row.calls++;
        const text = c.name === TOOL.name && c.args && typeof c.args === "object"
          ? toolResult(variant, c.args as SearchArgs)
          : JSON.stringify({ error: `bad call: ${c.name} with unparseable arguments` });
        row.tool_result_tokens += o200k.count(text);
        messages.push(c.id ? { role: "tool", tool_call_id: c.id, content: text } : { role: "tool", tool_name: c.name, content: text });
      }
    }
    row.correct = row.answer !== undefined && grade(t, row.answer);
  } catch (e) {
    row.status = "error";
    row.error = (e as Error).message.slice(0, 300);
  }
  row.seconds = Math.round((performance.now() - t0) / 100) / 10;
  writeFileSync(traceFile, JSON.stringify({ row, task: t, ...(agyTrace ? { agyTrace } : { messages }) }, null, 2));
  return row;
}

// --- CLI ---------------------------------------------------------------------------

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

async function run(o: Record<string, string | undefined>) {
  const model = o.model ?? "";
  if (!model) throw new Error("--model is required");
  const variants = (o.variants ?? VARIANTS.join(",")).split(",") as Variant[];
  for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`unknown variant: ${v}`);
  const reps = Number(o.reps ?? 3);
  const pick = o.tasks?.split(",");
  const tasks = buildTasks().filter((t) => !pick || pick.includes(t.id));
  const dir = `${OUT}/${safe(model)}`;
  mkdirSync(`${dir}/traces`, { recursive: true });
  const results = `${dir}/results.jsonl`;

  // Resume: finished (task, variant, rep) rows are skipped; errors are retried.
  const done = new Set(
    existsSync(results)
      ? readFileSync(results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.status === "ok").map((r) => `${r.task}|${r.variant}|${r.rep}`)
      : [],
  );
  const queue = variants.flatMap((v) => tasks.flatMap((t) => Array.from({ length: reps }, (_, rep) => ({ t, v, rep })))).filter((j) => !done.has(`${j.t.id}|${j.v}|${j.rep}`));
  console.error(`${model}: ${queue.length} runs to do (${done.size} already done)`);

  // Stop after 3 errors in a row (usually a used-up daily quota); re-running resumes.
  let i = 0, streak = 0;
  const worker = async () => {
    while (i < queue.length && streak < 3) {
      const { t, v, rep } = queue[i++]!;
      const row = await runOne(model, t, v, rep, `${dir}/traces/${t.id}_${v}_rep${rep}.json`);
      appendFileSync(results, JSON.stringify(row) + "\n");
      streak = row.status === "error" ? streak + 1 : 0;
      const mark = row.status === "error" ? `ERROR ${row.error}` : row.correct ? "ok" : `wrong: ${JSON.stringify(row.answer?.slice(0, 80))}`;
      console.error(`${t.id} ${v} rep${rep}: ${mark} · ${row.calls} calls · ${row.input_tokens} in-tokens · ${row.seconds}s`);
    }
  };
  await Promise.all(Array.from({ length: Number(o.concurrency ?? 1) }, worker));
  if (streak >= 3) console.error("stopped after 3 errors in a row; re-run the same command to resume");
}

function summary() {
  if (!existsSync(OUT)) return console.log("no results yet");
  for (const m of readdirSync(OUT)) {
    const file = `${OUT}/${m}/results.jsonl`;
    if (!existsSync(file)) continue;
    // Latest row per (task, variant, rep), so a retried error doesn't count twice.
    const latest = new Map<string, Row>();
    for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l) as Row;
      latest.set(`${r.task}|${r.variant}|${r.rep}`, r);
    }
    const rows = [...latest.values()];
    const tasks = [...new Set(rows.map((r) => r.task))];
    console.log(`\n## ${m}\n`);
    console.log(`| variant | correct | errors | avg calls | avg input tokens | avg tool-result tokens | hit max turns | clipped | ${tasks.join(" | ")} |`);
    console.log(`|---|---|---|---|---|---|---|---|${tasks.map(() => "---").join("|")}|`);
    for (const v of VARIANTS) {
      const vr = rows.filter((r) => r.variant === v);
      if (!vr.length) continue;
      const ok = vr.filter((r) => r.status === "ok");
      const avg = (f: (r: Row) => number) => (ok.length ? Math.round(ok.reduce((s, r) => s + f(r), 0) / ok.length) : 0);
      const perTask = tasks.map((t) => {
        const tr = ok.filter((r) => r.task === t);
        return tr.length ? `${tr.filter((r) => r.correct).length}/${tr.length}` : "–";
      });
      console.log(
        `| ${v} | ${ok.filter((r) => r.correct).length}/${ok.length} | ${vr.length - ok.length} | ${(ok.reduce((s, r) => s + r.calls, 0) / (ok.length || 1)).toFixed(1)} | ` +
          `${avg((r) => r.input_tokens)} | ${avg((r) => r.tool_result_tokens)} | ${ok.filter((r) => r.hit_max_turns).length} | ${ok.filter((r) => r.clipped).length} | ${perTask.join(" | ")} |`,
      );
    }
  }
}

if (import.meta.main) {
  const { values: o, positionals: [cmd] } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true,
    options: { model: { type: "string" }, variants: { type: "string" }, reps: { type: "string" }, tasks: { type: "string" }, concurrency: { type: "string" } },
  });
  if (cmd === "run") await run(o);
  else if (cmd === "summary") summary();
  else if (cmd === "tasks") for (const t of buildTasks()) console.log(`${t.id} [${t.kind}] ${t.prompt}\n  expected: ${JSON.stringify(t.expected)}`);
  else console.error("usage: bun eval/agent.ts run --model <backend:model> [--variants raw,fields,cq] [--reps 3] [--tasks ids] [--concurrency 1] | summary | tasks");
}
