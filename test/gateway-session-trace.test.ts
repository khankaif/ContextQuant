import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/gateway/session.ts";
import { TraceWriter } from "../src/gateway/trace.ts";
import { createGateway } from "../src/gateway/server.ts";
import { GithubClient } from "../src/adapters/github.ts";

describe("SessionStore recovery security", () => {
  test("allows valid recovery within same session and scope", () => {
    const store = new SessionStore(60_000);
    store.register("sess-1", "github", { owner: "acme", repo: "api" }, ["title", "body", "state"]);

    const res = store.validateRecovery("sess-1", "github", { owner: "acme", repo: "api" }, ["body"]);
    expect(res.valid).toBe(true);
  });

  test("blocks recovery across different repositories (scope isolation)", () => {
    const store = new SessionStore(60_000);
    store.register("sess-1", "github", { owner: "acme", repo: "api" }, ["body"]);

    const res = store.validateRecovery("sess-1", "github", { owner: "acme", repo: "private-vault" }, ["body"]);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain("scope mismatch");
    }
  });

  test("blocks recovery if field is not in allowlist", () => {
    const store = new SessionStore(60_000);
    store.register("sess-1", "github", { owner: "acme", repo: "api" }, ["title", "body"]);

    const res = store.validateRecovery("sess-1", "github", { owner: "acme", repo: "api" }, ["reactions"]);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain("not in the allowed recovery field list");
    }
  });

  test("blocks recovery of permanently redacted paths", () => {
    const store = new SessionStore(60_000);
    store.register("sess-1", "github", { owner: "acme", repo: "api" }, ["title", "body"], ["body"]);

    const res = store.validateRecovery("sess-1", "github", { owner: "acme", repo: "api" }, ["body"]);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain("permanently redacted");
    }
  });

  test("purges expired sessions based on TTL", () => {
    const store = new SessionStore(-100); // Expired immediately
    store.register("sess-old", "github", { owner: "acme", repo: "api" }, ["body"]);

    expect(store.get("sess-old")).toBeUndefined();
    const res = store.validateRecovery("sess-old", "github", { owner: "acme", repo: "api" }, ["body"]);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain("session not found or expired");
    }
  });
});

describe("TraceWriter observability", () => {
  test("records events without raw payloads or secrets", () => {
    const tracer = new TraceWriter();
    tracer.emit({
      adapter: "github",
      tool: "github_search_issues",
      outcome: "shaped",
      inputTokens: 42,
      outputTokens: 250,
      shownRows: 10,
      omittedRows: 5,
      withheldFieldCount: 3,
      latencyMs: 15,
    });

    const events = tracer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.adapter).toBe("github");
    expect(events[0]?.outcome).toBe("shaped");
    expect(events[0]?.inputTokens).toBe(42);
    expect(events[0]?.outputTokens).toBe(250);
    expect(events[0]?.timestamp).toBeDefined();

    // Verify no payload text or secrets in keys
    const keys = Object.keys(events[0]!);
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("payload");
    expect(keys).not.toContain("token");
  });
});

describe("Gateway server session & trace integration", () => {
  test("blocks recovery when scope is manipulated with session_id", async () => {
    const tracer = new TraceWriter();
    const store = new SessionStore(60_000);
    store.register("test-sess", "github", { owner: "acme", repo: "api" }, ["body"]);

    const server = createGateway(new GithubClient(), undefined, undefined, tracer, store);

    const mockClient = {
      issue: async () => ({ number: 1, body: "secret" }),
    } as unknown as GithubClient;

    const testServer = createGateway(mockClient, undefined, undefined, tracer, store);
    // Directly invoke handlers through tools
    const tools = (testServer as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> })._registeredTools;

    const res = await tools["github_get_issue"]!.handler({
      owner: "attacker",
      repo: "api",
      issue_number: 1,
      fields: ["body"],
      session_id: "test-sess",
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Recovery blocked: scope mismatch");

    const events = tracer.getEvents();
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.outcome).toBe("blocked");
  });
});
