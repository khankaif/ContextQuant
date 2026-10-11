// person_search as a stdio MCP server, for agents we can't hand a tool directly (agy).
// CQ_VARIANT picks the rendering (raw | fields | cq); every call is appended to CQ_LOG
// as {args, tokens} so the eval counts calls and tool-result tokens on our side.
//   CQ_VARIANT=cq CQ_LOG=/tmp/calls.jsonl bun eval/mcp-server.ts
// ponytail: hand-rolled JSON-RPC for initialize / tools/list / tools/call only; use the MCP SDK if more is needed.
import { appendFileSync } from "node:fs";
import { TOOL, toolResult, VARIANTS, type SearchArgs, type Variant } from "./agent.ts";
import { o200k } from "../src/tokens.ts";

const variant = process.env.CQ_VARIANT as Variant;
if (!VARIANTS.includes(variant)) throw new Error(`CQ_VARIANT must be one of ${VARIANTS.join(", ")}`);
const log = process.env.CQ_LOG;

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id: unknown, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\n");

function handle(msg: { id?: unknown; method?: string; params?: any }) {
  if (msg.id === undefined) return; // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "people", version: "1.0.0" },
      });
    case "tools/list":
      return reply(msg.id, { tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.parameters }] });
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return fail(msg.id, `unknown tool: ${msg.params?.name}`);
      const args = (msg.params?.arguments ?? {}) as SearchArgs;
      const text = toolResult(variant, args);
      if (log) appendFileSync(log, JSON.stringify({ args, tokens: o200k.count(text) }) + "\n");
      return reply(msg.id, { content: [{ type: "text", text }] });
    }
    case "ping":
      return reply(msg.id, {});
    default:
      return fail(msg.id, `method not found: ${msg.method}`);
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`bad message: ${(e as Error).message}\n`);
    }
  }
}
