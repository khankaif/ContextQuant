import { describe, expect, test } from "bun:test";
import { GithubClient, renderGithubIssue, renderGithubSearch, type GithubSearchResponse } from "../src/gateway/github.ts";
import { o200k } from "../src/tokens.ts";

const page: GithubSearchResponse = {
  total_count: 32,
  items: Array.from({ length: 30 }, (_, i) => ({
    number: i + 1,
    title: `Rate-limit regression ${i + 1}`,
    state: "open",
    labels: [{ name: i % 2 ? "backend" : "security" }],
    user: { login: "reporter", avatar_url: "https://example.test/avatar" },
    assignee: i === 0 ? { login: "octocat", id: 123 } : null,
    body: `Private reproduction detail ${i + 1}`,
    reactions: { "+1": i },
    updated_at: "2026-10-01T00:00:00Z",
    html_url: `https://github.com/acme/api/issues/${i + 1}`,
  })),
};

describe("GitHub gateway receipt", () => {
  test("declares withheld data and a precise next-page recovery", () => {
    const text = renderGithubSearch(page, { owner: "acme", repo: "api", query: "is:open", page: 1 }, 1_500);
    expect(text).toContain("withheld by policy:");
    expect(text).toContain("body");
    expect(text).toContain("github_get_issue(owner, repo, issue_number, fields)");
    expect(text).toContain("call github_search_issues with page=2");
    expect(text).not.toContain("Private reproduction detail");
    expect(o200k.count(text)).toBeLessThanOrEqual(1_500);
  });

  test("warns when GitHub says a search is incomplete", () => {
    expect(renderGithubSearch({ ...page, incomplete_results: true }, { owner: "acme", repo: "api", query: "is:open" })).toContain("search incomplete");
  });

  test("returns a truthful receipt for an empty search", () => {
    const text = renderGithubSearch({ total_count: 0, items: [] }, { owner: "acme", repo: "api", query: "is:open" });
    expect(text).toContain("upstream_page=0 · total=0");
    expect(text).toContain("showing 0 of 0");
    expect(text).toContain("withheld by policy: none");
  });

  test("rejects query text that attempts to override the tool's repository scope", async () => {
    const client = new GithubClient(undefined, (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch);
    await expect(client.search({ owner: "acme", repo: "api", query: "repo:other/private is:open" })).rejects.toThrow("must not contain repo:");
  });

  test("detail recovery returns only requested fields", () => {
    const text = renderGithubIssue({ number: 7, body: "the detail", assignee: { login: "octocat" }, milestone: { title: "v1" } }, ["body", "assignee"]);
    expect(text).toBe('{"number":7,"body":"the detail","assignee":{"login":"octocat"}}');
  });
});
