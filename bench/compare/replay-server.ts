// Stdio MCP server that replays captured search_issues results, so each proxy wraps the same bytes.
//   bun bench/compare/replay-server.ts
import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { QUERIES } from "./queries.ts";

const dir = new URL("./payloads/", import.meta.url).pathname;
const server = new Server({ name: "github-replay", version: "1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "search_issues",
    description: "Search for issues and pull requests across GitHub repositories",
    inputSchema: { type: "object", properties: { q: { type: "string" }, per_page: { type: "number" } }, required: ["q"] },
  }],
}));

// REPLAY=<payload name> answers every search with that payload (for agent runs, where the model
// may phrase the query its own way); otherwise the query must match one in queries.ts.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const q = QUERIES.find((x) => (process.env.REPLAY ? x.name === process.env.REPLAY : x.q === req.params.arguments?.q));
  if (process.env.REPLAY_LOG) appendFileSync(process.env.REPLAY_LOG, JSON.stringify(req.params) + "\n");
  if (req.params.name !== "search_issues" || !q) return { isError: true, content: [{ type: "text", text: "no captured payload for that query" }] };
  return { content: [{ type: "text", text: readFileSync(`${dir}${q.name}.txt`, "utf8") }] };
});

await server.connect(new StdioServerTransport());
