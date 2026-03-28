#include <stdio.h>
#include <string.h>
#include <assert.h>

#include "../src/cq_compress.h"

/* ------------------------------------------------------------------ helpers */

static void print_section(const char *title) {
    printf("\n=== %s ===\n", title);
}

/* ------------------------------------------------------------------ tests   */

static void test_basic_json(void)
{
    print_section("Basic JSON compression");

    /*
     * Simulate a Stripe-style batch payload: 20 charge objects.
     * Keys "object", "status", "succeeded", "currency", "usd" repeat heavily —
     * exactly the pattern that appears in real API response arrays.
     */
    const char *row =
        "{\"object\":\"charge\",\"status\":\"succeeded\","
        "\"paid\":true,\"currency\":\"usd\",\"amount\":1000},";

    /* Build a repeated payload */
    char big_input[8192] = "[";
    size_t pos = 1;
    for (int i = 0; i < 20 && pos + strlen(row) + 2 < sizeof(big_input); i++) {
        memcpy(big_input + pos, row, strlen(row));
        pos += strlen(row);
    }
    /* overwrite trailing comma with ] */
    if (big_input[pos - 1] == ',') pos--;
    big_input[pos++] = ']';
    big_input[pos]   = '\0';

    const char *input    = big_input;
    size_t      input_len = pos;

    char out_buf[4096]  = {0};
    char dict_buf[4096] = {0};
    cq_dict_t    dict;
    cq_result_t  result;

    int rc = cq_compress(input, input_len,
                         out_buf, sizeof(out_buf),
                         dict_buf, sizeof(dict_buf),
                         &dict, &result);

    assert(rc == 0 && "cq_compress failed");

    printf("Input  (%zu bytes, ~%zu tokens):\n  %s\n",
           input_len, result.input_tokens, input);
    printf("\nDictionary block:\n%s", dict_buf);
    printf("\nCompressed (%zu bytes, ~%zu tokens):\n  %s\n",
           result.compressed_len, result.output_tokens, out_buf);

    long saved = (long)result.input_tokens - (long)result.output_tokens;
    int  pct   = (result.input_tokens > 0)
                 ? (int)(saved * 100 / (long)result.input_tokens)
                 : 0;
    printf("\nToken saving: %ld tokens (%d%%)\n", saved, pct);
    printf("Symbols used: %d\n", result.symbol_count);
}

static void test_roundtrip(void)
{
    print_section("Round-trip (compress → expand)");

    const char *input =
        "{\"status\":\"succeeded\",\"status\":\"succeeded\","
        "\"currency\":\"usd\",\"currency\":\"usd\",\"currency\":\"usd\"}";

    size_t input_len = strlen(input);

    char out_buf[4096]  = {0};
    char dict_buf[4096] = {0};
    cq_dict_t    dict;
    cq_result_t  result;

    int rc = cq_compress(input, input_len,
                         out_buf, sizeof(out_buf),
                         dict_buf, sizeof(dict_buf),
                         &dict, &result);
    assert(rc == 0);

    char expanded[4096] = {0};
    size_t expanded_len = 0;
    rc = cq_expand(out_buf, result.compressed_len,
                   &dict,
                   expanded, sizeof(expanded),
                   &expanded_len);
    assert(rc == 0 && "cq_expand failed");

    printf("Original : %s\n", input);
    printf("Expanded : %s\n", expanded);

    int match = (expanded_len == input_len &&
                 memcmp(expanded, input, input_len) == 0);
    printf("Round-trip match: %s\n", match ? "PASS" : "FAIL");
    assert(match && "Round-trip mismatch");
}

static void test_no_candidates(void)
{
    print_section("No repeated strings (nothing to compress)");

    const char *input = "{\"a\":\"b\",\"c\":\"d\",\"e\":\"f\"}";
    size_t input_len  = strlen(input);

    char out_buf[4096]  = {0};
    char dict_buf[4096] = {0};
    cq_dict_t    dict;
    cq_result_t  result;

    int rc = cq_compress(input, input_len,
                         out_buf, sizeof(out_buf),
                         dict_buf, sizeof(dict_buf),
                         &dict, &result);
    assert(rc == 0);

    printf("Symbol count: %d (expected 0)\n", result.symbol_count);
    printf("Input  : %s\n", input);
    printf("Output : %s\n", out_buf);

    /* Output should be identical to input when nothing is compressed. */
    assert(strcmp(input, out_buf) == 0 && "Expected passthrough when no candidates");
    printf("Passthrough: PASS\n");
}

/* ------------------------------------------------------------------ main    */

int main(void)
{
    printf("ContextQuant C Core — Unit Tests\n");

    test_basic_json();
    test_roundtrip();
    test_no_candidates();

    printf("\nAll tests passed.\n");
    return 0;
}
