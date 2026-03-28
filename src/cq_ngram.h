#ifndef CQ_NGRAM_H
#define CQ_NGRAM_H

#include <stddef.h>

/*
 * N-gram frequency analysis for ContextQuant.
 *
 * Scans a JSON payload and counts occurrences of every distinct string token
 * (object keys, string values, repeated numeric strings).  Only strings that
 * appear more than once are candidates for symbol substitution — a string that
 * appears exactly once costs more tokens with a dictionary entry than it saves.
 *
 * Token saving for a candidate:
 *   raw_tokens(str) * (frequency - 1) - dict_overhead
 * where dict_overhead is the tokens for one dictionary line:
 *   "^N = '<str>'\n"
 */

#define CQ_MAX_CANDIDATES 256
#define CQ_MAX_TOKEN_LEN  512

typedef struct {
    char   text[CQ_MAX_TOKEN_LEN];
    size_t length;       /* byte length of text */
    size_t frequency;    /* how many times it appears in the document */
    int    token_len;    /* approximate GPT token count (byte heuristic) */
    long   net_saving;   /* (token_len * (frequency-1)) - dict_overhead */
} cq_candidate_t;

typedef struct {
    cq_candidate_t items[CQ_MAX_CANDIDATES];
    size_t         count;
} cq_candidate_list_t;

/*
 * Scan `input` (null-terminated JSON string) and populate `out` with
 * candidates sorted by net_saving descending.
 *
 * Returns the number of candidates found, or -1 on error.
 */
int cq_ngram_scan(const char *input, size_t input_len,
                  cq_candidate_list_t *out);

/*
 * Approximate token count for a UTF-8 string using the ~4 bytes/token
 * heuristic (good enough for pre-flight savings estimation).
 */
int cq_approx_token_count(const char *str, size_t len);

#endif /* CQ_NGRAM_H */
