#include "cq_compress.h"
#include "cq_ngram.h"

#include <string.h>
#include <stdio.h>
#include <ctype.h>

/* ============================================================================
 * Format-specific rewrite passes
 *
 * Each rewriter walks the input and replaces known tokens with their symbols.
 * Unknown bytes are copied verbatim.  Returns 0 on success, -1 on overflow.
 * ============================================================================ */

/* Emit a symbol token "^N" into out_buf at *pos.  Returns 0 or -1. */
static int emit_symbol(int sym, char *out_buf, size_t out_buf_size, size_t *pos)
{
    int n = snprintf(out_buf + *pos, out_buf_size - *pos, "^%d", sym);
    if (n < 0 || (size_t)n >= out_buf_size - *pos) return -1;
    *pos += (size_t)n;
    return 0;
}

/* --------------------------------------------------------------------------
 * JSON rewriter
 *
 * Replaces "quoted_string" (including the surrounding double-quotes) with ^N
 * when the string content is in the dictionary.  Everything else is copied.
 * -------------------------------------------------------------------------- */
static int rewrite_json(const char *input, size_t input_len,
                        const cq_dict_t *dict,
                        char *out_buf, size_t out_buf_size,
                        size_t *out_pos)
{
    size_t in_pos = 0;
    while (in_pos < input_len) {
        char ch = input[in_pos];

        if (ch == '"') {
            size_t str_start = in_pos + 1;
            size_t j = str_start;
            while (j < input_len) {
                if (input[j] == '\\') { j += 2; continue; }
                if (input[j] == '"')  break;
                j++;
            }
            if (j < input_len) {
                int sym = cq_dict_lookup(dict, input + str_start, j - str_start);
                if (sym >= 0) {
                    if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
                    in_pos = j + 1;
                    continue;
                }
            }
        }

        if (*out_pos + 1 >= out_buf_size) return -1;
        out_buf[(*out_pos)++] = ch;
        in_pos++;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * CSV rewriter
 *
 * Replaces field values (quoted or unquoted) with ^N when found in dict.
 * Delimiters (commas, newlines) and non-matching fields are copied verbatim.
 * -------------------------------------------------------------------------- */
static int rewrite_csv(const char *input, size_t input_len,
                       const cq_dict_t *dict,
                       char *out_buf, size_t out_buf_size,
                       size_t *out_pos)
{
    size_t i = 0;
    while (i < input_len) {
        char ch = input[i];

        if (ch == '"') {
            /* Quoted field */
            size_t start = i + 1, j = start;
            while (j < input_len) {
                if (input[j] == '"' && j + 1 < input_len && input[j+1] == '"') { j += 2; continue; }
                if (input[j] == '"') break;
                j++;
            }
            int sym = (j < input_len) ? cq_dict_lookup(dict, input + start, j - start) : -1;
            if (sym >= 0) {
                if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
                i = j + 1;
                continue;
            }
            /* No match — copy entire quoted field verbatim */
            size_t span = (j < input_len ? j + 1 : input_len) - i;
            if (*out_pos + span >= out_buf_size) return -1;
            memcpy(out_buf + *out_pos, input + i, span);
            *out_pos += span;
            i += span;
            continue;
        } else if (ch != ',' && ch != '\n' && ch != '\r') {
            /* Unquoted field — find end */
            size_t start = i;
            while (i < input_len && input[i] != ',' && input[i] != '\n' && input[i] != '\r') i++;
            size_t len = i - start;
            /* trim trailing spaces for lookup */
            size_t tlen = len;
            while (tlen > 0 && input[start + tlen - 1] == ' ') tlen--;
            int sym = (tlen > 0) ? cq_dict_lookup(dict, input + start, tlen) : -1;
            if (sym >= 0) {
                if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
                /* copy trailing spaces (if any) verbatim */
                for (size_t k = tlen; k < len; k++) {
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = input[start + k];
                }
                continue;
            }
            /* No match — fall through to verbatim copy of the whole field */
            for (size_t k = 0; k < len; k++) {
                if (*out_pos + 1 >= out_buf_size) return -1;
                out_buf[(*out_pos)++] = input[start + k];
            }
            continue;
        }

        if (*out_pos + 1 >= out_buf_size) return -1;
        out_buf[(*out_pos)++] = ch;
        i++;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * LOG rewriter
 *
 * Mirrors the extract_log tokenisation exactly so the same token boundaries
 * are seen during compression as during frequency analysis:
 *
 *   1. Leading non-alnum/non-special characters within a whitespace span
 *      are copied verbatim (e.g. the '[' in "[2026-03-29").
 *   2. The remaining content of the span is looked up in the dict.
 *   3. On a hit the symbol is emitted; on a miss the content is copied.
 *
 * Special chars kept inside a token (matching extract_log): _ . - / :
 * -------------------------------------------------------------------------- */
static int is_token_char(char c)
{
    return isalnum((unsigned char)c) || c == '_' || c == '.' ||
           c == '-' || c == '/' || c == ':';
}

static int rewrite_log(const char *input, size_t input_len,
                       const cq_dict_t *dict,
                       char *out_buf, size_t out_buf_size,
                       size_t *out_pos)
{
    size_t i = 0;
    while (i < input_len) {
        if (isspace((unsigned char)input[i])) {
            if (*out_pos + 1 >= out_buf_size) return -1;
            out_buf[(*out_pos)++] = input[i++];
            continue;
        }

        /* Within a whitespace span: copy leading punctuation verbatim */
        size_t span_end = i;
        while (span_end < input_len && !isspace((unsigned char)input[span_end])) span_end++;

        size_t lead = i;
        while (lead < span_end && !is_token_char(input[lead])) lead++;

        /* Copy any leading punctuation verbatim */
        if (lead > i) {
            if (*out_pos + (lead - i) >= out_buf_size) return -1;
            memcpy(out_buf + *out_pos, input + i, lead - i);
            *out_pos += lead - i;
        }

        if (lead == span_end) { i = span_end; continue; }   /* all punct span */

        /* Token content: from lead to span_end */
        size_t content_len = span_end - lead;
        int sym = cq_dict_lookup(dict, input + lead, content_len);
        if (sym >= 0) {
            if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
        } else {
            if (*out_pos + content_len >= out_buf_size) return -1;
            memcpy(out_buf + *out_pos, input + lead, content_len);
            *out_pos += content_len;
        }
        i = span_end;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * CODE rewriter
 *
 * Replaces string literals and long identifiers with ^N when in dict.
 * -------------------------------------------------------------------------- */
static int rewrite_code(const char *input, size_t input_len,
                        const cq_dict_t *dict,
                        char *out_buf, size_t out_buf_size,
                        size_t *out_pos)
{
    size_t i = 0;
    while (i < input_len) {
        char ch = input[i];

        /* String literal */
        if (ch == '"' || ch == '\'') {
            char delim = ch;
            size_t start = i + 1, j = start;
            while (j < input_len) {
                if (input[j] == '\\') { j += 2; continue; }
                if (input[j] == delim) break;
                j++;
            }
            if (j < input_len) {
                int sym = cq_dict_lookup(dict, input + start, j - start);
                if (sym >= 0) {
                    /* emit the opening quote + symbol + closing quote */
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = delim;
                    if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = delim;
                    i = j + 1;
                    continue;
                }
            }
        }

        /* Identifier */
        if (isalpha((unsigned char)ch) || ch == '_') {
            size_t start = i;
            while (i < input_len && (isalnum((unsigned char)input[i]) || input[i] == '_')) i++;
            size_t len = i - start;
            int sym = (len >= 4) ? cq_dict_lookup(dict, input + start, len) : -1;
            if (sym >= 0) {
                if (emit_symbol(sym, out_buf, out_buf_size, out_pos) != 0) return -1;
            } else {
                if (*out_pos + len >= out_buf_size) return -1;
                memcpy(out_buf + *out_pos, input + start, len);
                *out_pos += len;
            }
            continue;
        }

        if (*out_pos + 1 >= out_buf_size) return -1;
        out_buf[(*out_pos)++] = ch;
        i++;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * Dispatch table
 * -------------------------------------------------------------------------- */
typedef int (*rewrite_fn)(const char *, size_t, const cq_dict_t *,
                          char *, size_t, size_t *);

static const rewrite_fn rewriters[CQ_FMT_COUNT] = {
    [CQ_FMT_JSON] = rewrite_json,
    [CQ_FMT_CSV]  = rewrite_csv,
    [CQ_FMT_LOG]  = rewrite_log,
    [CQ_FMT_CODE] = rewrite_code,
};

/* ============================================================================
 * Public API
 * ============================================================================ */

int cq_compress(const char  *input,
                size_t       input_len,
                cq_format_t  fmt,
                char        *out_buf,
                size_t       out_buf_size,
                char        *dict_buf,
                size_t       dict_buf_size,
                cq_dict_t   *dict_out,
                cq_result_t *result)
{
    if (!input || !out_buf || !dict_buf || !dict_out || !result) return -1;
    if (out_buf_size < 2 || dict_buf_size < 2) return -1;
    if (fmt < 0 || fmt >= CQ_FMT_COUNT) fmt = CQ_FMT_JSON;

    cq_candidate_list_t candidates;
    if (cq_ngram_scan(input, input_len, fmt, &candidates) < 0) return -1;
    if (cq_dict_build(&candidates, dict_out) < 0) return -1;

    int dict_len = cq_dict_render(dict_out, dict_buf, dict_buf_size);
    if (dict_len < 0) return -1;

    size_t out_pos = 0;
    if (rewriters[fmt](input, input_len, dict_out, out_buf, out_buf_size, &out_pos) != 0)
        return -1;

    out_buf[out_pos] = '\0';

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
 * Expansion  (format-aware quoting via the symbol's `quoted` flag)
 * -------------------------------------------------------------------------- */
int cq_expand(const char      *compressed,
              size_t           compressed_len,
              cq_format_t      fmt,
              const cq_dict_t *dict,
              char            *out_buf,
              size_t           out_buf_size,
              size_t          *out_len)
{
    (void)fmt;   /* routing reserved for future format-specific expand logic */
    if (!compressed || !dict || !out_buf || !out_len) return -1;
    if (out_buf_size < 2) return -1;

    size_t in_pos = 0, out_pos = 0;
    while (in_pos < compressed_len) {
        char ch = compressed[in_pos];

        if (ch == '^' && in_pos + 1 < compressed_len) {
            size_t num_start = in_pos + 1, num_end = num_start;
            while (num_end < compressed_len &&
                   compressed[num_end] >= '0' && compressed[num_end] <= '9') num_end++;

            if (num_end > num_start) {
                int sym_id = 0;
                for (size_t k = num_start; k < num_end; k++)
                    sym_id = sym_id * 10 + (compressed[k] - '0');

                if (sym_id >= 0 && (size_t)sym_id < dict->count) {
                    const cq_symbol_t *s = &dict->entries[sym_id];
                    size_t need = s->original_len + (s->quoted ? 2 : 0) + 1;
                    if (out_pos + need > out_buf_size) return -1;

                    if (s->quoted) out_buf[out_pos++] = '"';
                    memcpy(out_buf + out_pos, s->original, s->original_len);
                    out_pos += s->original_len;
                    if (s->quoted) out_buf[out_pos++] = '"';
                    in_pos = num_end;
                    continue;
                }
            }
        }

        if (out_pos + 1 >= out_buf_size) return -1;
        out_buf[out_pos++] = ch;
        in_pos++;
    }

    out_buf[out_pos] = '\0';
    *out_len = out_pos;
    return 0;
}

/* --------------------------------------------------------------------------
 * Format detection from file extension
 * -------------------------------------------------------------------------- */
cq_format_t cq_format_from_path(const char *path)
{
    if (!path) return CQ_FMT_JSON;

    /* find last '.' */
    const char *dot = NULL;
    for (const char *p = path; *p; p++) if (*p == '.') dot = p;
    if (!dot) return CQ_FMT_JSON;

    const char *ext = dot + 1;
    /* case-insensitive compare for common extensions */
    char lc[16] = {0};
    for (int i = 0; i < 15 && ext[i]; i++) lc[i] = (char)tolower((unsigned char)ext[i]);

    if (strcmp(lc, "json") == 0) return CQ_FMT_JSON;
    if (strcmp(lc, "csv")  == 0) return CQ_FMT_CSV;
    if (strcmp(lc, "tsv")  == 0) return CQ_FMT_CSV;
    if (strcmp(lc, "log")  == 0) return CQ_FMT_LOG;
    if (strcmp(lc, "txt")  == 0) return CQ_FMT_LOG;
    if (strcmp(lc, "c")    == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "h")    == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "cpp")  == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "py")   == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "js")   == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "ts")   == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "go")   == 0) return CQ_FMT_CODE;
    if (strcmp(lc, "rs")   == 0) return CQ_FMT_CODE;

    return CQ_FMT_JSON;
}
