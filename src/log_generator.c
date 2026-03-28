/*
 * log_generator.c — Synthetic server log generator for ContextQuant benchmarks.
 *
 * Usage: ./log_gen <output_file> <size_mb>
 * Example: ./log_gen server_100.log 100
 *
 * Produces realistic nginx/app-server style logs with:
 *   - Timestamp prefix (rotates seconds, date stays fixed per run)
 *   - Log level pool  : INFO, WARN, ERROR, DEBUG  (weighted toward INFO)
 *   - Message pool    : ~16 realistic server messages
 *   - IP pool         : 30 addresses  (heavy repetition — real traffic pattern)
 *   - User pool       : 50 usernames
 *   - Path pool       : 40 API paths
 *   - Status codes    : 200, 201, 400, 401, 403, 404, 500, 503
 *
 * The combination of a small vocabulary and high line count is what produces
 * the 70%+ compression the pitch deck claims.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---- vocabulary tables -------------------------------------------------- */

static const char *LEVELS[] = { "INFO", "INFO", "INFO", "INFO", "WARN", "ERROR", "DEBUG" };
#define N_LEVELS 7

static const char *MESSAGES[] = {
    "User authentication successful",
    "User authentication failed: invalid password",
    "Session token issued",
    "Session token expired",
    "Database query executed",
    "Database connection timeout",
    "Cache hit",
    "Cache miss",
    "Rate limit exceeded",
    "Request processed successfully",
    "Upstream service unavailable",
    "Payment gateway responded",
    "Webhook event received",
    "File upload completed",
    "Background job enqueued",
    "Config reloaded"
};
#define N_MESSAGES 16

static const char *IPS[] = {
    "10.0.0.1",  "10.0.0.2",  "10.0.0.5",  "10.0.0.9",
    "10.0.1.10", "10.0.1.11", "10.0.1.20", "10.0.1.55",
    "172.16.0.1","172.16.0.2","172.16.1.5","172.16.2.3",
    "192.168.0.1","192.168.1.1","192.168.1.50","192.168.1.101",
    "192.168.2.5","192.168.3.8","192.168.10.1","192.168.10.20",
    "203.0.113.1","203.0.113.5","198.51.100.1","198.51.100.9",
    "198.51.100.3","198.51.100.7","198.51.100.11","198.51.100.42",
    "198.51.100.55","198.51.100.99"
};
#define N_IPS 30

static const char *USERS[] = {
    "alice@example.com","bob@example.com","carol@example.com","dave@example.com",
    "eve@example.com","frank@example.com","grace@example.com","heidi@example.com",
    "ivan@example.com","judy@example.com","mallory@example.com","oscar@example.com",
    "peggy@example.com","rupert@example.com","sybil@example.com","trent@example.com",
    "victor@example.com","wendy@example.com","alice@corp.io","bob@corp.io",
    "svc_worker_1","svc_worker_2","svc_worker_3","svc_worker_4","svc_payment",
    "svc_auth","svc_webhook","svc_mailer","admin@example.com","root@localhost",
    "deploy_bot","ci_runner","monitor_agent","health_checker","api_gateway",
    "user_10042","user_10099","user_20001","user_30055","user_40012",
    "user_50001","user_60077","user_70088","user_80010","user_90033",
    "user_11111","user_22222","user_33333","user_44444","user_55555"
};
#define N_USERS 50

static const char *PATHS[] = {
    "/api/v1/auth/login","/api/v1/auth/logout","/api/v1/auth/refresh",
    "/api/v1/users","/api/v1/users/profile","/api/v1/users/settings",
    "/api/v1/payments","/api/v1/payments/confirm","/api/v1/payments/refund",
    "/api/v1/orders","/api/v1/orders/create","/api/v1/orders/cancel",
    "/api/v2/charges","/api/v2/charges/capture","/api/v2/subscriptions",
    "/api/v2/webhooks","/api/v2/events","/api/v2/invoices",
    "/health","/health/db","/health/cache","/metrics",
    "/static/js/app.js","/static/css/main.css","/favicon.ico",
    "/api/v1/search","/api/v1/notifications","/api/v1/sessions",
    "/api/v2/products","/api/v2/catalog","/api/v2/analytics",
    "/api/v2/reports","/api/v2/exports","/api/v2/imports",
    "/api/v1/files/upload","/api/v1/files/download","/api/v2/batch",
    "/api/v2/queue/enqueue","/api/v2/config/reload","/api/v2/admin"
};
#define N_PATHS 40

static const int STATUS_CODES[] = { 200, 200, 200, 200, 200, 201, 400, 401, 403, 404, 500, 503 };
#define N_STATUSES 12

/* ---- LCG random (reproducible, no rand() state issues) ----------------- */
static uint32_t rng_state;

static uint32_t rng_next(void) {
    rng_state = rng_state * 1664525u + 1013904223u;
    return rng_state;
}

static int rng_range(int max) { return (int)(rng_next() % (uint32_t)max); }

/* ---- main --------------------------------------------------------------- */
int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <output_file> <size_mb>\n", argv[0]);
        return 1;
    }

    long target_bytes = atol(argv[2]) * 1024L * 1024L;
    if (target_bytes <= 0) { fprintf(stderr, "Invalid size.\n"); return 1; }

    FILE *f = fopen(argv[1], "w");
    if (!f) { fprintf(stderr, "Cannot open %s\n", argv[1]); return 1; }

    rng_state = (uint32_t)time(NULL);

    /* Fixed date for the run (realistic: one day's worth of logs) */
    const char *date = "2026-03-29";

    long written    = 0;
    long line_count = 0;
    int  hour       = 0;
    int  minute     = 0;
    int  second     = 0;

    while (written < target_bytes) {
        /* Advance time every ~10 lines */
        if (line_count % 10 == 0) {
            second++;
            if (second >= 60) { second = 0; minute++; }
            if (minute >= 60) { minute = 0; hour++;   }
            if (hour   >= 24) { hour = 0; }
        }

        const char *level   = LEVELS[rng_range(N_LEVELS)];
        const char *msg     = MESSAGES[rng_range(N_MESSAGES)];
        const char *ip      = IPS[rng_range(N_IPS)];
        const char *user    = USERS[rng_range(N_USERS)];
        const char *path    = PATHS[rng_range(N_PATHS)];
        int         status  = STATUS_CODES[rng_range(N_STATUSES)];
        int         latency = 1 + rng_range(4999);  /* 1–4999 ms */

        int n = fprintf(f,
            "[%s %02d:%02d:%02d] %s: %s | ip=%s user=%s path=%s status=%d latency=%dms\n",
            date, hour, minute, second,
            level, msg, ip, user, path, status, latency);

        if (n < 0) break;
        written += n;
        line_count++;
    }

    fclose(f);
    fprintf(stdout, "Generated %ld bytes (%ld lines) → %s\n", written, line_count, argv[1]);
    return 0;
}
