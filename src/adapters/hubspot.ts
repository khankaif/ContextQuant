import { shape, type Json } from "../shape.ts";
import { o200k } from "../tokens.ts";
import type { Adapter, AdapterPolicy, ProviderAuth, ProviderPage } from "./types.ts";

export type HubSpotObjectType = "contacts" | "companies" | "deals" | "tickets";

export const HUBSPOT_DEFAULT_PROPERTIES: Record<HubSpotObjectType, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company"],
  companies: ["name", "domain", "city", "industry", "numberofemployees"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
  tickets: ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority"],
};

export type HubSpotFilter = {
  propertyName: string;
  operator: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE" | "CONTAINS_TOKEN";
  value: string;
};

export type HubSpotFilterGroup = {
  filters: HubSpotFilter[];
};

export type HubSpotSearchArgs = {
  object_type: HubSpotObjectType;
  filterGroups?: HubSpotFilterGroup[];
  properties?: string[];
  after?: string;
  limit?: number;
  budget_tokens?: number;
};

export type HubSpotRecordArgs = {
  object_type: HubSpotObjectType;
  id: string;
  properties: string[];
};

export type HubSpotSearchResponse = {
  total: number;
  results: Json[];
  paging?: {
    next?: {
      after: string;
      link?: string;
    };
  };
};

export class HubSpotClient {
  constructor(
    private readonly token = process.env.HUBSPOT_ACCESS_TOKEN,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(args: HubSpotSearchArgs): Promise<HubSpotSearchResponse> {
    const url = new URL(`https://api.hubapi.com/crm/v3/objects/${args.object_type}/search`);
    const properties = Array.from(new Set([
      ...(HUBSPOT_DEFAULT_PROPERTIES[args.object_type] ?? []),
      ...(args.properties ?? []),
    ]));

    const body = {
      filterGroups: args.filterGroups ?? [],
      properties,
      after: args.after,
      limit: Math.min(args.limit ?? 30, 100),
    };

    const res = await this.request(url, "POST", body);
    return await res.json() as HubSpotSearchResponse;
  }

  async getRecord(args: HubSpotRecordArgs): Promise<Json> {
    const url = new URL(`https://api.hubapi.com/crm/v3/objects/${args.object_type}/${encodeURIComponent(args.id)}`);
    if (args.properties.length) {
      url.searchParams.set("properties", args.properties.join(","));
    }

    const res = await this.request(url, "GET");
    return await res.json() as Json;
  }

  private async request(url: URL, method: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "contextquant-gateway",
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetcher(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HubSpot API ${res.status}: ${(await res.text()).slice(0, 240)}`);
    return res;
  }
}

/** Render HubSpot CRM search response with receipt and JSONL */
export function renderHubSpotSearch(
  page: HubSpotSearchResponse,
  args: HubSpotSearchArgs,
  maxTokens = args.budget_tokens ?? 1_500,
): string {
  if (!page.results.length) return renderEmptySearch(page, maxTokens);

  const raw = JSON.stringify({ results: page.results, total_count: page.total });
  const baseFields = [
    "id",
    ...(HUBSPOT_DEFAULT_PROPERTIES[args.object_type] ?? []).map((p) => `properties.${p}`),
    "updatedAt",
  ];

  const policy = shape(raw, { fields: baseFields, label: `hubspot ${args.object_type}`, ids: false });
  if (!policy.stats) throw new Error(`HubSpot search payload could not be inspected: ${policy.passthrough ?? "unknown error"}`);
  const withheld = policy.stats.leftOut.length ? policy.stats.leftOut.join(", ") : "none";
  const nextAfter = page.paging?.next?.after;
  const receipt = receiptLines(page, args.object_type, withheld, nextAfter);

  let remainingBudget = maxTokens - tokenCount(receipt.join("\n")) - 1;
  while (remainingBudget >= 64) {
    const result = shape(raw, {
      fields: baseFields,
      maxTokens: remainingBudget,
      label: `hubspot ${args.object_type}`,
      more: nextAfter ? `call hubspot_search with after="${nextAfter}"` : undefined,
      counts: ["properties.industry", "properties.city"],
      ids: false,
    });
    if (!result.stats) throw new Error(`HubSpot search payload could not be shaped: ${result.passthrough ?? "unknown error"}`);
    const text = [...receipt, result.text].join("\n");
    const overflow = tokenCount(text) - maxTokens;
    if (overflow <= 0) return text;
    remainingBudget -= overflow;
  }
  throw new Error("token budget is too small to render the ContextQuant receipt");
}

function receiptLines(page: HubSpotSearchResponse, objectType: string, withheld: string, after?: string): string[] {
  const receipt = [
    `# cq receipt: hubspot_search · object_type=${objectType} · upstream_page=${page.results.length} · total=${page.total}`,
    "# selected fields are shown below; recover omitted record detail with hubspot_get_record(object_type, id, properties)",
    "# not returned by search: engagement history, associated deals/tickets · use dedicated tools before claiming either",
    `# withheld by policy: ${withheld}`,
  ];
  if (after) receipt.push(`# next page available: call hubspot_search with after="${after}"`);
  return receipt;
}

function renderEmptySearch(page: HubSpotSearchResponse, maxTokens: number): string {
  const text = [...receiptLines(page, "records", "none"), "# hubspot records: showing 0 of 0"].join("\n");
  if (tokenCount(text) > maxTokens) throw new Error("token budget is too small to render the ContextQuant receipt");
  return text;
}

/** Project record detail response to requested properties */
export function renderHubSpotRecord(record: Json, properties: string[]): string {
  const object = record as Record<string, Json>;
  const rawProps = (object.properties as Record<string, Json>) ?? {};
  const out: Record<string, Json> = { id: object.id ?? null };

  const propsOut: Record<string, Json> = {};
  for (const prop of properties) {
    propsOut[prop] = rawProps[prop] ?? null;
  }
  out.properties = propsOut;

  return JSON.stringify(out);
}

function tokenCount(text: string): number {
  return o200k.count(text);
}

export const hubspotAdapter: Adapter = {
  id: "hubspot",
  searchToolName: "hubspot_search",
  detailToolName: "hubspot_get_record",
  async executeSearch(args: unknown, auth?: ProviderAuth): Promise<ProviderPage> {
    const searchArgs = args as HubSpotSearchArgs;
    const client = new HubSpotClient(auth?.token as string | undefined);
    const page = await client.search(searchArgs);

    return {
      payload: page as unknown as Json,
      recordPath: "results",
      upstreamTotal: page.total,
      next: page.paging?.next?.after
        ? { cursor: page.paging.next.after, argument: "after" }
        : undefined,
      detailRecovery: {
        tool: "hubspot_get_record",
        description: "Recover selected properties from one HubSpot record",
        arguments: { object_type: searchArgs.object_type, id: "<id>", properties: [] },
      },
    };
  },
  async executeDetail(args: unknown, auth?: ProviderAuth): Promise<unknown> {
    const recordArgs = args as HubSpotRecordArgs;
    const client = new HubSpotClient(auth?.token as string | undefined);
    const item = await client.getRecord(recordArgs);
    return JSON.parse(renderHubSpotRecord(item, recordArgs.properties));
  },
  policyFor(args: unknown): AdapterPolicy {
    const searchArgs = args as HubSpotSearchArgs;
    const base = (HUBSPOT_DEFAULT_PROPERTIES[searchArgs.object_type] ?? []).map((p) => `properties.${p}`);
    return {
      baseFields: ["id", ...base, "updatedAt"],
      requestToResponse: {},
      filterFieldPaths(input: unknown) {
        const inp = input as HubSpotSearchArgs;
        return (inp.filterGroups ?? []).flatMap((g) => g.filters.map((f) => `properties.${f.propertyName}`));
      },
      redactedPaths: [],
      defaultBudgetTokens: 1_500,
    };
  },
};
