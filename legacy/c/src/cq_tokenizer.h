#ifndef CQ_TOKENIZER_H
#define CQ_TOKENIZER_H

#include <stddef.h>

/*
 * cq_tokenizer.h — pluggable BPE tokenizer interface for ContextQuant.
 *
 * The tokenizer is used to score compression candidates by their actual token
 * cost rather than a byte-length heuristic.  Pass NULL wherever a tokenizer
 * is accepted to use cq_tokenizer_default().
 *
 * To integrate a real tokenizer (tiktoken, claude-tokenizer, etc.) build a
 * cq_tokenizer_t around a thin FFI wrapper and pass it to cq_compress_opts_t.
 */

typedef struct {
    /*
     * count_tokens — return the number of BPE tokens in str[0..len).
     * Must return >= 1 for any non-empty string.
     * Called millions of times during a scan — must be fast.
     */
    int        (*count_tokens)(const char *str, size_t len, void *userdata);

    /*
     * symbol_tokens — token cost of one substitution symbol in the output.
     *   1  for CQ_SYM_PUA_UNICODE  (single BPE token per PUA codepoint)
     *   2  for CQ_SYM_TILDE_ALPHA  (~A, ~B … each 2 tokens)
     *   2+ for CQ_SYM_CARET_DECIMAL (^0 = 2, ^10 = 3, ^100 = 4)
     *
     * Used in the net-saving formula:
     *   per_use_saving = original_tokens - symbol_tokens
     *   net = per_use_saving * frequency - (original_tokens + symbol_tokens + OVERHEAD)
     */
    int          symbol_tokens;

    void        *userdata;  /* forwarded to count_tokens; NULL for built-ins */
    const char  *name;      /* diagnostic label; must be a string literal    */
} cq_tokenizer_t;

/*
 * cq_tokenizer_default — built-in character-class weighted BPE approximation.
 *
 * Replaces the old (len+3)/4 heuristic with a per-character-class weighted
 * sum that more accurately models cl100k_base / claude tokenizer behaviour
 * on structured data (JSON keys, log tokens, CSV fields, identifiers).
 *
 * symbol_tokens = 1 (matched to CQ_SYM_PUA_UNICODE, the default scheme).
 * name = "heuristic_v2_char_class"
 *
 * This is still an approximation.  For production token-accuracy, supply
 * a real tokenizer via cq_compress_opts_t.
 */
const cq_tokenizer_t *cq_tokenizer_default(void);

#endif /* CQ_TOKENIZER_H */
