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
    expect(tools.map((tool) => tool.name).sort()).toEqual(["github_get_issue", "github_search_issues"]);
  });
});
