import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MORE_TOOL, more, ResponseStore, shapeResult, shapeToolText } from "../src/proxy.ts";
import { o200k } from "../src/tokens.ts";

// GitHub-search-like page: long bodies, API self-links, nested ids, one constant field.
const issues = Array.from({ length: 30 }, (_, i) => ({
  url: `https://api.github.com/repos/a/b/issues/${i + 1}`,
  html_url: `https://github.com/a/b/issues/${i + 1}`,
  id: 1000 + i,
  number: i + 1,
  title: `Crash when parsing config file variant ${i + 1}`,
  state: "open",
  user: { login: `user${i % 4}`, id: 50 + i, avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
  labels: [{ id: 7, name: i % 3 ? "bug" : "crash" }],
  body: `Steps to reproduce ${i + 1}. `.repeat(40),
  assignee: null,
  milestone: i === 0 ? { title: "v1" } : null,
}));
const page = JSON.stringify({ total_count: 30, items: issues });
const text = (r: unknown) => ((r as { content: { text: string }[] }).content)[0]!.text;

describe("shapeToolText (auto policy)", () => {
  test("leaves out long text, machine links and nested ids; keeps ids, human links, short fields", () => {
    const out = shapeToolText(page, "search_issues", {}, new ResponseStore())!;
    const left = out.text.split("\n").find((l) => l.startsWith("# left out fields:"))!;
    expect(left).toContain("body");
    expect(left).toMatch(/\+\d+ URL\/ID fields/);
    const row = JSON.parse(out.text.split("\n").find((l) => l.startsWith("{"))!);
    expect(Object.keys(row)).toEqual(["html_url", "id", "number", "title", "user", "labels", "milestone"]);
    expect(row.user).toEqual({ login: "user0" });
    expect(out.after).toBeLessThan(out.before / 3);
  });

  test("fields null everywhere are declared, and a field missing from a row is explained", () => {
    const out = shapeToolText(page, "search_issues", {}, new ResponseStore())!;
    expect(out.text).toContain("# empty (null) in every record: assignee");
    expect(out.text).toContain("# a field missing from a row is empty (null) in that record");
  });

  test("a value shared by every record is printed once, not per row", () => {
    const out = shapeToolText(page, "search_issues", {}, new ResponseStore())!;
    expect(out.text).toContain('# same in every record: state="open"');
    expect(out.text.split("\n").filter((l) => l.includes('"state"'))).toEqual([]);
  });

  test("cut records point at contextquant_more with the exact next offset, and it returns them", () => {
    const store = new ResponseStore();
    const out = shapeToolText(page, "search_issues", { budget_tokens: 600 }, store)!;
    expect(o200k.count(out.text)).toBeLessThanOrEqual(600);
    const shown = out.text.split("\n").filter((l) => l.startsWith("{")).length;
    expect(out.text).toContain(`call ${MORE_TOOL} with handle="r1" and offset=${shown}`);
    const next = text(more({ handle: "r1", offset: shown }, { budget_tokens: 600 }, store));
    expect(next).toContain(`(records ${shown + 1}–`);
    expect(JSON.parse(next.split("\n").find((l) => l.startsWith("{"))!).number).toBe(shown + 1);
  });

  test("left-out fields come back on request", () => {
    const store = new ResponseStore();
    shapeToolText(page, "search_issues", {}, store);
    const r = text(more({ handle: "r1", fields: ["number", "body"], budget_tokens: 2_000 }, {}, store));
    expect(JSON.parse(r.split("\n").find((l) => l.startsWith("{"))!)).toEqual({ number: 1, body: issues[0]!.body });
  });

  test("configured fields and counts win over auto", () => {
    const cfg = { tools: { search_issues: { fields: ["number", "title"], counts: ["labels.name"] } } };
    const out = shapeToolText(page, "search_issues", cfg, new ResponseStore())!;
    expect(Object.keys(JSON.parse(out.text.split("\n").find((l) => l.startsWith("{"))!))).toEqual(["number", "title"]);
    expect(out.text).toContain("# count by labels.name (all 30 records in this response): bug 20 · crash 10");
  });

  test("not JSON, no record list, skipped tools, or no gain: left alone", () => {
    const store = new ResponseStore();
    expect(shapeToolText("plain text result", "t", {}, store)).toBeUndefined();
    expect(shapeToolText('{"ok":true}', "t", {}, store)).toBeUndefined();
    expect(shapeToolText(page, "t", { tools: { t: { skip: true } } }, store)).toBeUndefined();
    expect(shapeToolText('[{"a":1},{"a":2}]', "t", {}, store)).toBeUndefined();
  });

  test("a small result whose notes would cost more than they save comes back as is", () => {
    const small = JSON.stringify([1, 2, 3].map((id) => ({ id, url: `https://api.x.com/items/${id}` })));
    expect(shapeToolText(small, "t", {}, new ResponseStore())).toBeUndefined();
  });

  test("structuredContent: kept untouched under an output schema, dropped as a duplicate without one", () => {
    const res = { content: [{ type: "text" as const, text: page }], structuredContent: JSON.parse(page) };
    expect(shapeResult(res, "t", {}, new ResponseStore(), true)).toBe(res);
    expect(shapeResult(res, "t", {}, new ResponseStore(), undefined)).toBe(res);
    const shaped = shapeResult(res, "t", {}, new ResponseStore(), false);
    expect(shaped.structuredContent).toBeUndefined();
    expect(text(shaped)).toContain("# contextquant: handle=");
    const skipped = shapeResult(res, "t", { tools: { t: { skip: true } } }, new ResponseStore(), false);
    expect(skipped).toBe(res); // not shaped, so the structured copy stays
    const different = { ...res, structuredContent: { summary: "not the same data" } };
    expect(shapeResult(different, "t", {}, new ResponseStore(), false)).toBe(different);
  });

  test("contextquant_more returns the requested view even when the original is small", () => {
    const store = new ResponseStore();
    const small = JSON.stringify([1, 2, 3].map((id) => ({ id, name: `n${id}` })));
    store.put(small, "t");
    const r = text(more({ handle: "r1", offset: 2 }, {}, store));
    expect(r.split("\n").filter((l) => l.startsWith("{"))).toEqual(['{"id":3,"name":"n3"}']);
  });

  test("bad and expired handles are tool errors, not crashes", () => {
    const store = new ResponseStore(1);
    shapeToolText(page, "t", {}, store);
    shapeToolText(page, "t", {}, store); // evicts r1
    expect(more({ handle: "r1" }, {}, store).isError).toBe(true);
    expect(more({ offset: -1 }, {}, store).isError).toBe(true);
  });
});

describe("cq proxy end to end", () => {
  test("wraps a real stdio MCP server: tools pass through, results shaped, more works", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "proxy", "--budget", "1500", "--", process.execPath, "eval/mcp-server.ts"],
      env: { ...process.env, CQ_VARIANT: "raw" } as Record<string, string>,
      stderr: "pipe",
    }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(["person_search", MORE_TOOL]);

      const filters = { field: "basic_profile.name", type: "!=", value: "nobody" };
      const first = text(await client.callTool({ name: "person_search", arguments: { filters } }));
      expect(o200k.count(first)).toBeLessThanOrEqual(1_500);
      const hint = first.match(/handle="(r\d+)" and offset=(\d+)/)!;
      expect(hint).not.toBeNull();

      const next = text(await client.callTool({ name: MORE_TOOL, arguments: { handle: hint[1], offset: Number(hint[2]) } }));
      expect(next).toContain(`(records ${Number(hint[2]) + 1}–`);
    } finally {
      await client.close();
    }
  }, 20_000);
});
