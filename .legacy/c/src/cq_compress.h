#ifndef CQ_COMPRESS_H
#define CQ_COMPRESS_H

#include "cq_types.h"
#include "cq_dict.h"
#include "cq_tokenizer.h"
#include <stddef.h>

/*
 * ContextQuant compression result.
 * Token counts are measured by the tokenizer supplied in cq_compress_opts_t
 * (or cq_tokenizer_default() when opts is NULL).
 */
typedef struct {
    const char *compressed;
    size_t      compressed_len;

    const char *dict_block;
    size_t      dict_block_len;

    size_t      input_tokens;   /* token count of raw input                    */
    size_t      output_tokens;  /* token count of compressed payload + dict    */
    int         symbol_count;
} cq_result_t;

/*
 * Compression options.  All fields are optional — pass NULL to use defaults.
 *
 *   tokenizer   NULL → cq_tokenizer_default() (heuristic_v2_char_class)
 *   scheme      0    → CQ_SYM_PUA_UNICODE (1 token/symbol, highest ROI)
 */
typedef struct {
    const cq_tokenizer_t *tokenizer;
    cq_symbol_scheme_t    scheme;
} cq_compress_opts_t;

/*
 * Compress a payload of the given format.
 *
 * `intent`  optional intent hints (pass NULL for default behaviour).
 * `opts`    optional tokenizer / symbol-scheme overrides (pass NULL for defaults).
 *
 * Thread safety: fully stateless — safe to call concurrently.
 * Returns 0 on success, -1 on error.
 */
int cq_compress(const char             *input,
                size_t                  input_len,
                cq_format_t             fmt,
                const cq_intent_t      *intent,
                const cq_compress_opts_t *opts,
                char                   *out_buf,
                size_t                  out_buf_size,
                char                   *dict_buf,
                size_t                  dict_buf_size,
                cq_dict_t              *dict_out,
                cq_result_t            *result);

/*
 * Re-expand a compressed payload back to the original.
 * Uses the dict produced by cq_compress (including its scheme field).
 *
 * Returns 0 on success, -1 on error.
 */
int cq_expand(const char      *compressed,
              size_t           compressed_len,
              cq_format_t      fmt,
              const cq_dict_t *dict,
              char            *out_buf,
              size_t           out_buf_size,
              size_t          *out_len);

/*
 * Derive format from a file path extension.
 * Falls back to CQ_FMT_JSON for unknown extensions.
 */
cq_format_t cq_format_from_path(const char *path);

#endif /* CQ_COMPRESS_H */
