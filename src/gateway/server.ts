import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_DETAIL_FIELDS, GithubClient, renderGithubIssue, renderGithubSearch } from "./github.ts";

const owner = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "must be a GitHub owner slug");
const repo = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "must be a GitHub repository slug");

export function createGateway(github = new GithubClient()): McpServer {
  const server = new McpServer({ name: "contextquant", version: "0.3.0" });

  server.registerTool("github_search_issues", {
    title: "Search GitHub issues with an omission receipt",
    description: "Search one repository. Results are context-budgeted and explicitly name withheld fields and any locally omitted rows. Use github_get_issue for a selected issue's body or assignee.",
    inputSchema: { owner, repo, query: z.string().min(1).max(512), page: z.number().int().min(1).max(34).optional() },
  }, async (args) => {
    try {
      const page = await github.search(args);
      return { content: [{ type: "text", text: renderGithubSearch(page, args) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `GitHub search failed: ${(error as Error).message}` }], isError: true };
    }
  });

  server.registerTool("github_get_issue", {
    title: "Recover selected GitHub issue fields",
    description: "Fetch only explicitly requested fields from one issue selected from github_search_issues. This is the recovery path for fields withheld from list results.",
    inputSchema: {
      owner,
      repo,
      issue_number: z.number().int().positive(),
      fields: z.array(z.enum(GITHUB_DETAIL_FIELDS)).min(1).max(GITHUB_DETAIL_FIELDS.length),
    },
  }, async (args) => {
    try {
      const issue = await github.issue(args);
      return { content: [{ type: "text", text: renderGithubIssue(issue, args.fields) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `GitHub issue recovery failed: ${(error as Error).message}` }], isError: true };
    }
  });

  return server;
}

if (import.meta.main) {
  const server = createGateway();
  await server.connect(new StdioServerTransport());
}
