#include <stdio.h>
#include <string.h>
#include <assert.h>

#include "../src/cq_compress.h"

static void section(const char *t) { printf("\n=== %s ===\n", t); }

/* 20 Stripe-style charge objects with metadata fields */
static const char *charges =
    "[{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":1000,"
    "\"metadata\":{\"internal_id\":\"int_001\",\"source\":\"web\"}},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":2000,"
    "\"metadata\":{\"internal_id\":\"int_002\",\"source\":\"web\"}},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":3000,"
    "\"metadata\":{\"internal_id\":\"int_003\",\"source\":\"mobile\"}},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":4000,"
    "\"metadata\":{\"internal_id\":\"int_004\",\"source\":\"mobile\"}},"
    "{\"object\":\"charge\",\"status\":\"failed\","
    "\"paid\":false,\"currency\":\"usd\",\"amount\":500,"
    "\"metadata\":{\"internal_id\":\"int_005\",\"source\":\"web\"}}]";

/* ---------------------------------------------------------------- NULL intent (baseline) */

static void test_null_intent(void)
{
    section("NULL intent (baseline)");

    char out[8192] = {0}, dict[4096] = {0};
    cq_dict_t   d;
    cq_result_t r;

    int rc = cq_compress(charges, strlen(charges), CQ_FMT_JSON, NULL,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0);

    printf("Symbols: %d\n", r.symbol_count);
    printf("Dict   : %s\n", dict);

    /* metadata key should be in the output */
    assert(strstr(out, "metadata") != NULL || r.symbol_count > 0);
    printf("Output contains metadata: %s\n",
           strstr(out, "metadata") ? "yes" : "(symbolised)");
}

/* ---------------------------------------------------------------- drop_keys */

static void test_drop_keys(void)
{
    section("drop_keys: remove metadata");

    const char *drops[] = { "metadata" };
    cq_intent_t intent = {
        .keep_keys  = NULL, .keep_count = 0,
        .drop_keys  = drops, .drop_count = 1
    };

    char out[8192] = {0}, dict[4096] = {0};
    cq_dict_t   d;
    cq_result_t r;

    int rc = cq_compress(charges, strlen(charges), CQ_FMT_JSON, &intent,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0);

    printf("Symbols: %d\n", r.symbol_count);
    printf("Output (first 200 chars): %.200s\n", out);

    /* metadata key-value pair must be absent from output */
    assert(strstr(out, "\"metadata\"") == NULL &&
           "drop_key 'metadata' still present in output");
    /* internal_id should also be gone (it was nested under metadata) */
    assert(strstr(out, "internal_id") == NULL &&
           "nested content of dropped key still present");
    printf("drop_keys: PASS — 'metadata' and nested content removed\n");
}

/* ---------------------------------------------------------------- keep_keys */

static void test_keep_keys(void)
{
    section("keep_keys: prioritise status + currency");

    /* Intentionally low-frequency input so status/currency would not normally
     * hit the net_saving threshold without the boost.                        */
    const char *small =
        "{\"object\":\"charge\",\"status\":\"succeeded\","
        "\"currency\":\"usd\",\"amount\":1000,\"desc\":\"one-time\"},"
        "{\"object\":\"charge\",\"status\":\"succeeded\","
        "\"currency\":\"usd\",\"amount\":2000,\"desc\":\"one-time\"},"
        "{\"object\":\"charge\",\"status\":\"failed\","
        "\"currency\":\"eur\",\"amount\":500,\"desc\":\"retry\"}";

    /* Without keep — check what symbols we get */
    char out_base[4096] = {0}, dict_base[2048] = {0};
    cq_dict_t d0; cq_result_t r0;
    cq_compress(small, strlen(small), CQ_FMT_JSON, NULL,
                out_base, sizeof(out_base), dict_base, sizeof(dict_base), &d0, &r0);
    printf("Without keep_keys: symbols=%d  dict=%s\n", r0.symbol_count, dict_base);

    /* With keep_keys for status and currency */
    const char *keeps[] = { "status", "currency" };
    cq_intent_t intent = {
        .keep_keys  = keeps, .keep_count = 2,
        .drop_keys  = NULL,  .drop_count = 0
    };

    char out[4096] = {0}, dict[2048] = {0};
    cq_dict_t d; cq_result_t r;
    int rc = cq_compress(small, strlen(small), CQ_FMT_JSON, &intent,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0);
    printf("With keep_keys   : symbols=%d  dict=%s\n", r.symbol_count, dict);

    /* After boost, "succeeded", "usd"/"eur" should appear in the dict */
    int found_status_val  = strstr(dict, "succeeded") != NULL ||
                            strstr(dict, "failed")    != NULL;
    int found_currency_val = strstr(dict, "usd") != NULL ||
                             strstr(dict, "eur") != NULL;
    printf("keep_keys boost → status values in dict: %s\n",
           found_status_val ? "yes" : "no");
    printf("keep_keys boost → currency values in dict: %s\n",
           found_currency_val ? "yes" : "no");
    assert(found_status_val   && "keep_keys: status values missing from dict");
    assert(found_currency_val && "keep_keys: currency values missing from dict");
    printf("keep_keys: PASS\n");
}

/* ---------------------------------------------------------------- combined  */

static void test_combined(void)
{
    section("combined: drop metadata + keep status/currency");

    const char *drops[] = { "metadata" };
    const char *keeps[] = { "status", "currency" };
    cq_intent_t intent = {
        .keep_keys  = keeps, .keep_count = 2,
        .drop_keys  = drops, .drop_count = 1
    };

    char out[8192] = {0}, dict[4096] = {0};
    cq_dict_t d; cq_result_t r;

    int rc = cq_compress(charges, strlen(charges), CQ_FMT_JSON, &intent,
                         out, sizeof(out), dict, sizeof(dict), &d, &r);
    assert(rc == 0);

    assert(strstr(out, "\"metadata\"") == NULL && "metadata not dropped");
    printf("Symbols: %d  (metadata removed, status/currency boosted)\n",
           r.symbol_count);
    printf("Dict   : %s\n", dict);
    printf("combined: PASS\n");
}

/* ---------------------------------------------------------------- main      */

int main(void)
{
    printf("ContextQuant — Intent Test Suite\n");

    test_null_intent();
    test_drop_keys();
    test_keep_keys();
    test_combined();

    printf("\nAll intent tests passed.\n");
    return 0;
}
