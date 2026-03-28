#ifndef CQ_NGRAM_H
#define CQ_NGRAM_H

#include "cq_types.h"
#include <stddef.h>

/*
 * N-gram frequency analysis for ContextQuant.
 *
 * Scans a payload and counts occurrences of every distinct token for the
 * given format.  Only tokens that appear more than once are candidates for
 * symbol substitution.
 *
 * Token saving for a candidate:
 *   (token_len - 1) * frequency - token_len - SYNTAX_OVERHEAD
 */

#define CQ_MAX_CANDIDATES 256
#define CQ_MAX_TOKEN_LEN  512

typedef struct {
    char   text[CQ_MAX_TOKEN_LEN];
    size_t length;       /* byte length of text (without delimiters)  */
    size_t frequency;    /* occurrences in the document               */
    int    token_len;    /* approximate GPT token count               */
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
 * Returns the number of candidates found, or -1 on error.
 */
int cq_ngram_scan(const char *input, size_t input_len,
                  cq_format_t fmt,
                  cq_candidate_list_t *out);

/*
 * Approximate token count for a UTF-8 string (~4 bytes/token heuristic).
 */
int cq_approx_token_count(const char *str, size_t len);

#endif /* CQ_NGRAM_H */
