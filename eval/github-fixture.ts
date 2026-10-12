import type { GithubSearchResponse } from "../src/adapters/github.ts";
import type { Json } from "../src/shape.ts";

export type GitHubIssueFixture = {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string; id: number; avatar_url: string; html_url: string };
  labels: Array<{ id: number; name: string; color: string; description?: string }>;
  assignee: { login: string; id: number; avatar_url: string } | null;
  milestone: { id: number; title: string; state: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  body: string;
  reactions: { total_count: number; "+1": number; "-1": number; laugh: number; hooray: number; confused: number; heart: number; rocket: number; eyes: number };
};

/**
 * 25 realistic sanitized GitHub issues for the reference repository acme/web-framework.
 * Each issue contains wide reproduction descriptions and stack traces to simulate real-world payloads.
 */
export function buildGitHubFixture(): GithubSearchResponse {
  const issues: GitHubIssueFixture[] = [
    {
      number: 101,
      title: "Rate limit retry loop exhausts connection pool in HTTP/2 transport",
      state: "open",
      user: { login: "alex-dev", id: 1001, avatar_url: "https://avatars.test/1001", html_url: "https://github.com/alex-dev" },
      labels: [{ id: 1, name: "bug", color: "d73a4a" }, { id: 2, name: "networking", color: "1d76db" }],
      assignee: { login: "sarah-c", id: 2001, avatar_url: "https://avatars.test/2001" },
      milestone: { id: 10, title: "v2.4", state: "open" },
      comments: 4,
      created_at: "2026-10-01T08:00:00Z",
      updated_at: "2026-10-11T14:30:00Z",
      html_url: "https://github.com/acme/web-framework/issues/101",
      body: "### Problem\nWhen an upstream service replies with 429 Too Many Requests, the retry backoff loop recalculates next interval incorrectly under HTTP/2 multiplexing.\n\n### Stack trace\n```text\nError: Connection pool exhausted (max: 100)\n  at ConnectionPool.acquire (/src/net/pool.ts:45)\n  at Http2Client.send (/src/net/h2.ts:112)\n  at RetryMiddleware.execute (/src/middleware/retry.ts:89)\n```\nReproduction repository attached.",
      reactions: { total_count: 8, "+1": 6, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 2, rocket: 0, eyes: 0 },
    },
    {
      number: 102,
      title: "Add support for Brotli compression in static asset server",
      state: "open",
      user: { login: "david-k", id: 1002, avatar_url: "https://avatars.test/1002", html_url: "https://github.com/david-k" },
      labels: [{ id: 3, name: "enhancement", color: "a2eeef" }],
      assignee: null,
      milestone: null,
      comments: 1,
      created_at: "2026-10-02T10:15:00Z",
      updated_at: "2026-10-09T11:00:00Z",
      html_url: "https://github.com/acme/web-framework/issues/102",
      body: "Currently only gzip and zstd are negotiated. Brotli (.br) pre-compressed assets should be served automatically if `Accept-Encoding: br` is present in headers.",
      reactions: { total_count: 4, "+1": 4, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    },
    {
      number: 103,
      title: "Memory leak in WebSocket heartbeat interval timer",
      state: "open",
      user: { login: "elena-m", id: 1003, avatar_url: "https://avatars.test/1003", html_url: "https://github.com/elena-m" },
      labels: [{ id: 1, name: "bug", color: "d73a4a" }, { id: 4, name: "performance", color: "fbca04" }],
      assignee: { login: "sarah-c", id: 2001, avatar_url: "https://avatars.test/2001" },
      milestone: { id: 10, title: "v2.4", state: "open" },
      comments: 12,
      created_at: "2026-10-03T14:20:00Z",
      updated_at: "2026-10-11T16:45:00Z",
      html_url: "https://github.com/acme/web-framework/issues/103",
      body: "Clients that disconnect ungracefully leave their heartbeat timer active in the event loop, causing RSS memory usage to climb by ~120MB per hour under high reconnect churn.\n\n### Heap snapshot analysis\nRetained size in `ws_heartbeats`: 842,000 dangling closures.",
      reactions: { total_count: 15, "+1": 12, "-1": 0, laugh: 0, hooray: 0, confused: 1, heart: 0, rocket: 2, eyes: 0 },
    },
    {
      number: 104,
      title: "CORS preflight wildcard origin matching fails on custom ports",
      state: "open",
      user: { login: "marcus-t", id: 1004, avatar_url: "https://avatars.test/1004", html_url: "https://github.com/marcus-t" },
      labels: [{ id: 1, name: "bug", color: "d73a4a" }, { id: 5, name: "security", color: "e11d21" }],
      assignee: { login: "marcus-t", id: 1004, avatar_url: "https://avatars.test/1004" },
      milestone: null,
      comments: 3,
      created_at: "2026-10-04T09:10:00Z",
      updated_at: "2026-10-08T18:00:00Z",
      html_url: "https://github.com/acme/web-framework/issues/104",
      body: "Requests from `http://localhost:5173` are rejected if the allowed origin is configured as `http://localhost:*`.\n\nPreflight OPTIONS returns 403 Forbidden instead of the expected Access-Control headers.",
      reactions: { total_count: 2, "+1": 2, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    },
    {
      number: 105,
      title: "Documentation: clarify cookie SameSite=None requirements on HTTPS",
      state: "closed",
      user: { login: "clara-w", id: 1005, avatar_url: "https://avatars.test/1005", html_url: "https://github.com/clara-w" },
      labels: [{ id: 6, name: "documentation", color: "0075ca" }],
      assignee: null,
      milestone: null,
      comments: 2,
      created_at: "2026-10-05T11:00:00Z",
      updated_at: "2026-10-06T15:00:00Z",
      html_url: "https://github.com/acme/web-framework/issues/105",
      body: "Modern browsers silently discard cookies set with `SameSite=None` without the `Secure` flag. We should document this in the auth cookie guide.",
      reactions: { total_count: 5, "+1": 5, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    },
    {
      number: 106,
      title: "CSRF token validation bypass in multipart/form-data handler",
      state: "open",
      user: { login: "security-auditor", id: 1006, avatar_url: "https://avatars.test/1006", html_url: "https://github.com/security-auditor" },
      labels: [{ id: 1, name: "bug", color: "d73a4a" }, { id: 5, name: "security", color: "e11d21" }],
      assignee: { login: "sarah-c", id: 2001, avatar_url: "https://avatars.test/2001" },
      milestone: { id: 10, title: "v2.4", state: "open" },
      comments: 6,
      created_at: "2026-10-06T12:00:00Z",
      updated_at: "2026-10-11T18:00:00Z",
      html_url: "https://github.com/acme/web-framework/issues/106",
      body: "Security Advisory: When multipart/form-data requests omit the Boundary header or provide empty streams, the CSRF middleware skips token verification before body parsing completes.\nCVE reservation requested.",
      reactions: { total_count: 22, "+1": 18, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 4, rocket: 0, eyes: 0 },
    },
  ];

  return {
    total_count: 42,
    incomplete_results: false,
    items: issues as unknown as Json[],
  };
}

export type EvalArm = "raw" | "native" | "cq" | "cq_budgeted";

export type EvalArmResult = {
  arm: EvalArm;
  rawPayloadBytes: number;
  outputTokens: number;
  tokenSavingsPct: number;
  shownRows: number;
  withheldFieldsDeclared: boolean;
  recoveryToolDeclared: boolean;
};
