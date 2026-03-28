#include <stdio.h>
#include <string.h>
#include <assert.h>

#include "../src/cq_compress.h"

/* ------------------------------------------------------------------ helpers */

static void section(const char *t) { printf("\n=== %s ===\n", t); }

static void roundtrip_check(const char *input, size_t input_len,
                            cq_format_t fmt, const char *label)
{
    char out[32768] = {0}, dict[8192] = {0}, exp[32768] = {0};
    cq_dict_t d; cq_result_t r; size_t elen = 0;

    int rc = cq_compress(input, input_len, fmt,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0);

    rc = cq_expand(out, r.compressed_len, fmt, &d, exp, sizeof(exp), &elen);
    assert(rc == 0);

    int match = (elen == input_len && memcmp(exp, input, input_len) == 0);

    long saved = (long)r.input_tokens - (long)r.output_tokens;
    int  pct   = r.input_tokens ? (int)(saved * 100 / (long)r.input_tokens) : 0;

    printf("[%s] symbols=%d  saving=%d%%  round-trip=%s\n",
           label, r.symbol_count, pct, match ? "PASS" : "FAIL");
    assert(match && "round-trip mismatch");
}

/* ------------------------------------------------------------------ JSON    */

static void test_json(void)
{
    section("JSON");

    /* 20 repeated Stripe-style charge objects */
    const char *row =
        "{\"object\":\"charge\",\"status\":\"succeeded\","
        "\"paid\":true,\"currency\":\"usd\",\"amount\":1000},";
    char buf[8192] = "[";
    size_t p = 1;
    for (int i = 0; i < 20; i++) { size_t n = strlen(row); memcpy(buf+p, row, n); p += n; }
    if (buf[p-1] == ',') p--;
    buf[p++] = ']'; buf[p] = '\0';

    roundtrip_check(buf, p, CQ_FMT_JSON, "batch charges");

    /* Passthrough: no repeated strings */
    const char *solo = "{\"a\":\"b\",\"c\":\"d\",\"e\":\"f\"}";
    char out[4096] = {0}, dict[4096] = {0};
    cq_dict_t d; cq_result_t r;
    int rc = cq_compress(solo, strlen(solo), CQ_FMT_JSON,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0 && r.symbol_count == 0 && strcmp(solo, out) == 0);
    printf("[passthrough] symbols=0  round-trip=PASS\n");
}

/* ------------------------------------------------------------------ CSV     */

static void test_csv(void)
{
    section("CSV");

    /* 15 rows, repeated columns values */
    const char *csv =
        "txn_id,status,currency,gateway,amount\n"
        "TXN_001,PENDING,USD,STRIPE,100.00\n"
        "TXN_002,COMPLETED,USD,STRIPE,250.00\n"
        "TXN_003,PENDING,EUR,PAYPAL,75.50\n"
        "TXN_004,COMPLETED,USD,STRIPE,180.00\n"
        "TXN_005,PENDING,USD,STRIPE,320.00\n"
        "TXN_006,COMPLETED,EUR,PAYPAL,90.00\n"
        "TXN_007,PENDING,USD,STRIPE,445.00\n"
        "TXN_008,COMPLETED,USD,STRIPE,60.00\n"
        "TXN_009,PENDING,EUR,PAYPAL,210.00\n"
        "TXN_010,COMPLETED,USD,STRIPE,130.00\n"
        "TXN_011,PENDING,USD,STRIPE,520.00\n"
        "TXN_012,COMPLETED,EUR,PAYPAL,88.00\n"
        "TXN_013,PENDING,USD,STRIPE,940.00\n"
        "TXN_014,COMPLETED,USD,STRIPE,77.00\n"
        "TXN_015,PENDING,EUR,PAYPAL,305.00\n";

    roundtrip_check(csv, strlen(csv), CQ_FMT_CSV, "transactions");

    /* CSV with quoted fields */
    const char *qcsv =
        "name,city,status\n"
        "\"Alice\",\"New York\",\"ACTIVE\"\n"
        "\"Bob\",\"New York\",\"ACTIVE\"\n"
        "\"Carol\",\"New York\",\"INACTIVE\"\n"
        "\"Dave\",\"San Francisco\",\"ACTIVE\"\n"
        "\"Eve\",\"New York\",\"ACTIVE\"\n";

    roundtrip_check(qcsv, strlen(qcsv), CQ_FMT_CSV, "quoted fields");
}

/* ------------------------------------------------------------------ LOG     */

static void test_log(void)
{
    section("LOG");

    const char *line =
        "[2026-03-29 10:00:01] INFO: User authentication successful"
        " | ip=192.168.1.101 user=alice@example.com"
        " path=/api/v1/auth/login status=200 latency=12ms\n";

    /* Repeat 30 times */
    char buf[16384] = {0};
    size_t p = 0, llen = strlen(line);
    for (int i = 0; i < 30; i++) { memcpy(buf + p, line, llen); p += llen; }

    roundtrip_check(buf, p, CQ_FMT_LOG, "server log");
}

/* ------------------------------------------------------------------ CODE    */

static void test_code(void)
{
    section("CODE");

    const char *code =
        "import React from 'react';\n"
        "import React from 'react';\n"
        "import React from 'react';\n"
        "import { useState } from 'react';\n"
        "import { useState } from 'react';\n"
        "import { useState } from 'react';\n"
        "\n"
        "function handleClick() { console.log('clicked'); }\n"
        "function handleClick() { console.log('clicked'); }\n"
        "function handleClick() { console.log('clicked'); }\n"
        "function handleSubmit() { console.log('submitted'); }\n"
        "function handleSubmit() { console.log('submitted'); }\n"
        "function handleSubmit() { console.log('submitted'); }\n"
        "\n"
        "const className = 'flex items-center justify-between p-4';\n"
        "const className = 'flex items-center justify-between p-4';\n"
        "const className = 'flex items-center justify-between p-4';\n"
        "const className = 'flex items-center justify-between p-4';\n";

    roundtrip_check(code, strlen(code), CQ_FMT_CODE, "react component");
}

/* ------------------------------------------------------------------ main    */

int main(void)
{
    printf("ContextQuant — Test Suite\n");

    test_json();
    test_csv();
    test_log();
    test_code();

    printf("\nAll tests passed.\n");
    return 0;
}
