// Head-to-head on captured live GitHub results (run capture.ts first).
// Each arm is treated as a black box: the same bytes go in, we count what the model would get.
//   bun bench/compare/compare.ts                         arms: raw, cq
//   bun bench/compare/compare.ts --arms raw,cq,trunc,headroom
//     trunc     npx -y mcp-trunc-proxy, wrapping the same replay server, default settings
//     headroom  headroom compress() on the tool message (needs uv; HEADROOM_OFFLINE=1)
// Writes bench/out/compare/<arm>/<payload>.txt and prints a markdown table.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { o200k } from "../../src/tokens.ts";
import { QUERIES } from "./queries.ts";

const { values } = parseArgs({ options: { arms: { type: "string", default: "raw,cq" } } });
const arms = values.arms!.split(",");
const here = new URL(".", import.meta.url).pathname;
const replay = ["bun", `${here}replay-server.ts`];
const OUT = "bench/out/compare";

const PROXIES: Record<string, string[]> = {
  raw: replay,
  cq: ["bun", "src/cli.ts", "proxy", "--", ...replay],
  trunc: ["npx", "-y", "mcp-trunc-proxy", "--", ...replay],
};

async function viaMcp(cmd: string[], q: string): Promise<string> {
  const client = new Client({ name: "cq-compare", version: "1" });
  await client.connect(new StdioClientTransport({ command: cmd[0]!, args: cmd.slice(1), stderr: "ignore" }));
  try {
    const r = await client.callTool({ name: "search_issues", arguments: { q, per_page: 30 } });
    return (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

function viaHeadroom(file: string, q: string): string {
  const p = Bun.spawnSync(["uv", "run", "--python", "3.13", "--with", "headroom-ai", "python", "-I", `${here}headroom_arm.py`, file, q],
    { env: { ...process.env, HEADROOM_OFFLINE: "1" }, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`headroom: ${p.stderr.toString().slice(-500)}`);
  return p.stdout.toString();
}

// Facts an agent doing triage needs, taken from the raw response. A fact counts as kept if it
// appears in the arm's output; titles match on their first 40 characters (cq shortens long ones).
type Issue = { number: number; title: string; assignees?: { login: string }[] };
function facts(raw: string): string[] {
  const j = JSON.parse(raw) as { total_count: number; items: Issue[] };
  const f = [`total_count:${j.total_count}`];
  for (const i of j.items) {
    f.push(`number:${i.number}`, `title:${i.title.slice(0, 40)}`);
    for (const a of i.assignees ?? []) f.push(`assignee:${a.login}`);
  }
  return f;
}
function kept(fact: string, out: string): boolean {
  const [kind, ...rest] = fact.split(":");
  const v = rest.join(":");
  if (kind === "number" || kind === "total_count") return new RegExp(`(^|[^0-9])${v}([^0-9]|$)`).test(out);
  return out.includes(v) || out.includes(JSON.stringify(v).slice(1, -1));
}

const rows: string[] = [];
const totals: Record<string, { tokens: number; kept: number; facts: number }> = {};
for (const q of QUERIES) {
  const file = `${here}payloads/${q.name}.txt`;
  const raw = readFileSync(file, "utf8");
  const fs = facts(raw);
  const cells: string[] = [];
  for (const arm of arms) {
    const out = arm === "headroom" ? viaHeadroom(file, q.q) : await viaMcp(PROXIES[arm]!, q.q);
    mkdirSync(`${OUT}/${arm}`, { recursive: true });
    writeFileSync(`${OUT}/${arm}/${q.name}.txt`, out);
    const tokens = o200k.count(out);
    const k = fs.filter((f) => kept(f, out)).length;
    const t = (totals[arm] ??= { tokens: 0, kept: 0, facts: 0 });
    t.tokens += tokens; t.kept += k; t.facts += fs.length;
    cells.push(`${tokens.toLocaleString("en-US")} · ${Math.round((100 * k) / fs.length)}%`);
  }
  rows.push(`| ${q.name} | ${cells.join(" | ")} |`);
}

console.log(`Tokens (o200k) · facts kept (issue numbers, titles, assignees, total_count)\n`);
console.log(`| payload | ${arms.join(" | ")} |\n|---|${arms.map(() => "---").join("|")}|`);
console.log(rows.join("\n"));
console.log(`| **total** | ${arms.map((a) => `**${totals[a]!.tokens.toLocaleString("en-US")} · ${Math.round((100 * totals[a]!.kept) / totals[a]!.facts)}%**`).join(" | ")} |`);
