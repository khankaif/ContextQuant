import { shape, type Json } from "../shape.ts";
import { o200k } from "../tokens.ts";

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

export type GithubSearchArgs = { owner: string; repo: string; query: string; page?: number };
export type GithubIssueArgs = { owner: string; repo: string; issue_number: number; fields: GithubDetailField[] };
export type GithubSearchResponse = { total_count: number; incomplete_results?: boolean; items: Json[] };

const api = "https://api.github.com";

export class GithubClient {
  constructor(private readonly token = process.env.GITHUB_TOKEN, private readonly fetcher: typeof fetch = fetch) {}

  async search(args: GithubSearchArgs): Promise<GithubSearchResponse> {
    const q = `${args.query} repo:${args.owner}/${args.repo}`;
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
      "x-github-api-version": "2026-03-10",
      "user-agent": "contextquant-gateway",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 240)}`);
    return res;
  }
}

/** Convert one GitHub search page into a stable receipt plus JSONL records. */
export function renderGithubSearch(page: GithubSearchResponse, args: GithubSearchArgs, maxTokens = 1_500): string {
  const raw = JSON.stringify({ items: page.items, total_count: page.total_count });
  const nextPage = page.items.length === 30 && (args.page ?? 1) * 30 < Math.min(page.total_count, 1_000) ? (args.page ?? 1) + 1 : undefined;
  const result = shape(raw, {
    fields: GITHUB_SEARCH_FIELDS,
    maxTokens,
    label: "github issues",
    more: nextPage ? `call github_search_issues with page=${nextPage}` : undefined,
    counts: ["labels.name", "assignee.login"],
    ids: false,
  });
  if (!result.stats) throw new Error(`GitHub search payload could not be shaped: ${result.passthrough ?? "unknown error"}`);

  const withheld = result.stats.leftOut.length ? result.stats.leftOut.join(", ") : "none";
  const receipt = [
    `# cq receipt: github_search_issues · upstream_page=${page.items.length} · shown=${result.stats.shown} · total=${page.total_count}`,
    `# withheld by policy: ${withheld} · recovery: github_get_issue(owner, repo, issue_number, fields)`,
    "# not returned by GitHub search: full comments, timeline events · use a dedicated tool before claiming either",
  ];
  if (page.incomplete_results) receipt.push("# warning: GitHub marked this search incomplete; do not treat total as exhaustive");
  return [...receipt, result.text].join("\n");
}

/** Project one issue detail response to the fields explicitly requested by the agent. */
export function renderGithubIssue(issue: Json, fields: GithubDetailField[]): string {
  const object = issue as Record<string, Json>;
  const out: Record<string, Json> = { number: object.number ?? null };
  for (const field of fields) out[field] = object[field] ?? null;
  return JSON.stringify(out);
}

export function githubSearchStats(text: string): { tokens: number } {
  return { tokens: o200k.count(text) };
}
