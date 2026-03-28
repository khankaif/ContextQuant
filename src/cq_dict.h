#ifndef CQ_DICT_H
#define CQ_DICT_H

#include "cq_ngram.h"
#include <stddef.h>

/*
 * Dictionary builder.
 *
 * Takes the ranked candidate list from cq_ngram_scan and produces:
 *   1. A symbol table (array of symbol → original string mappings)
 *   2. A human-readable dictionary block suitable for LLM system prompt injection
 *
 * Symbol format:  ^0, ^1, ^2, … ^N   (up to CQ_MAX_SYMBOLS)
 * Chosen because:
 *   - Visually distinct from JSON syntax
 *   - Two characters = ~1 token in GPT tokenisers
 *   - Easy to regex-replace during re-expansion
 */

#define CQ_MAX_SYMBOLS 256  /* hard cap; keeps dictionary block manageable */

typedef struct {
    int    symbol_id;                  /* 0-based index → symbol "^0", "^1", … */
    char   original[CQ_MAX_TOKEN_LEN]; /* the string this symbol replaces      */
    size_t original_len;
    int    quoted;                     /* 1 = re-wrap with '"' on expansion     */
} cq_symbol_t;

typedef struct {
    cq_symbol_t entries[CQ_MAX_SYMBOLS];
    size_t      count;
} cq_dict_t;

/*
 * Build a dictionary from the top candidates in `list`.
 * Caps at CQ_MAX_SYMBOLS entries (top savers win).
 * Populates `dict`.  Returns number of symbols assigned.
 */
int cq_dict_build(const cq_candidate_list_t *list, cq_dict_t *dict);

/*
 * Render the dictionary as a plain-text block for LLM system prompt injection.
 *
 * Output format (one line per symbol):
 *   ^0 = 'original_string'
 *   ^1 = 'another_string'
 *   ...
 *
 * Writes into `buf` (caller-owned, must be at least `buf_size` bytes).
 * Returns bytes written (not including null terminator), or -1 if buf too small.
 */
int cq_dict_render(const cq_dict_t *dict, char *buf, size_t buf_size);

/*
 * Look up a symbol id by original string.  Returns -1 if not found.
 */
int cq_dict_lookup(const cq_dict_t *dict, const char *text, size_t len);

#endif /* CQ_DICT_H */
