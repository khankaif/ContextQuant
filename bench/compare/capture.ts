// Capture live search_issues results from the reference GitHub MCP server, byte for byte,
// so every arm in compare.ts sees the exact same text.
//   bun bench/compare/capture.ts            writes bench/compare/payloads/<name>.txt
// No token needed for public search; GITHUB_PERSONAL_ACCESS_TOKEN in the env is passed through if set.
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { QUERIES } from "./queries.ts";

const dir = new URL("./payloads/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });

const client = new Client({ name: "cq-capture", version: "1" });
await client.connect(new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { ...process.env } as Record<string, string>,
}));

for (const q of QUERIES) {
  const r = await client.callTool({ name: "search_issues", arguments: { q: q.q, per_page: 30 } });
  const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text;
  if (r.isError || !text) throw new Error(`${q.name}: ${JSON.stringify(r).slice(0, 300)}`);
  writeFileSync(`${dir}${q.name}.txt`, text);
  console.log(`${q.name}: ${text.length} chars`);
}
await client.close();
