/*
 * cq_wasm.c — WebAssembly entry points for ContextQuant.
 *
 * Compiled with emscripten (emcc) using Makefile.wasm.
 * Links only the SQLite-free core: cq_ngram, cq_dict, cq_compress, cq_tokenizer.
 *
 * JavaScript usage after loading cq.mjs:
 *
 *   const { compress, expand, version } = await import('./cq.mjs');
 *
 *   const result = compress(jsonString, 'json');
 *   // result = { compressed, dict, inputTokens, outputTokens, reductionPct, symbols }
 *
 *   const original = expand(result.compressed, result.dict, 'json');
 */

#ifdef __EMSCRIPTEN__
#  include <emscripten.h>
#  define CQ_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#  define CQ_EXPORT
#endif

#include "../cq_compress.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* -----------------------------------------------------------------------
 * Internal helpers
 * ----------------------------------------------------------------------- */

static cq_format_t fmt_from_string(const char *s)
{
    if (!s)                    return CQ_FMT_JSON;
    if (strcmp(s, "csv")  == 0) return CQ_FMT_CSV;
    if (strcmp(s, "log")  == 0) return CQ_FMT_LOG;
    if (strcmp(s, "code") == 0) return CQ_FMT_CODE;
    return CQ_FMT_JSON;
}

/* -----------------------------------------------------------------------
 * cq_wasm_compress
 *
 * Compress `input` (null-terminated) using the given format string
 * ("json", "csv", "log", "code").
 *
 * Returns a heap-allocated JSON string of the form:
 *   {
 *     "compressed": "...",
 *     "dict": "...",
 *     "inputTokens": 42,
 *     "outputTokens": 18,
 *     "reductionPct": 57,
 *     "symbols": 12
 *   }
 *
 * Returns NULL on error.
 * Caller must pass the pointer to cq_wasm_free() when done.
 * ----------------------------------------------------------------------- */
CQ_EXPORT char *cq_wasm_compress(const char *input, const char *fmt_str)
{
    if (!input) return NULL;

    size_t input_len = strlen(input);
    cq_format_t fmt  = fmt_from_string(fmt_str);

    size_t out_sz  = input_len + 4096;
    char  *out_buf = malloc(out_sz);
    char  *dict_buf = malloc(65536);   /* 64 KB — plenty for 256 PUA symbols */
    if (!out_buf || !dict_buf) { free(out_buf); free(dict_buf); return NULL; }

    cq_dict_t   dict;
    cq_result_t res;

    int rc = cq_compress(input, input_len, fmt, NULL, NULL,
                         out_buf, out_sz,
                         dict_buf, 65536,
                         &dict, &res);
    if (rc != 0) { free(out_buf); free(dict_buf); return NULL; }

    int pct = (res.input_tokens > 0)
              ? (int)(((long)res.input_tokens - (long)res.output_tokens) * 100
                      / (long)res.input_tokens)
              : 0;

    /* Escape compressed and dict strings for JSON embedding.
     * Simple approach: hex-encode any non-printable / non-ASCII bytes.
     * For PUA Unicode symbols (3-byte sequences), emit them as \uXXXX. */
    size_t json_sz = res.compressed_len * 6 + res.dict_block_len * 6 + 256;
    char  *json    = malloc(json_sz);
    if (!json) { free(out_buf); free(dict_buf); return NULL; }

    /* Build escaped compressed string */
    char  *esc_comp = malloc(res.compressed_len * 6 + 1);
    char  *esc_dict = malloc(res.dict_block_len * 6 + 1);
    if (!esc_comp || !esc_dict) {
        free(out_buf); free(dict_buf); free(json);
        free(esc_comp); free(esc_dict);
        return NULL;
    }

    /* Escape helper: write JSON-safe representation of a binary buffer */
    size_t ci = 0, di = 0;
    for (size_t i = 0; i < res.compressed_len; ) {
        unsigned char c = (unsigned char)res.compressed[i];
        if (c == 0xEE && i + 2 < res.compressed_len) {
            unsigned char b2 = (unsigned char)res.compressed[i+1];
            unsigned char b3 = (unsigned char)res.compressed[i+2];
            if (b2 >= 0x80 && b2 <= 0x83 && b3 >= 0x80 && b3 <= 0xBF) {
                int cp = 0xE000 + ((b2 - 0x80) << 6) | (b3 - 0x80);
                ci += (size_t)snprintf(esc_comp + ci, 8, "\\u%04X", cp);
                i += 3; continue;
            }
        }
        if (c == '"')       { esc_comp[ci++] = '\\'; esc_comp[ci++] = '"'; }
        else if (c == '\\') { esc_comp[ci++] = '\\'; esc_comp[ci++] = '\\'; }
        else if (c == '\n') { esc_comp[ci++] = '\\'; esc_comp[ci++] = 'n'; }
        else if (c == '\r') { esc_comp[ci++] = '\\'; esc_comp[ci++] = 'r'; }
        else if (c == '\t') { esc_comp[ci++] = '\\'; esc_comp[ci++] = 't'; }
        else                { esc_comp[ci++] = (char)c; }
        i++;
    }
    esc_comp[ci] = '\0';

    for (size_t i = 0; i < res.dict_block_len; ) {
        unsigned char c = (unsigned char)res.dict_block[i];
        if (c == 0xEE && i + 2 < res.dict_block_len) {
            unsigned char b2 = (unsigned char)res.dict_block[i+1];
            unsigned char b3 = (unsigned char)res.dict_block[i+2];
            if (b2 >= 0x80 && b2 <= 0x83 && b3 >= 0x80 && b3 <= 0xBF) {
                int cp = 0xE000 + (((b2 - 0x80) << 6) | (b3 - 0x80));
                di += (size_t)snprintf(esc_dict + di, 8, "\\u%04X", cp);
                i += 3; continue;
            }
        }
        if (c == '"')       { esc_dict[di++] = '\\'; esc_dict[di++] = '"'; }
        else if (c == '\\') { esc_dict[di++] = '\\'; esc_dict[di++] = '\\'; }
        else if (c == '\n') { esc_dict[di++] = '\\'; esc_dict[di++] = 'n'; }
        else if (c == '\r') { esc_dict[di++] = '\\'; esc_dict[di++] = 'r'; }
        else if (c == '\t') { esc_dict[di++] = '\\'; esc_dict[di++] = 't'; }
        else                { esc_dict[di++] = (char)c; }
        i++;
    }
    esc_dict[di] = '\0';

    snprintf(json, json_sz,
             "{\"compressed\":\"%s\",\"dict\":\"%s\","
             "\"inputTokens\":%zu,\"outputTokens\":%zu,"
             "\"reductionPct\":%d,\"symbols\":%d}",
             esc_comp, esc_dict,
             res.input_tokens, res.output_tokens,
             pct, res.symbol_count);

    free(out_buf); free(dict_buf); free(esc_comp); free(esc_dict);
    return json;
}

/* -----------------------------------------------------------------------
 * cq_wasm_free — release a string returned by cq_wasm_compress.
 * ----------------------------------------------------------------------- */
CQ_EXPORT void cq_wasm_free(char *ptr)
{
    free(ptr);
}

/* -----------------------------------------------------------------------
 * cq_wasm_version — returns a build metadata string.
 * ----------------------------------------------------------------------- */
CQ_EXPORT const char *cq_wasm_version(void)
{
    return "contextquant-wasm/1.0.0-alpha scheme=pua_unicode tokenizer=heuristic_v2";
}
