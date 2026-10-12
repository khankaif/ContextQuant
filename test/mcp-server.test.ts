import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["src/gateway/server.ts"] });
const client = new Client({ name: "contextquant-test", version: "0.0.0" });

afterAll(async () => {
  await client.close();
});

describe("ContextQuant MCP server", () => {
  test("publishes the search and scoped detail recovery tools over stdio", async () => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "github_get_issue",
      "github_search_issues",
      "hubspot_get_record",
      "hubspot_search",
      "jira_get_issue",
      "jira_search_issues",
    ]);
  });

  test("rejects invalid input schema over stdio with isError", async () => {
    const res = await client.callTool({
      name: "github_search_issues",
      arguments: { owner: "invalid@slug", repo: "api", query: "bug" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("must be a GitHub owner slug");
  });

  test("validates budget_tokens constraints over stdio", async () => {
    const res = await client.callTool({
      name: "github_search_issues",
      arguments: { owner: "honojs", repo: "hono", query: "bug", budget_tokens: 50 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toContain("budget_tokens");
  });
});
