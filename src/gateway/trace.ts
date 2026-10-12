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
  omittedRows: number;
  withheldFieldCount: number;
  recoveryKind?: "next_page" | "detail";
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
