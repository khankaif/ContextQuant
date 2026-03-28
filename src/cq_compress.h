#ifndef CQ_COMPRESS_H
#define CQ_COMPRESS_H

#include "cq_types.h"
#include "cq_dict.h"
#include <stddef.h>

/*
 * ContextQuant compression result.
 */
typedef struct {
    const char *compressed;
    size_t      compressed_len;

    const char *dict_block;
    size_t      dict_block_len;

    size_t      input_tokens;    /* approximate token count of raw input        */
    size_t      output_tokens;   /* approximate token count of output + dict    */
    int         symbol_count;
} cq_result_t;

/*
 * Compress a payload of the given format.
 *
 * `intent` is optional (pass NULL for default behaviour).
 * Thread safety: fully stateless — safe to call concurrently.
 * Returns 0 on success, -1 on error.
 */
int cq_compress(const char        *input,
                size_t             input_len,
                cq_format_t        fmt,
                const cq_intent_t *intent,
                char              *out_buf,
                size_t             out_buf_size,
                char              *dict_buf,
                size_t             dict_buf_size,
                cq_dict_t         *dict_out,
                cq_result_t       *result);

/*
 * Re-expand a compressed payload back to the original.
 * Uses the dict produced by cq_compress.  Format is needed to know whether
 * to re-wrap symbols with quotes on expansion.
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
