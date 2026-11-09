// Agent eval on captured live GitHub search results (bench/compare/capture.ts).
// An agent (agy or Claude Code) answers questions about one search page; the only thing that changes between
// arms is what sits between the agent and the replayed GitHub server:
//   raw   the reference server's JSON, untouched
//   cq    ContextQuant proxy, default settings (8,000-token budget, tuned for Claude Code)
//   cq-6k ContextQuant with --budget 6000, small enough that agy keeps it inline (agy saves
//         results over ~27k characters to a file; the default budget gives 23-28k)
//   trunc mcp-trunc-proxy (a competitor: stores big results, returns a preview + retrieval tool)
// By default the agent gets the MCP server only (no shell, no files). A "-shell" suffix (raw-shell,
// cq-shell, trunc-shell; Claude backend only) also gives it Read, Grep and a Bash limited to
// read-only text tools (jq, grep, head, tail, wc, sort, uniq, cat), so it can work on a result
// the client saved to a file.
// Questions and answers are derived from the raw payload in code and graded in code.
//
//   bun eval/github-agent.ts tasks
//   bun eval/github-agent.ts run --model gemini-3.8-flash-low [--reps 3] [--arms raw,cq,cq-6k] [--concurrency 3]
//   bun eval/github-agent.ts summary
// Results: eval/results/github/<model>/results.jsonl (finished runs are skipped on re-run).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { QUERIES } from "../bench/compare/queries.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const REPLAY = `${ROOT}bench/compare/replay-server.ts`;
const OUT = `${ROOT}eval/results/github`;
const PAYLOADS = ["mcp-sdk-auth-bugs", "rust-bugs"];
// cq-<n>k runs ContextQuant with --budget <n>000.
const ARMS = ["raw", "cq", "cq-6k", "cq-4k", "cq-2k", "trunc", "raw-shell", "cq-shell", "cq-4k-shell", "cq-2k-shell", "trunc-shell"] as const;
const TRUNC_VERSION = "0.2.2";
const SHELL_TOOLS =["jq", "grep", "head", "tail", "wc", "sort", "uniq", "cat"].map((c) => `Bash(${c}:*)`);
type Arm = (typeof ARMS)[number];

type Issue = { number: number; user: { login: string }; assignees?: { login: string }[]; labels: { name: string }[]; body: string | null };
type Kind = "number" | "login" | "set" | "yesno";
type Task = { id: string; payload: string; q: string; kind: Kind; prompt: string; expect: string | number | number[] };

export function tasks(): Task[] {
  return PAYLOADS.flatMap((payload) => {
    const q = QUERIES.find((x) => x.name === payload)!.q;
    const j = JSON.parse(readFileSync(`${ROOT}bench/compare/payloads/${payload}.txt`, "utf8")) as { total_count: number; items: Issue[] };
    const items = j.items;
    const last = items.at(-1)!;
    const counts = new Map<string, number>();
    for (const i of items) for (const l of i.labels) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
    const label = [...counts].filter(([, n]) => n >= 2 && n <= 6).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]![0];
    // A word with no debatable cases: the "yes" body has it exactly as written, the "no" body has it in
    // no case at all ("linux" inside a target triple would make "mentions Linux?" arguable either way).
    // "no" uses the longest such body, so it takes reading.
    const exact = (i: Issue, w: string) => !!i.body?.includes(w);
    const anyCase = (i: Issue, w: string) => !!i.body?.toLowerCase().includes(w.toLowerCase());
    const word = ["Windows", "macOS", "Linux", "regression", "panicked", "OAuth"].find((w) =>
      items.some((i) => exact(i, w)) && items.some((i) => i.body && !anyCase(i, w)))!;
    const yes = items.find((i) => exact(i, word))!;
    const no = items.filter((i) => i.body && !anyCase(i, word)).sort((a, b) => b.body!.length - a.body!.length)[0]!;
    const t = (id: string, kind: Kind, prompt: string, expect: Task["expect"]): Task => ({ id: `${payload}/${id}`, payload, q, kind, prompt, expect });
    return [
      t("unassigned", "number", "How many of the issues in the results have no assignee? Reply with a number.", items.filter((i) => !i.assignees?.length).length),
      t("total", "number", "How many issues match this search in total, across all pages? Reply with a number.", j.total_count),
      t("last-author", "login", `Who opened issue #${last.number}? Reply with the GitHub login.`, last.user.login),
      t("label", "set", `Which issues in the results have the label "${label}"? Reply with their numbers, comma-separated, or NONE.`,
        items.filter((i) => i.labels.some((l) => l.name === label)).map((i) => i.number).sort((a, b) => a - b)),
      t("body-yes", "yesno", `Does the description (body) of issue #${yes.number} mention "${word}"? Reply yes or no.`, "yes"),
      t("body-no", "yesno", `Does the description (body) of issue #${no.number} mention "${word}"? Reply yes or no.`, "no"),
    ];
  });
}

const lastParagraph = (s: string) =>
  s.replace(/[*`]/g, "").trim().split(/\n\s*\n/).at(-1)!.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

export function grade(t: Task, answer: string): boolean {
  // Models often explain first and put the answer last: grade the last paragraph for lists
  // (some put one number per line), the last line of it for everything else.
  const para = lastParagraph(answer);
  const a = t.kind === "set" ? para : para.split("\n").at(-1) ?? "";
  const ints = (s: string) => (s.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+/g) ?? []).map(Number);
  switch (t.kind) {
    case "number": return ints(a)[0] === t.expect;
    case "login": return a.toLowerCase().includes(String(t.expect).toLowerCase());
    // The line must start with the verdict: "...so I can't say yes or no" is not a yes.
    case "yesno": return a.toLowerCase().match(/^\W*(yes|no)\b/)?.[1] === t.expect;
    case "set": {
      const want = t.expect as number[];
      const got = [...new Set(ints(a))].sort((x, y) => x - y);
      return want.length === 0 ? /none/i.test(a) && got.length === 0 : JSON.stringify(got) === JSON.stringify(want);
    }
  }
}

const prompt = (t: Task, shell: boolean) => `You have an MCP server named "github". Use only that server; ignore any other MCP servers. ${shell
  ? "You also have Read, Grep, and Bash limited to jq, grep, head, tail, wc, sort, uniq and cat; use them on tool results, including results saved to a file. Other commands are not available."
  : "Its tools are your only tools: shell commands and files are not available, so read and count results yourself."}
Call search_issues once with q="${t.q}" and per_page=30. The question is about the issues that call returns (one page of up to 30).
If something you need is not in a result, use a tool to get it or say it is not shown; do not guess.

Question: ${t.prompt}
Put the answer alone on the last line.`;

type Row = {
  task: string; arm: Arm; rep: number; model: string; status: "ok" | "error"; correct?: boolean; answer?: string; error?: string;
  search_calls: number; more_calls: number; input_tokens: number; output_tokens: number; seconds: number; cost_usd?: number;
  turns?: number; cache_write?: number; cache_read?: number;
};

// Claude Code in print mode with only the eval server. Without shell: no built-in tools at all (the
// same "no code execution" condition as agy). With shell: Read, Grep and the read-only Bash list.
// User settings, hooks and plugins are skipped.
async function runClaude(model: string, t: Task, ws: string, server: object, row: Row, shell: boolean): Promise<string> {
  writeFileSync(`${ws}/mcp.json`, JSON.stringify({ mcpServers: { github: server } }));
  const p = Bun.spawn(["claude", "-p", prompt(t, shell), "--model", model.slice("claude:".length), "--output-format", "json",
    "--setting-sources", "", "--strict-mcp-config", "--mcp-config", `${ws}/mcp.json`, "--tools", shell ? "Read,Grep,Bash" : "",
    "--allowedTools", ["mcp__github", ...(shell ? ["Read", "Grep", ...SHELL_TOOLS] : [])].join(","), "--no-session-persistence"],
    { cwd: ws, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  await p.exited;
  let j: any;
  try { j = JSON.parse(out); } catch { throw new Error(`claude exit ${p.exitCode}: ${(err || out).replace(/\s+/g, " ").slice(0, 300)}`); }
  const u = j.usage ?? {};
  row.input_tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  row.output_tokens = u.output_tokens ?? 0;
  row.cost_usd = j.total_cost_usd;
  row.turns = j.num_turns;
  // Billed differently: cache writes cost more than plain input, cache reads a tenth of it.
  [row.cache_write, row.cache_read] = [u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0];
  if (j.is_error) throw new Error(`claude error: ${String(j.result ?? err).replace(/\s+/g, " ").slice(0, 300)}`);
  return String(j.result ?? "").trim();
}

async function runAgy(model: string, t: Task, ws: string, server: object, row: Row, shell: boolean): Promise<string> {
  if (shell) throw new Error("shell arms need the Claude backend (agy can't limit shell to read-only commands)");
  mkdirSync(`${ws}/.agents`);
  writeFileSync(`${ws}/.agents/mcp_config.json`, JSON.stringify({ mcpServers: { github: server } }));
  const tools = ["search_issues", "contextquant_more", "proxy_artifact_get", "proxy_artifact_info", "proxy_artifact_list"];
  const settings = JSON.stringify({ permissions: { allow: tools.map((x) => `mcp(github/${x})`) } });
  const p = Bun.spawn(["agy", "-p", prompt(t, false), "--model", model, "--output-format", "json", "--print-timeout", "600s",
    "--disable-slash-commands", "--settings", settings], { cwd: ws, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  await p.exited;
  let j: any;
  try { j = JSON.parse(out); } catch { throw new Error(`agy exit ${p.exitCode}: ${(err || out).replace(/\s+/g, " ").slice(0, 300)}`); }
  row.input_tokens = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_tokens ?? 0);
  row.output_tokens = (j.usage?.output_tokens ?? 0) + (j.usage?.thinking_tokens ?? 0);
  const denied = (j.denied_actions ?? []).map((d: { action?: string }) => d.action);
  if (!String(j.response ?? "").trim() && denied.length)
    throw new Error(denied.includes("mcp") ? `denied mcp (harness): ${JSON.stringify(j.denied_actions)}` : `denied: ${denied.join(",")}`);
  if (j.status !== "SUCCESS") throw new Error(`agy status ${j.status}: ${err.replace(/\s+/g, " ").slice(-300)}`);
  return String(j.response).trim();
}

async function runOne(model: string, t: Task, arm: Arm, rep: number): Promise<Row> {
  const row: Row = { task: t.id, arm, rep, model, status: "ok", search_calls: 0, more_calls: 0, input_tokens: 0, output_tokens: 0, seconds: 0 };
  const ws = mkdtempSync(`${tmpdir()}/cq-gh-agent-`);
  const bun = process.execPath;
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, REPLAY: t.payload, REPLAY_LOG: `${ws}/calls.jsonl` };
  const shell = arm.endsWith("-shell");
  const base = arm.replace(/-shell$/, "");
  const server = base === "raw" ? { command: bun, args: [REPLAY], env }
    : base === "trunc" ? { command: "/bin/sh", args: ["-c", `exec npx -y mcp-trunc-proxy@${TRUNC_VERSION} -- "${bun}" "${REPLAY}" 2>>"${ws}/proxy.log"`], env }
    : { command: "/bin/sh", args: ["-c", `exec "${bun}" "${ROOT}src/cli.ts" proxy${/^cq-\d+k$/.test(base) ? ` --budget ${parseInt(base.slice(3)) * 1000}` : ""} -- "${bun}" "${REPLAY}" 2>>"${ws}/proxy.log"`], env };
  const start = Date.now();
  try {
    row.answer = await (model.startsWith("claude:") ? runClaude : runAgy)(model, t, ws, server, row, shell);
    row.correct = grade(t, row.answer);
  } catch (e) {
    row.status = "error";
    row.error = (e as Error).message;
  } finally {
    const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
    row.search_calls = read(`${ws}/calls.jsonl`).length;
    row.more_calls = read(`${ws}/proxy.log`).filter((l) => l.startsWith("contextquant contextquant_more:")).length;
    row.seconds = Math.round((Date.now() - start) / 1000);
    rmSync(ws, { recursive: true, force: true });
  }
  return row;
}

// agy saves large tool results to a file and the agent then reaches for a shell (or a file read
// outside what agy allows) to parse it. Those are denied here (no code execution, like Claude Desktop
// or a ChatGPT connector), so the run has no answer. That's an outcome, not a harness error: kept,
// graded wrong. A denied MCP call means the agent used some other server: harness error, retried.
const noAnswer = (r: Row) => r.status === "error" && !!r.error?.startsWith("denied:");
const finished = (r: Row) => r.status === "ok" || noAnswer(r);
// An answer that says the data isn't available, instead of guessing.
const abstained = (r: Row) => r.status === "ok" && !r.correct &&
  /not (determined|shown|available|visible|included)|isn't available|cannot|can't|couldn't|could not|unable|unknown|no answer|too large|reliabl/i.test(lastParagraph(r.answer ?? ""));
const dir = (model: string) => `${OUT}/${model.replace(":", "-")}`;

function load(file: string): Row[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string" }, reps: { type: "string", default: "3" }, arms: { type: "string", default: "raw,cq,cq-6k" }, concurrency: { type: "string", default: "3" } },
});

if (!import.meta.main) {
  // imported (tests): no CLI
} else if (positionals[0] === "tasks") {
  for (const t of tasks()) console.log(`${t.id}\t${t.prompt}\t${JSON.stringify(t.expect)}`);
} else if (positionals[0] === "run") {
  const model = values.model ?? (() => { throw new Error("--model is required (see `agy models`)"); })();
  const file = `${dir(model)}/results.jsonl`;
  mkdirSync(dir(model), { recursive: true });
  const done = new Set(load(file).filter(finished).map((r) => `${r.task}|${r.arm}|${r.rep}`));
  const queue = tasks().flatMap((t) => values.arms!.split(",").flatMap((arm) =>
    Array.from({ length: Number(values.reps) }, (_, rep) => ({ t, arm: arm as Arm, rep })))).filter((j) => !done.has(`${j.t.id}|${j.arm}|${j.rep}`));
  console.log(`${model}: ${queue.length} runs to do`);
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const row = await runOne(model, job.t, job.arm, job.rep);
      appendFileSync(file, JSON.stringify(row) + "\n");
      console.log(`${row.task} ${row.arm} #${row.rep}: ${row.status === "ok" ? (row.correct ? "right" : `wrong (${row.answer?.slice(0, 60)})`) : row.error?.slice(0, 120)}`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
} else if (positionals[0] === "summary") {
  const byTask = new Map(tasks().map((t) => [t.id, t]));
  for (const model of existsSync(OUT) ? readdirSync(OUT) : []) {
    // Latest ok row per (task, arm, rep): retried errors don't count twice.
    const rows = [...new Map(load(`${OUT}/${model}/results.jsonl`).filter(finished).map((r) => [`${r.task}|${r.arm}|${r.rep}`, r])).values()];
    for (const r of rows) if (r.status === "ok") r.correct = grade(byTask.get(r.task)!, r.answer ?? ""); // regrade: grader fixes apply to old runs
    console.log(`\n### ${model}\n\n| arm | correct | wrong | said not shown | no answer | recovery calls | turns (avg) | input tokens (avg) | seconds (avg) | cost |\n|---|---|---|---|---|---|---|---|---|---|`);
    for (const arm of ARMS) {
      const r = rows.filter((x) => x.arm === arm);
      if (!r.length) continue;
      const avg = (f: (x: Row) => number) => Math.round(r.reduce((s, x) => s + f(x), 0) / r.length);
      const right = r.filter((x) => x.correct).length, none = r.filter(noAnswer).length, abst = r.filter(abstained).length;
      const cost = r.reduce((s, x) => s + (x.cost_usd ?? 0), 0);
      console.log(`| ${arm} | ${right}/${r.length} | ${r.length - right - none - abst} | ${abst} | ${none} | ${(r.reduce((s, x) => s + x.more_calls, 0) / r.length).toFixed(1)} | ${r.some((x) => x.turns) ? (r.reduce((s, x) => s + (x.turns ?? 0), 0) / r.length).toFixed(1) : "—"} | ${avg((x) => x.input_tokens).toLocaleString("en-US")} | ${avg((x) => x.seconds)} | ${cost ? `$${cost.toFixed(2)}` : "—"} |`);
    }
    const wrong = rows.filter((x) => !x.correct && !noAnswer(x) && !abstained(x)).map((x) => `${x.arm} ${x.task}: "${x.answer?.slice(0, 80)}" (expected ${JSON.stringify(byTask.get(x.task)?.expect)})`);
    if (wrong.length) console.log(`\nWrong answers:\n${wrong.map((w) => `- ${w}`).join("\n")}`);
  }
} else {
  console.log("usage: bun eval/github-agent.ts tasks | run --model <id> [--reps 3] [--arms raw,cq] [--concurrency 3] | summary");
}
