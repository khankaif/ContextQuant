// Stdio MCP server with one tool that returns a large synthetic people-search page.
// Upstream for the end-to-end proxy test.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { peopleSearch } from "../bench/people.ts";

const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "person_search", description: "Search people", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: JSON.stringify(peopleSearch(25, 7)) }],
}));

await server.connect(new StdioServerTransport());
