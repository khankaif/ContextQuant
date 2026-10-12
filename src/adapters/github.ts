import { shape, type Json } from "../shape.ts";
import { o200k } from "../tokens.ts";
import type { Adapter, AdapterPolicy, ProviderAuth, ProviderPage } from "./types.ts";

export const GITHUB_SEARCH_FIELDS = [
  "number",
  "title",
  "state",
  "labels.name",
  "user.login",
  "assignee.login",
  "updated_at",
  "html_url",
];

export const GITHUB_DETAIL_FIELDS = ["title", "body", "state", "labels", "assignee", "milestone", "reactions"] as const;
export type GithubDetailField = (typeof GITHUB_DETAIL_FIELDS)[number];

export type GithubSearchArgs = {
  owner: string;
  repo: string;
  query: string;
  page?: number;
  budget_tokens?: number;
};

export type GithubIssueArgs = {
  owner: string;
  repo: string;
  issue_number: number;
  fields: GithubDetailField[];
};

export type GithubSearchResponse = {
  total_count: number;
  incomplete_results?: boolean;
  items: Json[];
};

const api = "https://api.github.com";

export class GithubClient {
  constructor(private readonly token = process.env.GITHUB_TOKEN, private readonly fetcher: typeof fetch = fetch) {}

  async search(args: GithubSearchArgs): Promise<GithubSearchResponse> {
    if (hasConflictingScope(args.query)) {
      throw new Error("query must not contain repo:, org:, user:, or is:pr; owner, repo, and this issues-only tool define the scope");
    }
    const q = `${args.query} repo:${args.owner}/${args.repo} is:issue`;
    const url = new URL(`${api}/search/issues`);
    url.searchParams.set("q", q);
    url.searchParams.set("per_page", "30");
    url.searchParams.set("page", String(args.page ?? 1));
    const res = await this.request(url);
    return await res.json() as GithubSearchResponse;
  }

  async issue(args: GithubIssueArgs): Promise<Json> {
    const url = new URL(`${api}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.issue_number}`);
    return await (await this.request(url)).json() as Json;
  }

  private async request(url: URL): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "contextquant-gateway",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 240)}`);
    return res;
  }
}

/** Convert one GitHub search page into a stable receipt plus JSONL records. */
export function renderGithubSearch(
  page: GithubSearchResponse,
  args: GithubSearchArgs,
  maxTokens = args.budget_tokens ?? 1_500,
): string {
  if (!page.items.length) return renderEmptySearch(page, maxTokens);

  const raw = JSON.stringify({ items: page.items, total_count: page.total_count });
  const nextPage = page.items.length === 30 && (args.page ?? 1) * 30 < Math.min(page.total_count, 1_000) ? (args.page ?? 1) + 1 : undefined;
  const policy = shape(raw, { fields: GITHUB_SEARCH_FIELDS, label: "github issues", ids: false });
  if (!policy.stats) throw new Error(`GitHub search payload could not be inspected: ${policy.passthrough ?? "unknown error"}`);
  const withheld = policy.stats.leftOut.length ? policy.stats.leftOut.join(", ") : "none";
  const receipt = receiptLines(page, withheld);
  let remainingBudget = maxTokens - tokenCount(receipt.join("\n")) - 1;
  while (remainingBudget >= 64) {
    const result = shape(raw, {
      fields: GITHUB_SEARCH_FIELDS,
      maxTokens: remainingBudget,
      label: "github issues",
      more: nextPage ? `call github_search_issues with page=${nextPage}` : undefined,
      counts: ["labels.name", "assignee.login"],
      ids: false,
    });
    if (!result.stats) throw new Error(`GitHub search payload could not be shaped: ${result.passthrough ?? "unknown error"}`);
    const text = [...receipt, result.text].join("\n");
    const overflow = tokenCount(text) - maxTokens;
    if (overflow <= 0) return text;
    remainingBudget -= overflow;
  }
  throw new Error("token budget is too small to render the ContextQuant receipt");
}

function receiptLines(page: GithubSearchResponse, withheld: string): string[] {
  const receipt = [
    `# cq receipt: github_search_issues · upstream_page=${page.items.length} · total=${page.total_count}`,
    "# selected fields are shown below; recover omitted issue detail with github_get_issue(owner, repo, issue_number, fields)",
    "# not returned by GitHub search: full comments, timeline events · use a dedicated tool before claiming either",
    `# withheld by policy: ${withheld}`,
  ];
  if (page.incomplete_results) receipt.push("# warning: GitHub marked this search incomplete; do not treat total as exhaustive");
  return receipt;
}

function renderEmptySearch(page: GithubSearchResponse, maxTokens: number): string {
  const text = [...receiptLines(page, "none"), "# github issues: showing 0 of 0"].join("\n");
  if (tokenCount(text) > maxTokens) throw new Error("token budget is too small to render the ContextQuant receipt");
  return text;
}

/** Project one issue detail response to the fields explicitly requested by the agent. */
export function renderGithubIssue(issue: Json, fields: GithubDetailField[]): string {
  const object = issue as Record<string, Json>;
  const out: Record<string, Json> = { number: object.number ?? null };
  for (const field of fields) {
    const val = object[field];
    if (val === undefined) {
      out[field] = null;
    } else if (field === "assignee" && val && typeof val === "object") {
      out.assignee = { login: (val as Record<string, Json>).login ?? null };
    } else if (field === "milestone" && val && typeof val === "object") {
      const ms = val as Record<string, Json>;
      out.milestone = { title: ms.title ?? null, state: ms.state ?? null };
    } else if (field === "labels" && Array.isArray(val)) {
      out.labels = val.map((item) => (typeof item === "object" && item !== null && "name" in item ? ((item as Record<string, Json>).name ?? null) : item));
    } else if (field === "reactions" && val && typeof val === "object") {
      const rx = val as Record<string, Json>;
      out.reactions = {
        total_count: rx.total_count ?? 0,
        "+1": rx["+1"] ?? 0,
        "-1": rx["-1"] ?? 0,
        laugh: rx.laugh ?? 0,
        hooray: rx.hooray ?? 0,
        confused: rx.confused ?? 0,
        heart: rx.heart ?? 0,
        rocket: rx.rocket ?? 0,
        eyes: rx.eyes ?? 0,
      };
    } else {
      out[field] = val;
    }
  }
  return JSON.stringify(out);
}

export function hasConflictingScope(query: string): boolean {
  return /\b(?:repo|org|user):|\bis:pr\b/i.test(query);
}

function tokenCount(text: string): number {
  return o200k.count(text);
}

export const githubAdapter: Adapter = {
  id: "github",
  searchToolName: "github_search_issues",
  detailToolName: "github_get_issue",
  async executeSearch(args: unknown, auth?: ProviderAuth): Promise<ProviderPage> {
    const searchArgs = args as GithubSearchArgs;
    const client = new GithubClient(auth?.token as string | undefined);
    const page = await client.search(searchArgs);
    const nextPage = page.items.length === 30 && (searchArgs.page ?? 1) * 30 < Math.min(page.total_count, 1_000)
      ? String((searchArgs.page ?? 1) + 1)
      : undefined;

    return {
      payload: page as unknown as Json,
      recordPath: "items",
      upstreamTotal: page.total_count,
      next: nextPage ? { cursor: nextPage, argument: "page" } : undefined,
      detailRecovery: {
        tool: "github_get_issue",
        description: "Recover selected fields from one GitHub issue",
        arguments: { owner: searchArgs.owner, repo: searchArgs.repo, issue_number: "<number>" },
      },
    };
  },
  async executeDetail(args: unknown, auth?: ProviderAuth): Promise<unknown> {
    const issueArgs = args as GithubIssueArgs;
    const client = new GithubClient(auth?.token as string | undefined);
    const item = await client.issue(issueArgs);
    return JSON.parse(renderGithubIssue(item, issueArgs.fields));
  },
  policyFor(_args: unknown): AdapterPolicy {
    return {
      baseFields: GITHUB_SEARCH_FIELDS,
      requestToResponse: {},
      filterFieldPaths(_input: unknown) {
        return [];
      },
      redactedPaths: [],
      defaultBudgetTokens: 1_500,
    };
  },
};
