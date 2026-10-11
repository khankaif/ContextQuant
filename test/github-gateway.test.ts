import { describe, expect, test } from "bun:test";
import { renderGithubIssue, renderGithubSearch, type GithubSearchResponse } from "../src/gateway/github.ts";

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
  });

  test("warns when GitHub says a search is incomplete", () => {
    expect(renderGithubSearch({ ...page, incomplete_results: true }, { owner: "acme", repo: "api", query: "is:open" })).toContain("search incomplete");
  });

  test("detail recovery returns only requested fields", () => {
    const text = renderGithubIssue({ number: 7, body: "the detail", assignee: { login: "octocat" }, milestone: { title: "v1" } }, ["body", "assignee"]);
    expect(text).toBe('{"number":7,"body":"the detail","assignee":{"login":"octocat"}}');
  });
});
