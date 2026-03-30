#include "cq_compress.h"
#include "cq_ngram.h"

#include <string.h>
#include <stdio.h>
#include <ctype.h>

/* -----------------------------------------------------------------------
 * Shared helpers for intent-aware rewriting
 * ----------------------------------------------------------------------- */
static int intent_key_match_rw(const char * const *keys, int count,
                                const char *text, size_t len)
{
    if (!keys || count <= 0) return 0;
    for (int i = 0; i < count; i++) {
        if (keys[i] && strlen(keys[i]) == len &&
            memcmp(keys[i], text, len) == 0) return 1;
    }
    return 0;
}

/* Skip past a single JSON value (string, number, bool, object, array).
 * Returns the position immediately after the value.                      */
static size_t skip_json_value_rw(const char *input, size_t input_len, size_t pos)
{
    while (pos < input_len && (input[pos] == ' ' || input[pos] == '\t')) pos++;
    if (pos >= input_len) return pos;
    char ch = input[pos];
    if (ch == '"') {
        pos++;
        while (pos < input_len) {
            if (input[pos] == '\\') { pos += 2; continue; }
            if (input[pos] == '"') { pos++; break; }
            pos++;
        }
    } else if (ch == '{' || ch == '[') {
        char close = (ch == '{') ? '}' : ']';
        int depth = 1; pos++;
        while (pos < input_len && depth > 0) {
            if (input[pos] == '"') {
                pos++;
                while (pos < input_len) {
                    if (input[pos] == '\\') { pos += 2; continue; }
                    if (input[pos] == '"') { pos++; break; }
                    pos++;
                }
                continue;
            }
            if (input[pos] == '{' || input[pos] == '[') depth++;
            if (input[pos] == close) depth--;
            pos++;
        }
    } else {
        while (pos < input_len && input[pos] != ',' && input[pos] != '}'
               && input[pos] != ']' && input[pos] != '\n') pos++;
    }
    return pos;
}

/* ============================================================================
 * emit_symbol — write the symbol bytes for slot `sym` into out_buf.
 * Uses the scheme stored in `dict`.  Returns 0 on success, -1 on overflow.
 * ============================================================================ */
static int emit_symbol(int sym, const cq_dict_t *dict,
                       char *out_buf, size_t out_buf_size, size_t *pos)
{
    char tmp[8];
    int n = cq_dict_emit_symbol_bytes(dict, sym, tmp, sizeof(tmp));
    if (n < 0 || *pos + (size_t)n >= out_buf_size) return -1;
    memcpy(out_buf + *pos, tmp, (size_t)n);
    *pos += (size_t)n;
    return 0;
}

/* ============================================================================
 * Format-specific rewrite passes
 *
 * Each rewriter walks the input and replaces known tokens with their symbols.
 * Unknown bytes are copied verbatim.  Returns 0 on success, -1 on overflow.
 * ============================================================================ */

/* --------------------------------------------------------------------------
 * JSON rewriter
 * -------------------------------------------------------------------------- */
static int rewrite_json(const char *input, size_t input_len,
                        const cq_dict_t *dict, const cq_intent_t *intent,
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
                /* Check if this is a drop_key — if so, remove the whole pair */
                if (intent && intent->drop_keys) {
                    size_t k = j + 1;
                    while (k < input_len && (input[k]==' ' || input[k]=='\t')) k++;
                    if (k < input_len && input[k] == ':' &&
                        intent_key_match_rw(intent->drop_keys, intent->drop_count,
                                            input + str_start, j - str_start)) {
                        /* Skip:  "key" : <value> [,\s*] */
                        k++; /* past ':' */
                        k = skip_json_value_rw(input, input_len, k);
                        /* Consume trailing comma + whitespace */
                        while (k < input_len &&
                               (input[k]==' ' || input[k]=='\t' ||
                                input[k]=='\n' || input[k]=='\r')) k++;
                        if (k < input_len && input[k] == ',') {
                            k++;
                            while (k < input_len &&
                                   (input[k]==' ' || input[k]=='\t' ||
                                    input[k]=='\n' || input[k]=='\r')) k++;
                        }
                        in_pos = k;
                        continue;
                    }
                }

                int sym = cq_dict_lookup(dict, input + str_start, j - str_start);
                if (sym >= 0) {
                    if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
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
 * -------------------------------------------------------------------------- */
static int rewrite_csv(const char *input, size_t input_len,
                       const cq_dict_t *dict, const cq_intent_t *intent,
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
                /* Keep the surrounding quotes so round-trip restores them */
                if (*out_pos + 1 >= out_buf_size) return -1;
                out_buf[(*out_pos)++] = '"';
                if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
                if (*out_pos + 1 >= out_buf_size) return -1;
                out_buf[(*out_pos)++] = '"';
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
                if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
                /* copy trailing spaces (if any) verbatim */
                for (size_t k = tlen; k < len; k++) {
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = input[start + k];
                }
                continue;
            }
            /* No match — copy whole field verbatim */
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
    (void)intent;
    return 0;
}

/* --------------------------------------------------------------------------
 * LOG rewriter
 * -------------------------------------------------------------------------- */
static int is_token_char(char c)
{
    return isalnum((unsigned char)c) || c == '_' || c == '.' ||
           c == '-' || c == '/' || c == ':';
}

static int rewrite_log(const char *input, size_t input_len,
                       const cq_dict_t *dict, const cq_intent_t *intent,
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

        size_t span_end = i;
        while (span_end < input_len && !isspace((unsigned char)input[span_end])) span_end++;

        size_t lead = i;
        while (lead < span_end && !is_token_char(input[lead])) lead++;

        if (lead > i) {
            if (*out_pos + (lead - i) >= out_buf_size) return -1;
            memcpy(out_buf + *out_pos, input + i, lead - i);
            *out_pos += lead - i;
        }

        if (lead == span_end) { i = span_end; continue; }

        size_t content_len = span_end - lead;
        int sym = cq_dict_lookup(dict, input + lead, content_len);
        if (sym >= 0) {
            if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
        } else {
            if (*out_pos + content_len >= out_buf_size) return -1;
            memcpy(out_buf + *out_pos, input + lead, content_len);
            *out_pos += content_len;
        }
        i = span_end;
    }
    (void)intent;
    return 0;
}

/* --------------------------------------------------------------------------
 * CODE rewriter
 * -------------------------------------------------------------------------- */
static int rewrite_code(const char *input, size_t input_len,
                        const cq_dict_t *dict, const cq_intent_t *intent,
                        char *out_buf, size_t out_buf_size,
                        size_t *out_pos)
{
    size_t i = 0;
    while (i < input_len) {
        char ch = input[i];

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
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = delim;
                    if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
                    if (*out_pos + 1 >= out_buf_size) return -1;
                    out_buf[(*out_pos)++] = delim;
                    i = j + 1;
                    continue;
                }
            }
        }

        if (isalpha((unsigned char)ch) || ch == '_') {
            size_t start = i;
            while (i < input_len && (isalnum((unsigned char)input[i]) || input[i] == '_')) i++;
            size_t len = i - start;
            int sym = (len >= 4) ? cq_dict_lookup(dict, input + start, len) : -1;
            if (sym >= 0) {
                if (emit_symbol(sym, dict, out_buf, out_buf_size, out_pos) != 0) return -1;
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
    (void)intent;
    return 0;
}

/* --------------------------------------------------------------------------
 * Dispatch table
 * -------------------------------------------------------------------------- */
typedef int (*rewrite_fn)(const char *, size_t, const cq_dict_t *,
                          const cq_intent_t *,
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
                cq_result_t            *result)
{
    if (!input || !out_buf || !dict_buf || !dict_out || !result) return -1;
    if (out_buf_size < 2 || dict_buf_size < 2) return -1;
    if (fmt < 0 || fmt >= CQ_FMT_COUNT) fmt = CQ_FMT_JSON;

    const cq_tokenizer_t *tok    = opts && opts->tokenizer
                                   ? opts->tokenizer
                                   : cq_tokenizer_default();
    cq_symbol_scheme_t    scheme = opts ? opts->scheme : CQ_SYM_PUA_UNICODE;

    cq_candidate_list_t candidates;
    if (cq_ngram_scan(input, input_len, fmt, intent, tok, &candidates) < 0) return -1;
    if (cq_dict_build(&candidates, scheme, dict_out) < 0) return -1;

    int dict_len = cq_dict_render(dict_out, dict_buf, dict_buf_size);
    if (dict_len < 0) return -1;

    size_t out_pos = 0;
    if (rewriters[fmt](input, input_len, dict_out, intent,
                       out_buf, out_buf_size, &out_pos) != 0)
        return -1;

    out_buf[out_pos] = '\0';

    result->compressed     = out_buf;
    result->compressed_len = out_pos;
    result->dict_block     = dict_buf;
    result->dict_block_len = (size_t)dict_len;
    result->symbol_count   = (int)dict_out->count;
    result->input_tokens   = (size_t)tok->count_tokens(input, input_len,
                                                       tok->userdata);
    result->output_tokens  = (size_t)tok->count_tokens(out_buf, out_pos,
                                                       tok->userdata)
                           + (size_t)tok->count_tokens(dict_buf, (size_t)dict_len,
                                                       tok->userdata);
    return 0;
}

/* --------------------------------------------------------------------------
 * Expansion — scheme-aware symbol parsing
 * -------------------------------------------------------------------------- */
int cq_expand(const char      *compressed,
              size_t           compressed_len,
              cq_format_t      fmt,
              const cq_dict_t *dict,
              char            *out_buf,
              size_t           out_buf_size,
              size_t          *out_len)
{
    (void)fmt;
    if (!compressed || !dict || !out_buf || !out_len) return -1;
    if (out_buf_size < 2) return -1;

    size_t in_pos = 0, out_pos = 0;

    while (in_pos < compressed_len) {
        unsigned char ch = (unsigned char)compressed[in_pos];
        int sym_id = -1;
        size_t sym_bytes = 0;

        switch (dict->scheme) {
        case CQ_SYM_PUA_UNICODE:
            /* 3-byte UTF-8: 0xEE 0x8?..0x83 0x80..0xBF */
            if (ch == 0xEE && in_pos + 2 < compressed_len) {
                unsigned char b2 = (unsigned char)compressed[in_pos + 1];
                unsigned char b3 = (unsigned char)compressed[in_pos + 2];
                if (b2 >= 0x80 && b2 <= 0x83 && b3 >= 0x80 && b3 <= 0xBF) {
                    sym_id    = ((b2 - 0x80) << 6) | (b3 - 0x80);
                    sym_bytes = 3;
                }
            }
            break;

        case CQ_SYM_TILDE_ALPHA:
            if (ch == '~' && in_pos + 1 < compressed_len) {
                unsigned char nc = (unsigned char)compressed[in_pos + 1];
                if      (nc >= 'A' && nc <= 'Z') { sym_id = nc - 'A';       sym_bytes = 2; }
                else if (nc >= 'a' && nc <= 'z') { sym_id = 26 + (nc - 'a'); sym_bytes = 2; }
                else if (nc >= '0' && nc <= '9') { sym_id = 52 + (nc - '0'); sym_bytes = 2; }
            }
            break;

        case CQ_SYM_CARET_DECIMAL:
        default:
            if (ch == '^' && in_pos + 1 < compressed_len) {
                size_t num_start = in_pos + 1, num_end = num_start;
                while (num_end < compressed_len &&
                       compressed[num_end] >= '0' && compressed[num_end] <= '9')
                    num_end++;
                if (num_end > num_start) {
                    int id = 0;
                    for (size_t k = num_start; k < num_end; k++)
                        id = id * 10 + (compressed[k] - '0');
                    sym_id    = id;
                    sym_bytes = num_end - in_pos;
                }
            }
            break;
        }

        if (sym_id >= 0 && (size_t)sym_id < dict->count) {
            const cq_symbol_t *s = &dict->entries[sym_id];
            size_t need = s->original_len + (s->quoted ? 2 : 0) + 1;
            if (out_pos + need > out_buf_size) return -1;

            if (s->quoted) out_buf[out_pos++] = '"';
            memcpy(out_buf + out_pos, s->original, s->original_len);
            out_pos += s->original_len;
            if (s->quoted) out_buf[out_pos++] = '"';
            in_pos += sym_bytes;
            continue;
        }

        if (out_pos + 1 >= out_buf_size) return -1;
        out_buf[out_pos++] = (char)ch;
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

    const char *dot = NULL;
    for (const char *p = path; *p; p++) if (*p == '.') dot = p;
    if (!dot) return CQ_FMT_JSON;

    const char *ext = dot + 1;
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
