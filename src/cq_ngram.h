#ifndef CQ_NGRAM_H
#define CQ_NGRAM_H

#include "cq_types.h"
#include "cq_tokenizer.h"
#include <stddef.h>

/*
 * N-gram frequency analysis for ContextQuant.
 *
 * Scans a payload and counts occurrences of every distinct token for the
 * given format.  Only tokens that appear more than once are candidates for
 * symbol substitution.
 *
 * Token saving for a candidate (corrected formula):
 *   per_use_saving = original_tokens - symbol_tokens
 *   net = per_use_saving * frequency - (original_tokens + symbol_tokens + OVERHEAD)
 *
 * Where OVERHEAD accounts for the fixed token cost of the dict line skeleton
 * (" = ''\n" ≈ 4 tokens).
 */

#define CQ_MAX_CANDIDATES 256
#define CQ_MAX_TOKEN_LEN  512

typedef struct {
    char   text[CQ_MAX_TOKEN_LEN];
    size_t length;       /* byte length of text (without delimiters)  */
    size_t frequency;    /* occurrences in the document               */
    int    token_len;    /* token count via supplied tokenizer        */
    long   net_saving;   /* computed saving in tokens                 */
    int    quoted;       /* 1 = token was inside quotes (JSON/CSV)    */
} cq_candidate_t;

typedef struct {
    cq_candidate_t items[CQ_MAX_CANDIDATES];
    size_t         count;
} cq_candidate_list_t;

/*
 * Scan `input` for the given format and populate `out` with candidates
 * sorted by net_saving descending.
 *
 * `intent`    optional (pass NULL for default behaviour).
 * `tok`       optional tokenizer (pass NULL to use cq_tokenizer_default()).
 *
 * Returns the number of candidates found, or -1 on error.
 */
int cq_ngram_scan(const char *input, size_t input_len,
                  cq_format_t fmt, const cq_intent_t *intent,
                  const cq_tokenizer_t *tok,
                  cq_candidate_list_t *out);

#endif /* CQ_NGRAM_H */
