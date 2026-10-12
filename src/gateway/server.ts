import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { o200k } from "../tokens.ts";
import { GITHUB_DETAIL_FIELDS, GithubClient, renderGithubIssue, renderGithubSearch } from "../adapters/github.ts";
import { JIRA_DETAIL_FIELDS, JiraClient, renderJiraIssue, renderJiraSearch } from "../adapters/jira.ts";
import {
  HUBSPOT_DEFAULT_PROPERTIES,
  HubSpotClient,
  type HubSpotObjectType,
  renderHubSpotRecord,
  renderHubSpotSearch,
} from "../adapters/hubspot.ts";
import { defaultSessionStore, SessionStore } from "./session.ts";
import { defaultTracer, TraceWriter } from "./trace.ts";

const owner = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "must be a GitHub owner slug");
const repo = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "must be a GitHub repository slug");
const hubspotObjectTypes = ["contacts", "companies", "deals", "tickets"] as const;

export function createGateway(
  github = new GithubClient(),
  jira = new JiraClient(),
  hubspot = new HubSpotClient(),
  tracer = defaultTracer,
  sessionStore = defaultSessionStore,
): McpServer {
  const server = new McpServer({ name: "contextquant", version: "0.3.0" });

  // --- GitHub Tools ---
  server.registerTool("github_search_issues", {
    title: "Search GitHub issues with an omission receipt",
    description: "Search one repository. Results are context-budgeted and explicitly name withheld fields and any locally omitted rows. Use github_get_issue for a selected issue's body or assignee.",
    inputSchema: {
      owner,
      repo,
      query: z.string().min(1).max(512),
      page: z.number().int().min(1).max(34).optional(),
      budget_tokens: z.number().int().min(256).max(8192).optional(),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));
    try {
      const page = await github.search(args);
      const text = renderGithubSearch(page, args, args.budget_tokens);
      const outputTokens = o200k.count(text);

      const sessId = args.session_id ?? `${args.owner}/${args.repo}`;
      sessionStore.register(sessId, "github", { owner: args.owner, repo: args.repo }, [...GITHUB_DETAIL_FIELDS]);

      tracer.emit({
        adapter: "github",
        tool: "github_search_issues",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: page.items.length,
        omittedRows: Math.max(0, page.total_count - page.items.length),
        withheldFieldCount: 0,
        recoveryKind: page.items.length < page.total_count ? "next_page" : undefined,
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "github",
        tool: "github_search_issues",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `GitHub search failed: ${msg}` }], isError: true };
    }
  });

  server.registerTool("github_get_issue", {
    title: "Recover selected GitHub issue fields",
    description: "Return only explicitly requested fields from one issue selected from github_search_issues. This is the recovery path for fields withheld from list results.",
    inputSchema: {
      owner,
      repo,
      issue_number: z.number().int().positive(),
      fields: z.array(z.enum(GITHUB_DETAIL_FIELDS)).min(1).max(GITHUB_DETAIL_FIELDS.length),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));

    const sessId = args.session_id ?? `${args.owner}/${args.repo}`;
    const session = sessionStore.get(sessId);
    if (session) {
      const validation = sessionStore.validateRecovery(sessId, "github", { owner: args.owner, repo: args.repo }, args.fields);
      if (!validation.valid) {
        tracer.emit({
          adapter: "github",
          tool: "github_get_issue",
          outcome: "blocked",
          inputTokens,
          outputTokens: 0,
          shownRows: 0,
          omittedRows: 0,
          withheldFieldCount: 0,
          recoveryKind: "detail",
          latencyMs: Math.round(performance.now() - t0),
          error: validation.reason,
        });
        return { content: [{ type: "text", text: `Recovery blocked: ${validation.reason}` }], isError: true };
      }
    }

    try {
      const issue = await github.issue(args);
      const text = renderGithubIssue(issue, args.fields);
      const outputTokens = o200k.count(text);

      tracer.emit({
        adapter: "github",
        tool: "github_get_issue",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: 1,
        omittedRows: 0,
        withheldFieldCount: GITHUB_DETAIL_FIELDS.length - args.fields.length,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "github",
        tool: "github_get_issue",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `GitHub issue recovery failed: ${msg}` }], isError: true };
    }
  });

  // --- Jira Tools ---
  server.registerTool("jira_search_issues", {
    title: "Search Jira issues with an omission receipt",
    description: "Search Jira issues using JQL. Results are context-budgeted and explicitly declare omitted fields and continuation cursor.",
    inputSchema: {
      jql: z.string().min(1).max(1024),
      cursor: z.string().optional(),
      budget_tokens: z.number().int().min(256).max(8192).optional(),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));
    try {
      const page = await jira.search(args);
      const text = renderJiraSearch(page, args, args.budget_tokens);
      const outputTokens = o200k.count(text);

      const sessId = args.session_id ?? "jira_default";
      sessionStore.register(sessId, "jira", {}, [...JIRA_DETAIL_FIELDS]);

      tracer.emit({
        adapter: "jira",
        tool: "jira_search_issues",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: page.issues.length,
        omittedRows: Math.max(0, page.total - page.issues.length),
        withheldFieldCount: 0,
        recoveryKind: page.nextPageToken ? "next_page" : undefined,
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "jira",
        tool: "jira_search_issues",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `Jira search failed: ${msg}` }], isError: true };
    }
  });

  server.registerTool("jira_get_issue", {
    title: "Recover selected Jira issue fields",
    description: "Return only explicitly requested fields from one Jira issue. This is the recovery path for descriptions and comments withheld from list results.",
    inputSchema: {
      issue_key: z.string().min(1).max(64),
      fields: z.array(z.enum(JIRA_DETAIL_FIELDS)).min(1).max(JIRA_DETAIL_FIELDS.length),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));

    try {
      const issue = await jira.issue(args);
      const text = renderJiraIssue(issue, args.fields);
      const outputTokens = o200k.count(text);

      tracer.emit({
        adapter: "jira",
        tool: "jira_get_issue",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: 1,
        omittedRows: 0,
        withheldFieldCount: JIRA_DETAIL_FIELDS.length - args.fields.length,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "jira",
        tool: "jira_get_issue",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `Jira issue recovery failed: ${msg}` }], isError: true };
    }
  });

  // --- HubSpot Tools ---
  server.registerTool("hubspot_search", {
    title: "Search HubSpot CRM objects with an omission receipt",
    description: "Search HubSpot contacts, companies, deals, or tickets. Results are context-budgeted and declare omitted properties.",
    inputSchema: {
      object_type: z.enum(hubspotObjectTypes),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      budget_tokens: z.number().int().min(256).max(8192).optional(),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));

    try {
      const page = await hubspot.search(args);
      const text = renderHubSpotSearch(page, args, args.budget_tokens);
      const outputTokens = o200k.count(text);

      const sessId = args.session_id ?? `hubspot_${args.object_type}`;
      sessionStore.register(sessId, "hubspot", { object_type: args.object_type }, HUBSPOT_DEFAULT_PROPERTIES[args.object_type as HubSpotObjectType]);

      tracer.emit({
        adapter: "hubspot",
        tool: "hubspot_search",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: page.results.length,
        omittedRows: Math.max(0, page.total - page.results.length),
        withheldFieldCount: 0,
        recoveryKind: page.paging?.next?.after ? "next_page" : undefined,
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "hubspot",
        tool: "hubspot_search",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `HubSpot search failed: ${msg}` }], isError: true };
    }
  });

  server.registerTool("hubspot_get_record", {
    title: "Recover selected HubSpot record properties",
    description: "Return only explicitly requested properties from one HubSpot record. This is the recovery path for details omitted from list results.",
    inputSchema: {
      object_type: z.enum(hubspotObjectTypes),
      id: z.string().min(1).max(100),
      properties: z.array(z.string()).min(1),
      session_id: z.string().optional(),
    },
  }, async (args) => {
    const t0 = performance.now();
    const inputTokens = o200k.count(JSON.stringify(args));

    try {
      const record = await hubspot.getRecord(args);
      const text = renderHubSpotRecord(record, args.properties);
      const outputTokens = o200k.count(text);

      tracer.emit({
        adapter: "hubspot",
        tool: "hubspot_get_record",
        outcome: "shaped",
        inputTokens,
        outputTokens,
        shownRows: 1,
        omittedRows: 0,
        withheldFieldCount: 0,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
      });

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const msg = (error as Error).message;
      tracer.emit({
        adapter: "hubspot",
        tool: "hubspot_get_record",
        outcome: "error",
        inputTokens,
        outputTokens: 0,
        shownRows: 0,
        omittedRows: 0,
        withheldFieldCount: 0,
        recoveryKind: "detail",
        latencyMs: Math.round(performance.now() - t0),
        error: msg,
      });
      return { content: [{ type: "text", text: `HubSpot record recovery failed: ${msg}` }], isError: true };
    }
  });

  return server;
}

if (import.meta.main) {
  const server = createGateway();
  await server.connect(new StdioServerTransport());
}
