import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { shape } from "./shape.ts";
import { o200k } from "./tokens.ts";

export const MORE_TOOL = "contextquant_more";
/** Stays under Claude Code's 10,000-token warning for one MCP tool result. */
export const DEFAULT_PROXY_BUDGET = 8_000;

export const ToolPolicySchema = z.object({
  /** Fields to keep; "auto" (default) picks them from the data. */
  fields: z.union([z.literal("auto"), z.array(z.string().min(1))]).optional(),
  counts: z.array(z.string().min(1)).optional(),
  budget_tokens: z.number().int().min(256).optional(),
  /** Pass this tool's results through untouched. */
  skip: z.boolean().optional(),
}).strict();
export const ProxyConfigSchema = z.object({
  budget_tokens: z.number().int().min(256).optional(),
  tools: z.record(z.string(), ToolPolicySchema).optional(),
}).strict();
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

/** Original tool results, so contextquant_more can page through them or return left-out fields. */
export class ResponseStore {
  private readonly items = new Map<string, { text: string; tool: string }>();
  private next = 1;
  // ponytail: last 50 responses in memory; a size cap or disk spill if agents page through huge results.
  constructor(private readonly max = 50) {}
  put(text: string, tool: string): string {
    const handle = `r${this.next++}`;
    this.items.set(handle, { text, tool });
    if (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
    return handle;
  }
  get(handle: string) {
    return this.items.get(handle);
  }
}

export interface Shaped {
  text: string;
  /** o200k tokens before and after, for the stderr savings line. */
  before: number;
  after: number;
}

/**
 * One tool result through shape(), with a handle to get back anything that was cut.
 * Anything that isn't a JSON list of records comes back unchanged.
 */
export function shapeToolText(
  text: string,
  tool: string,
  cfg: ProxyConfig,
  store: ResponseStore,
  view: { handle?: string; offset?: number; fields?: string[] | "auto"; budget?: number } = {},
): Shaped | undefined {
  const policy = cfg.tools?.[tool] ?? {};
  if (policy.skip) return undefined;
  const fields = view.fields ?? policy.fields ?? "auto";
  const offset = view.offset ?? 0;
  const budget = view.budget ?? policy.budget_tokens ?? cfg.budget_tokens ?? DEFAULT_PROXY_BUDGET;
  const opts = { fields, counts: policy.counts, ids: false as const, label: tool, offset };
  const probe = shape(text, opts).passthrough;
  if (probe === "not_json" || probe === "no_records") return undefined;

  const handle = view.handle ?? store.put(text, tool);
  const receipt = `# contextquant: handle="${handle}" holds the full response · ${MORE_TOOL}(handle, offset, fields) returns cut records or left-out fields`;
  // The "more" hint names the next offset, which depends on how many rows fit; it settles in a pass or two.
  const fit = (max: number) => {
    let at = 0;
    let r;
    for (let i = 0; i < 4; i++) {
      r = shape(text, { ...opts, maxTokens: max, more: `call ${MORE_TOOL} with handle="${handle}" and offset=${offset + at}` });
      if (!r.stats || r.stats.shown === at) break;
      at = r.stats.shown;
    }
    return r!;
  };
  let r = fit(budget);
  const cut = !!r.stats && (r.stats.leftOut.length > 0 || offset + r.stats.shown < r.stats.records);
  let out = r.text;
  if (cut) {
    r = fit(budget - o200k.count(receipt) - 1);
    out = `${receipt}\n${r.text}`;
  }
  const before = o200k.count(text);
  const after = o200k.count(out);
  // No smaller (tiny or already-dense output): the original fits and says more. A contextquant_more
  // call (view.handle set) asked for a specific page or fields, so it gets that view regardless.
  if (!view.handle && after >= before) return undefined;
  return { text: out, before, after };
}

const MoreArgs = z.object({
  handle: z.string(),
  offset: z.number().int().min(0).optional(),
  fields: z.array(z.string().min(1)).optional(),
  budget_tokens: z.number().int().min(256).optional(),
});

export const MORE_TOOL_DEF: Tool = {
  name: MORE_TOOL,
  description:
    "Get what contextquant cut from an earlier tool result. Pass the handle from that result's notes, " +
    'plus offset for the next records and/or fields for left-out fields (["*"] returns every field). ' +
    "Raise budget_tokens if the result says the budget is too small.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: 'Handle from the notes, e.g. "r3"' },
      offset: { type: "integer", minimum: 0, description: "First record to return (0-based)" },
      fields: { type: "array", items: { type: "string" }, description: 'Dotted field paths, e.g. ["number", "body"], or ["*"]' },
      budget_tokens: { type: "integer", minimum: 256, description: "Token cap for this result" },
    },
    required: ["handle"],
  },
};

/** contextquant_more: page or widen a stored response. */
export function more(rawArgs: unknown, cfg: ProxyConfig, store: ResponseStore): CallToolResult {
  const args = MoreArgs.safeParse(rawArgs ?? {});
  if (!args.success) return { content: [{ type: "text", text: `invalid arguments: ${args.error.message}` }], isError: true };
  const { handle, offset, fields, budget_tokens } = args.data;
  const entry = store.get(handle);
  if (!entry) return { content: [{ type: "text", text: `unknown or expired handle "${handle}"; call the original tool again` }], isError: true };
  const view = { handle, offset, budget: budget_tokens, fields: fields?.includes("*") ? [] : fields };
  const shaped = shapeToolText(entry.text, entry.tool, cfg, store, view);
  return { content: [{ type: "text", text: shaped?.text ?? entry.text }] };
}

/**
 * Shape the text of one upstream tool result. A result with structuredContent passes through
 * unchanged unless the tool has no outputSchema and a text block holds the same JSON: then the
 * structured copy is a duplicate (the spec's backwards-compatible form), so it is dropped and the
 * text is shaped.
 */
export function shapeResult(
  res: CallToolResult,
  tool: string,
  cfg: ProxyConfig,
  store: ResponseStore,
  hasOutputSchema: boolean | undefined,
): CallToolResult {
  if (res.isError) return res;
  if (res.structuredContent !== undefined) {
    const same = JSON.stringify(res.structuredContent);
    const duplicated = res.content.some((c) => c.type === "text" && sameJson(c.text, same));
    if (hasOutputSchema !== false || !duplicated) return res;
  }
  let changed = false;
  const content = res.content.map((c) => {
    if (c.type !== "text") return c;
    const shaped = shapeToolText(c.text, tool, cfg, store);
    if (!shaped) return c;
    changed = true;
    console.error(`contextquant ${tool}: ${shaped.before} → ${shaped.after} tokens (o200k)`);
    return { ...c, text: shaped.text };
  });
  if (!changed) return res;
  const { structuredContent: _, ...rest } = res;
  return { ...rest, content };
}

function sameJson(text: string, json: string): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === json;
  } catch {
    return false;
  }
}

/** Run as an MCP server that wraps the MCP server started by `command`. */
export async function runProxy(command: string, args: string[], cfg: ProxyConfig, version: string): Promise<void> {
  const upstream = new Client({ name: "contextquant", version });
  // Default env for stdio children is a short safe list; the wrapped server needs its tokens.
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  await upstream.connect(new StdioClientTransport({ command, args, env, stderr: "inherit" }));
  const caps = upstream.getServerCapabilities() ?? {};
  const info = upstream.getServerVersion();

  const server = new Server(
    { name: `contextquant(${info?.name ?? command})`, version: info?.version ?? version },
    {
      capabilities: { tools: { listChanged: true }, ...(caps.prompts ? { prompts: {} } : {}), ...(caps.resources ? { resources: {} } : {}) },
      instructions: upstream.getInstructions(),
    },
  );
  const store = new ResponseStore();
  const outputSchema = new Map<string, boolean>();
  // If the wrapped server has its own contextquant_more, it wins and ours is not offered.
  let upstreamHasMore = false;
  // ponytail: forwarded requests wait up to 10 minutes and progress notifications aren't relayed.
  const slow = { timeout: 600_000 };

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const res = caps.tools ? await upstream.listTools(req.params) : { tools: [] };
    for (const t of res.tools) outputSchema.set(t.name, t.outputSchema !== undefined);
    if (res.tools.some((t) => t.name === MORE_TOOL) && !upstreamHasMore) {
      upstreamHasMore = true;
      console.error(`contextquant: the wrapped server has its own ${MORE_TOOL}; cut results can't be recovered through this proxy`);
    }
    return { ...res, tools: req.params?.cursor || upstreamHasMore ? res.tools : [...res.tools, MORE_TOOL_DEF] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name === MORE_TOOL && !upstreamHasMore) return more(req.params.arguments, cfg, store);
    const res = await upstream.request({ method: "tools/call", params: req.params }, CallToolResultSchema, slow);
    return shapeResult(res, name, cfg, store, outputSchema.get(name));
  });

  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req) => upstream.listPrompts(req.params, slow));
    server.setRequestHandler(GetPromptRequestSchema, (req) => upstream.getPrompt(req.params, slow));
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => upstream.listResources(req.params, slow));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) => upstream.listResourceTemplates(req.params, slow));
    server.setRequestHandler(ReadResourceRequestSchema, (req) => upstream.readResource(req.params, slow));
  }
  upstream.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());

  upstream.onclose = () => {
    console.error("contextquant: wrapped MCP server exited");
    process.exit(1);
  };
  server.onclose = () => void upstream.close();
  await server.connect(new StdioServerTransport());
}
