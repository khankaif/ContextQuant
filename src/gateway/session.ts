export type RecoveryContext = {
  sessionId: string;
  expiresAt: number;
  adapter: string;
  providerScope: Record<string, string>;
  allowedFields: string[];
  redactedPaths: string[];
};

export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class SessionStore {
  private readonly sessions = new Map<string, RecoveryContext>();

  constructor(private readonly ttlMs = DEFAULT_SESSION_TTL_MS) {}

  register(
    sessionId: string,
    adapter: string,
    providerScope: Record<string, string>,
    allowedFields: string[],
    redactedPaths: string[] = [],
  ): RecoveryContext {
    this.purgeExpired();
    const context: RecoveryContext = {
      sessionId,
      expiresAt: Date.now() + this.ttlMs,
      adapter,
      providerScope: { ...providerScope },
      allowedFields: [...allowedFields],
      redactedPaths: [...redactedPaths],
    };
    this.sessions.set(sessionId, context);
    return context;
  }

  get(sessionId: string): RecoveryContext | undefined {
    this.purgeExpired();
    return this.sessions.get(sessionId);
  }

  validateRecovery(
    sessionId: string,
    adapter: string,
    targetScope: Record<string, string>,
    requestedFields: string[],
  ): { valid: true } | { valid: false; reason: string } {
    this.purgeExpired();
    const context = this.sessions.get(sessionId);
    if (!context) {
      return { valid: false, reason: "session not found or expired" };
    }

    if (context.adapter !== adapter) {
      return {
        valid: false,
        reason: `recovery adapter mismatch: expected ${context.adapter}, got ${adapter}`,
      };
    }

    for (const [key, value] of Object.entries(context.providerScope)) {
      if (targetScope[key] !== value) {
        return {
          valid: false,
          reason: `scope mismatch for ${key}: expected ${value}, got ${targetScope[key] ?? "undefined"}`,
        };
      }
    }

    for (const field of requestedFields) {
      if (context.redactedPaths.includes(field)) {
        return {
          valid: false,
          reason: `field '${field}' is permanently redacted by policy and cannot be recovered`,
        };
      }
      if (!context.allowedFields.includes(field)) {
        return {
          valid: false,
          reason: `field '${field}' is not in the allowed recovery field list`,
        };
      }
    }

    return { valid: true };
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [id, ctx] of this.sessions.entries()) {
      if (ctx.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }

  size(): number {
    this.purgeExpired();
    return this.sessions.size;
  }
}

export const defaultSessionStore = new SessionStore();
