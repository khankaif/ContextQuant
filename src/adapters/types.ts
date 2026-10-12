import type { Json } from "../shape.ts";

export type AdapterId = "github" | "jira" | "hubspot";

export type ProviderAuth = {
  token?: string;
  [key: string]: unknown;
};

export type RecoveryTemplate = {
  tool: string;
  description: string;
  arguments: Record<string, unknown>;
};

export type ProviderPage = {
  payload: Json;
  recordPath: string;
  upstreamTotal?: number;
  next?: { cursor: string; argument: string };
  detailRecovery: RecoveryTemplate;
};

export type AdapterPolicy = {
  baseFields: string[];
  requestToResponse: Record<string, string>;
  filterFieldPaths(args: unknown): string[];
  redactedPaths: string[];
  defaultBudgetTokens: number;
};

export type Adapter = {
  id: AdapterId;
  searchToolName: string;
  detailToolName: string;
  executeSearch(args: unknown, auth?: ProviderAuth): Promise<ProviderPage>;
  executeDetail(args: unknown, auth?: ProviderAuth): Promise<unknown>;
  policyFor(args: unknown): AdapterPolicy;
};

export type ReceiptFields = {
  shown: string[];
  withheld: string[];
  unavailable: string[];
  redacted: string[];
};

export type ReceiptRecovery = {
  kind: "next_page" | "detail";
  tool: string;
  arguments: Record<string, unknown>;
};

export type Receipt = {
  adapter: AdapterId | string;
  requestId: string;
  upstream: { rows: number; total?: number; next?: boolean };
  shownRows: number;
  omittedRows: number;
  fields: ReceiptFields;
  recovery: ReceiptRecovery[];
};
