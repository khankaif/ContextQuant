import { describe, expect, test } from "bun:test";
import { jiraAdapter, renderJiraIssue, renderJiraSearch, type JiraSearchResponse } from "../src/adapters/jira.ts";
import { hubspotAdapter, renderHubSpotRecord, renderHubSpotSearch, type HubSpotSearchResponse } from "../src/adapters/hubspot.ts";
import { githubAdapter } from "../src/adapters/github.ts";
import type { Adapter } from "../src/adapters/types.ts";

describe("Phase 3: Universal Adapter Contract", () => {
  const adapters: Adapter[] = [githubAdapter, jiraAdapter, hubspotAdapter];

  test("all adapters conform to the standard Adapter interface", () => {
    for (const adapter of adapters) {
      expect(["github", "jira", "hubspot"]).toContain(adapter.id);
      expect(typeof adapter.searchToolName).toBe("string");
      expect(typeof adapter.detailToolName).toBe("string");
      expect(typeof adapter.executeSearch).toBe("function");
      expect(typeof adapter.executeDetail).toBe("function");
      expect(typeof adapter.policyFor).toBe("function");
    }
  });

  describe("Jira Adapter", () => {
    const jiraPage: JiraSearchResponse = {
      total: 15,
      nextPageToken: "eyJwYWdlIjoyfQ==",
      issues: [
        {
          key: "PAY-101",
          fields: {
            summary: "Stripe webhook duplicate event processing",
            status: { name: "In Progress" },
            priority: { name: "High" },
            assignee: { displayName: "Sarah Connor" },
            updated: "2026-10-10T12:00:00.000Z",
            description: "Idempotency key check fails under concurrent redis transactions.",
            comment: {
              comments: [
                { author: { displayName: "Dev 1" }, body: "Fix deployed to staging", created: "2026-10-10" },
              ],
            },
          },
        },
      ],
    };

    test("renders omission receipt and recovery for Jira search", () => {
      const { text } = renderJiraSearch(jiraPage, { jql: "project = PAY" });
      expect(text).toContain("cq receipt: jira_search_issues");
      expect(text).toContain("jira_get_issue(issue_key, fields)");
      expect(text).toContain("left out fields:");
      expect(text).toContain("fields.description");
      expect(text).toContain('call jira_search_issues with cursor="eyJwYWdlIjoyfQ=="');
      expect(text).not.toContain("Idempotency key check fails");
    });

    test("recovers issue details cleanly without unrequested bloat", () => {
      const issue = jiraPage.issues[0]!;
      const detailText = renderJiraIssue(issue, ["summary", "description", "comments"]);
      const detail = JSON.parse(detailText);

      expect(detail.key).toBe("PAY-101");
      expect(detail.summary).toBe("Stripe webhook duplicate event processing");
      expect(detail.description).toBe("Idempotency key check fails under concurrent redis transactions.");
      expect(detail.comments).toEqual([
        { author: "Dev 1", body: "Fix deployed to staging", created: "2026-10-10" },
      ]);
      expect(detail.assignee).toBeUndefined();
    });
  });

  describe("HubSpot Adapter", () => {
    const hubspotPage: HubSpotSearchResponse = {
      total: 8,
      paging: { next: { after: "25" } },
      results: [
        {
          id: "501",
          properties: {
            name: "Acme Corp",
            domain: "acme.com",
            city: "San Francisco",
            industry: "Fintech",
            numberofemployees: "250",
            description: "Internal sensitive sales qualification notes",
            hs_lead_status: "OPEN",
          },
          updatedAt: "2026-10-09T08:00:00Z",
        },
      ],
    };

    test("renders omission receipt and cursor for HubSpot CRM search", () => {
      const { text } = renderHubSpotSearch(hubspotPage, { object_type: "companies" });
      expect(text).toContain("cq receipt: hubspot_search · object_type=companies");
      expect(text).toContain("hubspot_get_record(object_type, id, properties)");
      expect(text).toContain("left out fields:");
      expect(text).toContain("properties.description");
      expect(text).toContain('call hubspot_search with after="25"');
      expect(text).not.toContain("Internal sensitive sales qualification notes");
    });

    test("recovers specific record properties cleanly", () => {
      const record = hubspotPage.results[0]!;
      const detailText = renderHubSpotRecord(record, ["name", "description"]);
      const detail = JSON.parse(detailText);

      expect(detail.id).toBe("501");
      expect(detail.properties.name).toBe("Acme Corp");
      expect(detail.properties.description).toBe("Internal sensitive sales qualification notes");
      expect(detail.properties.domain).toBeUndefined();
    });

    test("extracts property names from filterGroups in policy", () => {
      const policy = hubspotAdapter.policyFor({
        object_type: "companies",
        filterGroups: [
          {
            filters: [
              { propertyName: "annualrevenue", operator: "GT", value: "1000000" },
              { propertyName: "lifecyclestage", operator: "EQ", value: "customer" },
            ],
          },
        ],
      });

      const paths = policy.filterFieldPaths({
        object_type: "companies",
        filterGroups: [
          {
            filters: [
              { propertyName: "annualrevenue", operator: "GT", value: "1000000" },
              { propertyName: "lifecyclestage", operator: "EQ", value: "customer" },
            ],
          },
        ],
      });

      expect(paths).toContain("properties.annualrevenue");
      expect(paths).toContain("properties.lifecyclestage");
    });
  });
});
