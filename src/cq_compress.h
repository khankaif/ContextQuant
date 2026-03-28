#ifndef CQ_COMPRESS_H
#define CQ_COMPRESS_H

#include "cq_dict.h"
#include <stddef.h>

/*
 * ContextQuant compression result.
 *
 * All pointers are into caller-supplied buffers or the input string.
 * The caller owns all memory.
 */
typedef struct {
    const char *compressed;       /* null-terminated compressed payload      */
    size_t      compressed_len;

    const char *dict_block;       /* null-terminated dictionary prompt block */
    size_t      dict_block_len;

    size_t      input_tokens;     /* approximate token count of raw input    */
    size_t      output_tokens;    /* approximate token count of compressed   */
                                  /*   output + dict block combined          */
    int         symbol_count;     /* number of symbols in the dictionary     */
} cq_result_t;

/*
 * Compress a JSON payload.
 *
 * Parameters:
 *   input          Null-terminated JSON string.
 *   input_len      Byte length of input (excluding null terminator).
 *   out_buf        Caller-supplied buffer for the compressed output.
 *   out_buf_size   Size of out_buf in bytes.
 *   dict_buf       Caller-supplied buffer for the dictionary block.
 *   dict_buf_size  Size of dict_buf in bytes.
 *   dict_out       Populated with the internal dictionary (for re-expansion).
 *   result         Populated with pointers and stats.
 *
 * Returns:
 *    0  success
 *   -1  error (buffer too small, bad input, etc.)
 *
 * Thread safety: fully stateless — safe to call concurrently.
 */
int cq_compress(const char    *input,
                size_t         input_len,
                char          *out_buf,
                size_t         out_buf_size,
                char          *dict_buf,
                size_t         dict_buf_size,
                cq_dict_t     *dict_out,
                cq_result_t   *result);

/*
 * Re-expand a compressed payload back to the original string.
 * Uses the dict produced by cq_compress.
 *
 * Returns 0 on success, -1 on error.
 */
int cq_expand(const char    *compressed,
              size_t         compressed_len,
              const cq_dict_t *dict,
              char          *out_buf,
              size_t         out_buf_size,
              size_t        *out_len);

#endif /* CQ_COMPRESS_H */
