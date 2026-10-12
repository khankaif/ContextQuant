import { describe, expect, test } from "bun:test";
import { buildGitHubFixture, type EvalArmResult } from "../eval/github-fixture.ts";
import { GITHUB_SEARCH_FIELDS, renderGithubIssue, renderGithubSearch } from "../src/adapters/github.ts";
import { projectRecords } from "../src/shape.ts";
import { o200k } from "../src/tokens.ts";

describe("Phase 2: GitHub 4-Arm Evaluation", () => {
  const fixture = buildGitHubFixture();
  const rawJson = JSON.stringify(fixture);
  const rawTokens = o200k.count(rawJson);

  function runArm(arm: "raw" | "native" | "cq" | "cq_budgeted"): EvalArmResult {
    switch (arm) {
      case "raw": {
        const tokens = rawTokens;
        return {
          arm: "raw",
          rawPayloadBytes: rawJson.length,
          outputTokens: tokens,
          tokenSavingsPct: 0,
          shownRows: fixture.items.length,
          withheldFieldsDeclared: false,
          recoveryToolDeclared: false,
        };
      }
      case "native": {
        // Native field projection (just keeping base fields without receipt)
        const projected = projectRecords(rawJson, GITHUB_SEARCH_FIELDS);
        const text = JSON.stringify(projected);
        const tokens = o200k.count(text);
        return {
          arm: "native",
          rawPayloadBytes: text.length,
          outputTokens: tokens,
          tokenSavingsPct: Math.round(((rawTokens - tokens) / rawTokens) * 100),
          shownRows: fixture.items.length,
          withheldFieldsDeclared: false,
          recoveryToolDeclared: false,
        };
      }
      case "cq": {
        const { text } = renderGithubSearch(fixture, { owner: "acme", repo: "web-framework", query: "is:open" }, 2_000);
        const tokens = o200k.count(text);
        return {
          arm: "cq",
          rawPayloadBytes: text.length,
          outputTokens: tokens,
          tokenSavingsPct: Math.round(((rawTokens - tokens) / rawTokens) * 100),
          shownRows: fixture.items.length,
          withheldFieldsDeclared: text.includes("left out fields:"),
          recoveryToolDeclared: text.includes("github_get_issue"),
        };
      }
      case "cq_budgeted": {
        const budget = 450;
        const { text } = renderGithubSearch(fixture, { owner: "acme", repo: "web-framework", query: "is:open", budget_tokens: budget }, budget);
        const tokens = o200k.count(text);
        const shownMatch = text.match(/showing (\d+) of/);
        const shownRows = shownMatch ? Number(shownMatch[1]) : fixture.items.length;
        return {
          arm: "cq_budgeted",
          rawPayloadBytes: text.length,
          outputTokens: tokens,
          tokenSavingsPct: Math.round(((rawTokens - tokens) / rawTokens) * 100),
          shownRows,
          withheldFieldsDeclared: text.includes("left out fields:"),
          recoveryToolDeclared: text.includes("github_get_issue"),
        };
      }
    }
  }

  test("evaluates token savings across all 4 arms", () => {
    const raw = runArm("raw");
    const native = runArm("native");
    const cq = runArm("cq");
    const cqBudget = runArm("cq_budgeted");

    // CQ saves substantial tokens compared to raw by withholding bodies and stack traces
    expect(cq.outputTokens).toBeLessThan(raw.outputTokens);
    expect(cq.tokenSavingsPct).toBeGreaterThanOrEqual(40);

    // CQ and CQ_budgeted declare omitted fields and recovery instructions
    expect(cq.withheldFieldsDeclared).toBe(true);
    expect(cq.recoveryToolDeclared).toBe(true);
    expect(cqBudget.withheldFieldsDeclared).toBe(true);
    expect(cqBudget.outputTokens).toBeLessThanOrEqual(450);

    // Native projection saves tokens but lacks honest omission receipt
    expect(native.withheldFieldsDeclared).toBe(false);
    expect(native.recoveryToolDeclared).toBe(false);
  });

  test("demonstrates lossless multi-turn recovery via github_get_issue", () => {
    // Agent searches issues, sees memory leak issue #103 without body
    const searchResult = renderGithubSearch(fixture, { owner: "acme", repo: "web-framework", query: "label:bug" }).text;
    expect(searchResult).toContain("103");
    expect(searchResult).toContain("Memory leak in WebSocket heartbeat interval timer");
    expect(searchResult).not.toContain("Retained size in `ws_heartbeats`");

    // Agent executes detail recovery for issue 103's body and reactions
    const targetIssue = fixture.items.find((i: any) => i.number === 103)!;
    const detail = renderGithubIssue(targetIssue, ["body", "reactions"]);

    expect(detail).toContain("Retained size in `ws_heartbeats`");
    expect(detail).toContain('"reactions":{"total_count":15');
    // Ensure sensitive or unrequested fields remain unexposed
    expect(detail).not.toContain("https://avatars.test");
  });
});
