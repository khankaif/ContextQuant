#include "cq_ngram.h"

#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* --------------------------------------------------------------------------
 * Token-count heuristic
 * --------------------------------------------------------------------------
 * GPT-family tokenisers average ~4 bytes per token for English/JSON text.
 * We round up so we never over-count savings.
 */
int cq_approx_token_count(const char *str, size_t len)
{
    if (len == 0) return 0;
    return (int)((len + 3) / 4);   /* ceil(len / 4) */
}

/* --------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------- */

/*
 * Syntax-only overhead (in tokens) of adding one dict entry: "^N = '...'\n"
 * The "^N" + " = " + "'" + "'" + "\n" is roughly 2 tokens of punctuation.
 * The value itself is accounted for separately in the savings formula.
 */
#define CQ_DICT_SYNTAX_TOKENS 2

/* Find an existing candidate by text; returns index or -1. */
static int find_candidate(cq_candidate_list_t *list, const char *text, size_t len)
{
    for (size_t i = 0; i < list->count; i++) {
        if (list->items[i].length == len &&
            memcmp(list->items[i].text, text, len) == 0) {
            return (int)i;
        }
    }
    return -1;
}

/* Insert or increment a candidate. */
static void record_token(cq_candidate_list_t *list, const char *text, size_t len)
{
    if (len == 0 || len >= CQ_MAX_TOKEN_LEN) return;

    int idx = find_candidate(list, text, len);
    if (idx >= 0) {
        list->items[idx].frequency++;
        return;
    }

    if (list->count >= CQ_MAX_CANDIDATES) return;   /* table full */

    cq_candidate_t *c = &list->items[list->count++];
    memcpy(c->text, text, len);
    c->text[len] = '\0';
    c->length    = len;
    c->frequency = 1;
    c->token_len = cq_approx_token_count(text, len);
    c->net_saving = 0;   /* computed after scanning */
}

/* --------------------------------------------------------------------------
 * Minimal JSON string extractor.
 *
 * We walk the input byte-by-byte.  Whenever we find a '"'-delimited span we
 * extract the raw content (without surrounding quotes, without unescaping —
 * we want byte-identical re-insertion later) and record it.
 *
 * We intentionally ignore numbers and booleans here; they are short and
 * rarely repeated enough to justify dictionary entries.  A future version
 * can add them.
 * -------------------------------------------------------------------------- */
static void extract_json_strings(const char *input, size_t input_len,
                                  cq_candidate_list_t *out)
{
    size_t i = 0;
    while (i < input_len) {
        if (input[i] == '"') {
            /* find the closing quote, honouring backslash escapes */
            size_t start = i + 1;
            size_t j = start;
            while (j < input_len) {
                if (input[j] == '\\') {
                    j += 2;   /* skip escaped char */
                    continue;
                }
                if (input[j] == '"') break;
                j++;
            }
            if (j < input_len) {   /* well-formed closing quote */
                record_token(out, input + start, j - start);
            }
            i = j + 1;
        } else {
            i++;
        }
    }
}

/* --------------------------------------------------------------------------
 * Comparator for qsort: sort by net_saving descending.
 * -------------------------------------------------------------------------- */
static int cmp_by_saving(const void *a, const void *b)
{
    const cq_candidate_t *ca = (const cq_candidate_t *)a;
    const cq_candidate_t *cb = (const cq_candidate_t *)b;
    if (cb->net_saving > ca->net_saving) return  1;
    if (cb->net_saving < ca->net_saving) return -1;
    return 0;
}

/* --------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */
int cq_ngram_scan(const char *input, size_t input_len,
                  cq_candidate_list_t *out)
{
    if (!input || !out) return -1;

    memset(out, 0, sizeof(*out));

    extract_json_strings(input, input_len, out);

    /* Compute net saving and drop non-beneficial candidates.
     *
     * Formula (all values in tokens):
     *   payload_saving = (token_len - 1) * frequency
     *     Each occurrence shrinks from token_len tokens to 1 token (the symbol).
     *   dict_cost = token_len + CQ_DICT_SYNTAX_TOKENS
     *     One dict entry: value_tokens + ~2 tokens of surrounding syntax.
     *   net_saving = payload_saving - dict_cost
     *              = (token_len - 1) * frequency - token_len - SYNTAX_TOKENS
     */
    size_t kept = 0;
    for (size_t i = 0; i < out->count; i++) {
        cq_candidate_t *c = &out->items[i];
        if (c->frequency < 2) continue;   /* no saving possible */

        long payload_saving = (long)(c->token_len - 1) * (long)c->frequency;
        long dict_cost      = (long)c->token_len + (long)CQ_DICT_SYNTAX_TOKENS;
        c->net_saving = payload_saving - dict_cost;

        if (c->net_saving <= 0) continue;  /* not worth it */

        if (kept != i) out->items[kept] = out->items[i];
        kept++;
    }
    out->count = kept;

    qsort(out->items, out->count, sizeof(cq_candidate_t), cmp_by_saving);

    return (int)out->count;
}
