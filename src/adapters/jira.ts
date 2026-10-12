import type { Json } from "../shape.ts";
import { o200k } from "../tokens.ts";
import type { Adapter, AdapterPolicy, ProviderAuth, ProviderPage } from "./types.ts";
import { DEFAULT_BUDGET_TOKENS, emptyRendered, renderWithReceipt, type Rendered } from "./receipt.ts";

export const JIRA_SEARCH_FIELDS = [
  "key",
  "fields.summary",
  "fields.status.name",
  "fields.priority.name",
  "fields.assignee.displayName",
  "fields.updated",
];

export const JIRA_DETAIL_FIELDS = [
  "summary",
  "description",
  "comments",
  "status",
  "assignee",
  "priority",
  "components",
  "labels",
] as const;
export type JiraDetailField = (typeof JIRA_DETAIL_FIELDS)[number];

export type JiraSearchArgs = {
  jql: string;
  fields?: string[];
  cursor?: string;
  budget_tokens?: number;
};

export type JiraIssueArgs = {
  issue_key: string;
  fields: JiraDetailField[];
};

export type JiraSearchResponse = {
  total: number;
  nextPageToken?: string;
  issues: Json[];
};

export class JiraClient {
  constructor(
    private readonly host = process.env.JIRA_HOST ?? "https://your-domain.atlassian.net",
    private readonly email = process.env.JIRA_EMAIL,
    private readonly apiToken = process.env.JIRA_API_TOKEN,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(args: JiraSearchArgs): Promise<JiraSearchResponse> {
    const url = new URL(`${this.host}/rest/api/3/search/jql`);
    url.searchParams.set("jql", args.jql);
    url.searchParams.set("maxResults", "30");
    if (args.cursor) url.searchParams.set("nextPageToken", args.cursor);

    const res = await this.request(url);
    return await res.json() as JiraSearchResponse;
  }

  async issue(args: JiraIssueArgs): Promise<Json> {
    const url = new URL(`${this.host}/rest/api/3/issue/${encodeURIComponent(args.issue_key)}`);
    return await (await this.request(url)).json() as Json;
  }

  private async request(url: URL): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "contextquant-gateway",
    };
    if (this.email && this.apiToken) {
      headers.authorization = `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`;
    }
    const res = await this.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Jira API ${res.status}: ${(await res.text()).slice(0, 240)}`);
    return res;
  }
}

/** Render Jira search response with receipt and JSONL */
export function renderJiraSearch(page: JiraSearchResponse, args: JiraSearchArgs, maxTokens = args.budget_tokens ?? DEFAULT_BUDGET_TOKENS): Rendered {
  if (!page.issues.length) return renderEmptySearch(page, maxTokens);
  return renderWithReceipt({
    raw: JSON.stringify({ issues: page.issues, total_count: page.total }),
    fields: JIRA_SEARCH_FIELDS,
    label: "jira issues",
    counts: ["fields.status.name", "fields.priority.name"],
    receipt: receiptLines(page, args.cursor),
    tool: "jira_search_issues",
    maxTokens,
  });
}

function receiptLines(page: JiraSearchResponse, cursor?: string): string[] {
  const receipt = [
    `# cq receipt: jira_search_issues · upstream_page=${page.issues.length} · total=${page.total}`,
    "# selected fields are shown below; recover omitted issue detail with jira_get_issue(issue_key, fields)",
    "# not returned by search: issue attachments, audit logs · use dedicated tools before claiming either",
  ];
  if (page.nextPageToken) receipt.push(`# next page available: call jira_search_issues with cursor="${page.nextPageToken}"`);
  if (cursor) receipt.push(`# paging cursor used: ${cursor}`);
  return receipt;
}

function renderEmptySearch(page: JiraSearchResponse, maxTokens: number): Rendered {
  const text = [...receiptLines(page), "# jira issues: showing 0 of 0"].join("\n");
  if (tokenCount(text) > maxTokens) throw new Error("token budget is too small to render the ContextQuant receipt");
  return emptyRendered(text);
}

/** Project issue detail response to requested fields */
export function renderJiraIssue(issue: Json, fields: JiraDetailField[]): string {
  const object = issue as Record<string, Json>;
  const rawFields = (object.fields as Record<string, Json>) ?? {};
  const out: Record<string, Json> = { key: object.key ?? null };

  for (const field of fields) {
    if (field === "summary") out.summary = rawFields.summary ?? null;
    else if (field === "description") out.description = rawFields.description ?? null;
    else if (field === "status" && rawFields.status && typeof rawFields.status === "object") {
      out.status = { name: (rawFields.status as Record<string, Json>).name ?? null };
    } else if (field === "assignee" && rawFields.assignee && typeof rawFields.assignee === "object") {
      out.assignee = { displayName: (rawFields.assignee as Record<string, Json>).displayName ?? null };
    } else if (field === "priority" && rawFields.priority && typeof rawFields.priority === "object") {
      out.priority = { name: (rawFields.priority as Record<string, Json>).name ?? null };
    } else if (field === "comments" && rawFields.comment && typeof rawFields.comment === "object") {
      const commentsArr = ((rawFields.comment as Record<string, Json>).comments as Json[]) ?? [];
      out.comments = commentsArr.map((c: any) => ({
        author: c.author?.displayName ?? "unknown",
        body: c.body ?? "",
        created: c.created ?? "",
      }));
    } else {
      out[field] = rawFields[field] ?? null;
    }
  }

  return JSON.stringify(out);
}

function tokenCount(text: string): number {
  return o200k.count(text);
}

export const jiraAdapter: Adapter = {
  id: "jira",
  searchToolName: "jira_search_issues",
  detailToolName: "jira_get_issue",
  async executeSearch(args: unknown, auth?: ProviderAuth): Promise<ProviderPage> {
    const searchArgs = args as JiraSearchArgs;
    const client = new JiraClient(auth?.host as string | undefined, auth?.email as string | undefined, auth?.token as string | undefined);
    const page = await client.search(searchArgs);

    return {
      payload: page as unknown as Json,
      recordPath: "issues",
      upstreamTotal: page.total,
      next: page.nextPageToken ? { cursor: page.nextPageToken, argument: "cursor" } : undefined,
      detailRecovery: {
        tool: "jira_get_issue",
        description: "Recover selected fields from one Jira issue",
        arguments: { issue_key: "<key>" },
      },
    };
  },
  async executeDetail(args: unknown, auth?: ProviderAuth): Promise<unknown> {
    const issueArgs = args as JiraIssueArgs;
    const client = new JiraClient(auth?.host as string | undefined, auth?.email as string | undefined, auth?.token as string | undefined);
    const item = await client.issue(issueArgs);
    return JSON.parse(renderJiraIssue(item, issueArgs.fields));
  },
  policyFor(_args: unknown): AdapterPolicy {
    return {
      baseFields: JIRA_SEARCH_FIELDS,
      requestToResponse: {},
      filterFieldPaths(_input: unknown) {
        return [];
      },
      redactedPaths: [],
      defaultBudgetTokens: DEFAULT_BUDGET_TOKENS,
    };
  },
};
