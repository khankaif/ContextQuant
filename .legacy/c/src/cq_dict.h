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
 * Symbol schemes and their token costs per symbol:
 *
 *   CQ_SYM_PUA_UNICODE   (default) — U+E000..U+E0FF encoded as 3-byte UTF-8.
 *     Each codepoint is a single BPE token in both cl100k_base and Claude's
 *     tokenizer.  Gives the highest per-symbol token savings.
 *     Symbol bytes: 0xEE, 0x80+(id>>6), 0x80+(id&0x3F)  (256 slots)
 *
 *   CQ_SYM_TILDE_ALPHA   — ~A..~Z, ~a..~z, ~0..~9 (62 slots).
 *     Each is exactly 2 tokens ("~" + letter/digit).  Human-readable.
 *     Use when your pipeline doesn't handle non-ASCII symbol bytes.
 *
 *   CQ_SYM_CARET_DECIMAL — ^0..^255 legacy format (2-4 tokens).
 *     Kept for backward compatibility with cached dict blocks.
 */

typedef enum {
    CQ_SYM_PUA_UNICODE   = 0,  /* U+E000..U+E0FF, 1 token each  (default) */
    CQ_SYM_TILDE_ALPHA   = 1,  /* ~A..~Z ~a..~z ~0..~9, 2 tokens, 62 max */
    CQ_SYM_CARET_DECIMAL = 2,  /* ^0..^255, 2-4 tokens, legacy            */
} cq_symbol_scheme_t;

#define CQ_MAX_SYMBOLS 256  /* hard cap; keeps dictionary block manageable */

/* Slots available per scheme */
#define CQ_SYM_PUA_MAX    256
#define CQ_SYM_TILDE_MAX   62
#define CQ_SYM_CARET_MAX  256

typedef struct {
    int    symbol_id;                  /* 0-based index                        */
    char   original[CQ_MAX_TOKEN_LEN]; /* the string this symbol replaces      */
    size_t original_len;
    int    quoted;                     /* 1 = re-wrap with '"' on expansion     */
} cq_symbol_t;

typedef struct {
    cq_symbol_t        entries[CQ_MAX_SYMBOLS];
    size_t             count;
    cq_symbol_scheme_t scheme;         /* scheme used to emit/expand symbols   */
} cq_dict_t;

/*
 * Build a dictionary from the top candidates in `list`.
 * scheme sets the symbol format; pass CQ_SYM_PUA_UNICODE (0) for default.
 * Returns number of symbols assigned, or -1 on error.
 */
int cq_dict_build(const cq_candidate_list_t *list, cq_symbol_scheme_t scheme,
                  cq_dict_t *dict);

/*
 * Render the dictionary as a plain-text block for LLM system prompt injection.
 *
 * Output format (one line per symbol, actual symbol bytes in output):
 *   <sym> = 'original_string'
 *
 * For CQ_SYM_PUA_UNICODE the symbol is 3 raw UTF-8 bytes; for TILDE_ALPHA it
 * is 2 ASCII chars; for CARET_DECIMAL it is "^N".
 *
 * Writes into `buf` (caller-owned).  Returns bytes written or -1 if too small.
 */
int cq_dict_render(const cq_dict_t *dict, char *buf, size_t buf_size);

/*
 * Look up a symbol id by original string.  Returns -1 if not found.
 */
int cq_dict_lookup(const cq_dict_t *dict, const char *text, size_t len);

/*
 * Write the symbol bytes for slot `sym_id` under `dict->scheme` into `buf`.
 * buf must be at least 4 bytes.  Returns number of bytes written.
 */
int cq_dict_emit_symbol_bytes(const cq_dict_t *dict, int sym_id,
                              char *buf, size_t buf_size);

#endif /* CQ_DICT_H */
