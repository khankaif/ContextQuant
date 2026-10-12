#!/usr/bin/env bun
import { parseArgs } from "util";
import { encode as toon } from "@toon-format/toon";
import { peopleSearch, SAMPLE_QUERY, PEOPLE_BASE, PEOPLE_RENAME } from "../bench/people.ts";
import { fieldsFromFilters, filterFields } from "./intent.ts";
import { projectRecords, shape } from "./shape.ts";
import { cl100k, o200k } from "./tokens.ts";
import pkg from "../package.json";

const USAGE = `usage:
  cq proxy [--budget N] [--config file.json] -- <command> [args...]
                    wrap any stdio MCP server; its tool results come back shaped
  cq gateway        the built-in GitHub / Jira / HubSpot MCP server
  cq shape <file|-> [--fields a,b.c] [--people-query <json>] [--max-tokens N]
                    [--format json|tsv] [--no-ids] [--label name] [--more text]
  cq gen people [--n 25] [--seed 42]
  cq bench [--n 25] [--seed 42]`;


const { values: o, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    fields: { type: "string" },
    "people-query": { type: "string" },
    "max-tokens": { type: "string" },
    format: { type: "string" },
    "no-ids": { type: "boolean" },
    label: { type: "string" },
    more: { type: "string" },
    n: { type: "string" },
    seed: { type: "string" },
    budget: { type: "string" },
    config: { type: "string" },
  },
});

const int = (s: string | undefined, d: number) => {
  if (s === undefined) return d;
  const v = Number(s);
  if (!Number.isInteger(v) || v < 0) fail(`not a non-negative integer: ${s}`);
  return v;
};
function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(1);
}

const [cmd, arg] = positionals;

if (cmd === "proxy") {
  const { ProxyConfigSchema, runProxy } = await import("./proxy.ts");
  const [command, ...args] = positionals.slice(1);
  if (!command) fail("missing the MCP server command; put it after --, e.g. cq proxy -- npx -y some-mcp-server");
  let cfg = {};
  if (o.config) {
    let json: unknown;
    try {
      json = JSON.parse(await Bun.file(o.config).text());
    } catch (e) {
      fail(`bad config ${o.config}: ${(e as Error).message}`);
    }
    const parsed = ProxyConfigSchema.safeParse(json);
    if (!parsed.success) fail(`bad config ${o.config}: ${parsed.error.message}`);
    cfg = parsed.data;
  }
  if (o.budget !== undefined) {
    const budget = int(o.budget, 0);
    if (budget < 256) fail("--budget must be at least 256");
    cfg = { ...cfg, budget_tokens: budget };
  }
  await runProxy(command, args, cfg, pkg.version);
} else if (cmd === "gateway") {
  const { createGateway } = await import("./gateway/server.ts");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await createGateway().connect(new StdioServerTransport());
} else if (cmd === "shape") {
  if (!arg) fail("missing input file");
  const input = arg === "-" ? await Bun.stdin.text() : await Bun.file(arg).text();
  if (o.format && o.format !== "json" && o.format !== "tsv") fail(`unknown format: ${o.format}`);
  const query = o["people-query"] ? JSON.parse(o["people-query"]) : undefined;
  const fields = query
    ? fieldsFromFilters(query.filters, PEOPLE_BASE, PEOPLE_RENAME)
    : o.fields?.split(",").map((f) => f.trim()).filter(Boolean);
  const r = shape(input, {
    fields,
    maxTokens: o["max-tokens"] === undefined ? undefined : int(o["max-tokens"], 0),
    format: o.format as "json" | "tsv" | undefined,
    ids: o["no-ids"] ? false : undefined,
    label: o.label,
    more: o.more,
    counts: query ? filterFields(query.filters, PEOPLE_RENAME) : undefined,
  });
  console.log(r.text);
  const tin = o200k.count(input), tout = o200k.count(r.text);
  console.error(
    r.passthrough
      ? `passthrough: ${r.passthrough}`
      : `shown ${r.stats!.shown}/${r.stats!.records} · left out ${r.stats!.leftOut.length} fields · ${r.stats!.aliased} id values shortened · ` +
          `o200k ${tin} → ${tout} tokens (${pct(tout, tin)})`,
  );
} else if (cmd === "gen") {
  if (arg !== "people") fail("only `cq gen people` exists");
  console.log(JSON.stringify(peopleSearch(int(o.n, 25), int(o.seed, 42)), null, 2));
} else if (cmd === "bench") {
  bench(int(o.n, 25), int(o.seed, 42));
} else {
  fail(cmd ? `unknown command: ${cmd}` : "missing command");
}

function bench(n: number, seed: number) {
  const data = peopleSearch(n, seed);
  const pretty = JSON.stringify(data, null, 2);
  const min = JSON.stringify(data);
  const fields = fieldsFromFilters(SAMPLE_QUERY.filters, PEOPLE_BASE, PEOPLE_RENAME);
  const projected = projectRecords(min, fields);

  o200k.count("warm up"); // building the encoder isn't shaping time
  const t0 = performance.now();
  const cqAll = shape(min).text;
  const ms = performance.now() - t0;

  const arms: [string, string][] = [
    ["pretty JSON", pretty],
    ["minified JSON (baseline)", min],
    ["TOON", toon(data)],
    ["minified JSON, query fields (= API `fields` param)", JSON.stringify(projected)],
    ["TOON, query fields", toon(projected)],
    ["cq json, all fields", cqAll],
    ["cq json, query fields", shape(min, { fields }).text],
    ["cq tsv, query fields", shape(min, { fields, format: "tsv" }).text],
  ];

  console.log(`person search fixture: ${n} profiles, seed ${seed}, ${(min.length / 1024).toFixed(1)} KB minified`);
  console.log(`query fields: ${fields.join(", ")}\n`);
  for (const tok of [o200k, cl100k]) {
    const base = tok.count(min);
    console.log(tok.name);
    for (const [name, text] of arms) {
      const t = tok.count(text);
      console.log(`  ${name.padEnd(52)} ${String(t).padStart(7)}  ${pct(t, base)}`);
    }
    console.log();
  }
  console.log(`shape() time, all fields: ${ms.toFixed(1)} ms`);
  console.log("accuracy not measured here; see eval (not built yet)");
}

function pct(t: number, base: number) {
  const d = (100 * (t - base)) / base;
  return `${d > 0 ? "+" : ""}${d.toFixed(1)}%`;
}
