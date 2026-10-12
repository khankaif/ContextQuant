import { appendFileSync } from "node:fs";

export type TraceOutcome = "shaped" | "passthrough" | "blocked" | "error";

export type TraceEvent = {
  timestamp: string;
  adapter: string;
  tool: string;
  outcome: TraceOutcome;
  inputTokens: number;
  outputTokens: number;
  shownRows: number;
  /** Upstream rows not in this page (reachable by paging). */
  omittedRows: number;
  /** Rows in this page cut by the token budget (reachable only with a bigger budget_tokens). */
  budgetCutRows?: number;
  withheldFieldCount: number;
  recoveryKind?: "next_page" | "budget" | "detail";
  latencyMs: number;
  error?: string;
};

export class TraceWriter {
  private readonly buffer: TraceEvent[] = [];

  constructor(private readonly logFile: string | undefined = process.env.CQ_TRACE_FILE) {}

  emit(event: Omit<TraceEvent, "timestamp">): TraceEvent {
    const fullEvent: TraceEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.buffer.push(fullEvent);
    if (this.buffer.length > 1_000) this.buffer.shift(); // in-memory copy is for tests; the log file keeps everything

    if (this.logFile) {
      try {
        appendFileSync(this.logFile, JSON.stringify(fullEvent) + "\n");
      } catch {
        // Tracing failures should never crash the main request loop
      }
    }

    return fullEvent;
  }

  getEvents(): readonly TraceEvent[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

export const defaultTracer = new TraceWriter();
