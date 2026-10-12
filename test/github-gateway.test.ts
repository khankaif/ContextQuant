import { describe, expect, test } from "bun:test";
import { GithubClient, renderGithubIssue, renderGithubSearch, type GithubSearchResponse } from "../src/gateway/github.ts";
import type { Json } from "../src/shape.ts";
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
    for (const badQuery of [
      "repo:other/private is:open",
      "(repo:other/private) bug",
      "org:internal-inc leak",
      "user:someone-else bug",
      "is:pr open",
      "test+repo:forbidden",
      "-repo:other bug",
    ]) {
      await expect(client.search({ owner: "acme", repo: "api", query: badQuery })).rejects.toThrow("must not contain repo:");
    }
  });

  test("detail recovery returns only requested fields and prunes nested payloads", () => {
    const rawIssue = {
      number: 7,
      body: "the detail",
      assignee: {
        login: "octocat",
        id: 1,
        avatar_url: "https://github.com/images/error/octocat_happy.gif",
        gravatar_id: "",
        html_url: "https://github.com/octocat",
      },
      milestone: { title: "v1.0", state: "open", description: "First release", creator: { login: "admin" } },
      labels: [{ name: "bug", color: "f29513" }, { name: "triage" }],
      reactions: { total_count: 5, "+1": 3, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 2, rocket: 0, eyes: 0, url: "https://api..." },
    };
    const text = renderGithubIssue(rawIssue as unknown as Json, ["body", "assignee", "milestone", "labels", "reactions"]);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      number: 7,
      body: "the detail",
      assignee: { login: "octocat" },
      milestone: { title: "v1.0", state: "open" },
      labels: ["bug", "triage"],
      reactions: { total_count: 5, "+1": 3, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 2, rocket: 0, eyes: 0 },
    });
  });

  test("respects caller-specified budget_tokens", () => {
    const text = renderGithubSearch(page, { owner: "acme", repo: "api", query: "is:open", budget_tokens: 500 });
    expect(o200k.count(text)).toBeLessThanOrEqual(500);
  });
});
