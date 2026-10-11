// src/cli.c
#include "cq_compress.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const char *fmt_name(cq_format_t fmt) {
    switch (fmt) {
        case CQ_FMT_JSON: return "JSON";
        case CQ_FMT_CSV:  return "CSV";
        case CQ_FMT_LOG:  return "LOG";
        case CQ_FMT_CODE: return "CODE";
        default:          return "JSON";
    }
}

static const char *scheme_name(cq_symbol_scheme_t s) {
    switch (s) {
        case CQ_SYM_PUA_UNICODE:   return "pua_unicode";
        case CQ_SYM_TILDE_ALPHA:   return "tilde_alpha";
        case CQ_SYM_CARET_DECIMAL: return "caret_decimal";
        default:                   return "pua_unicode";
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("Usage: %s <file> [json|csv|log|code] [--tilde|--caret]\n", argv[0]);
        printf("  Default scheme: pua_unicode (1 token/symbol, best ROI)\n");
        printf("  --tilde  : use ~A-style symbols (2 tokens, ASCII-safe)\n");
        printf("  --caret  : use ^N legacy symbols (2-4 tokens)\n");
        return 1;
    }

    cq_format_t fmt = cq_format_from_path(argv[1]);
    cq_symbol_scheme_t scheme = CQ_SYM_PUA_UNICODE;

    for (int i = 2; i < argc; i++) {
        if      (strcmp(argv[i], "csv")    == 0) fmt = CQ_FMT_CSV;
        else if (strcmp(argv[i], "log")    == 0) fmt = CQ_FMT_LOG;
        else if (strcmp(argv[i], "code")   == 0) fmt = CQ_FMT_CODE;
        else if (strcmp(argv[i], "json")   == 0) fmt = CQ_FMT_JSON;
        else if (strcmp(argv[i], "--tilde") == 0) scheme = CQ_SYM_TILDE_ALPHA;
        else if (strcmp(argv[i], "--caret") == 0) scheme = CQ_SYM_CARET_DECIMAL;
    }

    FILE *f = fopen(argv[1], "rb");
    if (!f) { printf("Error: Could not open file %s\n", argv[1]); return 1; }

    fseek(f, 0, SEEK_END);
    long fsize = ftell(f);
    fseek(f, 0, SEEK_SET);

    char *input = malloc((size_t)fsize + 1);
    if (!input) { printf("Error: Out of memory.\n"); fclose(f); return 1; }
    fread(input, 1, (size_t)fsize, f);
    input[fsize] = '\0';
    fclose(f);

    char *out_buf  = malloc((size_t)fsize + 4096);
    char *dict_buf = malloc(262144);  /* 256 KB — covers 256 symbols safely */
    cq_dict_t   dict;
    cq_result_t res;

    if (!out_buf || !dict_buf) {
        printf("Error: Out of memory.\n");
        free(input); free(out_buf); free(dict_buf);
        return 1;
    }

    printf("Ingested %s (%.2f MB) [format: %s, scheme: %s]\n",
           argv[1], fsize / (1024.0 * 1024.0), fmt_name(fmt), scheme_name(scheme));
    printf("Compressing...\n");

    cq_compress_opts_t opts = { NULL, scheme };

    clock_t t0 = clock();
    int rc = cq_compress(input, (size_t)fsize, fmt, NULL, &opts,
                         out_buf, (size_t)fsize + 4096,
                         dict_buf, 262144,
                         &dict, &res);
    clock_t t1 = clock();

    if (rc != 0) {
        printf("Compression failed.\n");
        free(input); free(out_buf); free(dict_buf);
        return 1;
    }

    double ms         = (double)(t1 - t0) / CLOCKS_PER_SEC * 1000.0;
    size_t final_size = res.compressed_len + res.dict_block_len;
    double saved_mb   = ((double)fsize - (double)final_size) / (1024.0 * 1024.0);
    int    byte_pct   = (fsize > 0)
                        ? (int)(((long)fsize - (long)final_size) * 100 / fsize)
                        : 0;
    int    tok_pct    = (res.input_tokens > 0)
                        ? (int)(((long)res.input_tokens - (long)res.output_tokens)
                                * 100 / (long)res.input_tokens)
                        : 0;

    printf("=========================================\n");
    printf("Original Size   : %ld bytes (%.2f MB)\n", fsize, fsize / (1024.0 * 1024.0));
    printf("Compressed Size : %zu bytes (%.2f MB)\n", final_size, final_size / (1024.0 * 1024.0));
    printf("Byte Reduction  : %.2f MB (%d%%)\n", saved_mb, byte_pct);
    printf("-----------------------------------------\n");
    printf("Input Tokens    : %zu  (via %s)\n", res.input_tokens,
           cq_tokenizer_default()->name);
    printf("Output Tokens   : %zu  (payload + dict)\n", res.output_tokens);
    printf("Token Reduction : %d%%\n", tok_pct);
    printf("-----------------------------------------\n");
    printf("Execution Time  : %.2f ms\n", ms);
    printf("Dictionary Size : %d symbols  [scheme: %s]\n",
           res.symbol_count, scheme_name(scheme));
    printf("=========================================\n");

    free(input); free(out_buf); free(dict_buf);
    return 0;
}
