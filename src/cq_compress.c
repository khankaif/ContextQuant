#include "cq_compress.h"
#include "cq_ngram.h"

#include <string.h>
#include <stdio.h>

/* --------------------------------------------------------------------------
 * Compression
 *
 * Strategy:
 *   1. Scan the input for repeated JSON string tokens (cq_ngram_scan).
 *   2. Build a dictionary of the top-saving candidates (cq_dict_build).
 *   3. Walk the input byte-by-byte; when we hit a quoted string that maps
 *      to a symbol, emit the symbol instead of the quoted string.
 *      Everything else is copied verbatim.
 * -------------------------------------------------------------------------- */

int cq_compress(const char  *input,
                size_t       input_len,
                char        *out_buf,
                size_t       out_buf_size,
                char        *dict_buf,
                size_t       dict_buf_size,
                cq_dict_t   *dict_out,
                cq_result_t *result)
{
    if (!input || !out_buf || !dict_buf || !dict_out || !result) return -1;
    if (out_buf_size < 2 || dict_buf_size < 2) return -1;

    /* --- Step 1: scan for candidates --- */
    cq_candidate_list_t candidates;
    int n = cq_ngram_scan(input, input_len, &candidates);
    if (n < 0) return -1;

    /* --- Step 2: build dictionary --- */
    if (cq_dict_build(&candidates, dict_out) < 0) return -1;

    /* --- Step 3: render dictionary block --- */
    int dict_len = cq_dict_render(dict_out, dict_buf, dict_buf_size);
    if (dict_len < 0) return -1;

    /* --- Step 4: rewrite input, substituting known strings --- */
    size_t in_pos  = 0;
    size_t out_pos = 0;

    while (in_pos < input_len) {
        char ch = input[in_pos];

        if (ch == '"') {
            /* Extract the quoted string span */
            size_t str_start = in_pos + 1;
            size_t j = str_start;
            while (j < input_len) {
                if (input[j] == '\\') { j += 2; continue; }
                if (input[j] == '"')  break;
                j++;
            }

            if (j < input_len) {
                size_t str_len = j - str_start;
                int sym = cq_dict_lookup(dict_out, input + str_start, str_len);

                if (sym >= 0) {
                    /* Emit symbol: ^N  (no surrounding quotes) */
                    int written = snprintf(out_buf + out_pos,
                                           out_buf_size - out_pos,
                                           "^%d", sym);
                    if (written < 0 || (size_t)written >= out_buf_size - out_pos)
                        return -1;
                    out_pos += (size_t)written;
                    in_pos   = j + 1;   /* skip past closing quote */
                    continue;
                }
            }
        }

        /* Default: copy byte verbatim */
        if (out_pos + 1 >= out_buf_size) return -1;
        out_buf[out_pos++] = ch;
        in_pos++;
    }

    out_buf[out_pos] = '\0';

    /* --- Populate result --- */
    result->compressed     = out_buf;
    result->compressed_len = out_pos;
    result->dict_block     = dict_buf;
    result->dict_block_len = (size_t)dict_len;
    result->symbol_count   = (int)dict_out->count;
    result->input_tokens   = (size_t)cq_approx_token_count(input, input_len);
    result->output_tokens  = (size_t)cq_approx_token_count(out_buf, out_pos)
                           + (size_t)cq_approx_token_count(dict_buf, (size_t)dict_len);

    return 0;
}

/* --------------------------------------------------------------------------
 * Re-expansion
 *
 * Walk the compressed string.  When we see "^" followed by one or more
 * digits, look up the symbol id and emit the original string (with quotes).
 * Everything else is copied verbatim.
 * -------------------------------------------------------------------------- */
int cq_expand(const char      *compressed,
              size_t           compressed_len,
              const cq_dict_t *dict,
              char            *out_buf,
              size_t           out_buf_size,
              size_t          *out_len)
{
    if (!compressed || !dict || !out_buf || !out_len) return -1;
    if (out_buf_size < 2) return -1;

    size_t in_pos  = 0;
    size_t out_pos = 0;

    while (in_pos < compressed_len) {
        char ch = compressed[in_pos];

        if (ch == '^' && in_pos + 1 < compressed_len) {
            /* Parse the integer after '^' */
            size_t num_start = in_pos + 1;
            size_t num_end   = num_start;
            while (num_end < compressed_len &&
                   compressed[num_end] >= '0' &&
                   compressed[num_end] <= '9') {
                num_end++;
            }

            if (num_end > num_start) {
                /* Parse symbol id */
                int sym_id = 0;
                for (size_t k = num_start; k < num_end; k++) {
                    sym_id = sym_id * 10 + (compressed[k] - '0');
                }

                if (sym_id >= 0 && (size_t)sym_id < dict->count) {
                    const cq_symbol_t *s = &dict->entries[sym_id];
                    /* Emit: "<original>" (re-add quotes) */
                    size_t need = s->original_len + 2 + 1; /* '"' + str + '"' + '\0' */
                    if (out_pos + need > out_buf_size) return -1;
                    out_buf[out_pos++] = '"';
                    memcpy(out_buf + out_pos, s->original, s->original_len);
                    out_pos += s->original_len;
                    out_buf[out_pos++] = '"';
                    in_pos = num_end;
                    continue;
                }
            }
        }

        /* Default: copy byte verbatim */
        if (out_pos + 1 >= out_buf_size) return -1;
        out_buf[out_pos++] = ch;
        in_pos++;
    }

    out_buf[out_pos] = '\0';
    *out_len = out_pos;
    return 0;
}
