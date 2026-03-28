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

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("Usage: %s <file> [json|csv|log|code]\n", argv[0]);
        return 1;
    }

    /* Format: explicit arg overrides auto-detect */
    cq_format_t fmt = cq_format_from_path(argv[1]);
    if (argc >= 3) {
        if (strcmp(argv[2], "csv")  == 0) fmt = CQ_FMT_CSV;
        else if (strcmp(argv[2], "log")  == 0) fmt = CQ_FMT_LOG;
        else if (strcmp(argv[2], "code") == 0) fmt = CQ_FMT_CODE;
        else                                    fmt = CQ_FMT_JSON;
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
    char *dict_buf = malloc(65536);   /* 64 KB — enough for 128 symbols */
    cq_dict_t   dict;
    cq_result_t res;

    if (!out_buf || !dict_buf) {
        printf("Error: Out of memory.\n");
        free(input); free(out_buf); free(dict_buf);
        return 1;
    }

    printf("Ingested %s (%.2f MB) [format: %s]\n",
           argv[1], fsize / (1024.0 * 1024.0), fmt_name(fmt));
    printf("Compressing...\n");

    clock_t t0 = clock();
    int rc = cq_compress(input, (size_t)fsize, fmt,
                         out_buf, (size_t)fsize + 4096,
                         dict_buf, 65536,
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
    int    pct        = (fsize > 0)
                        ? (int)(((long)fsize - (long)final_size) * 100 / fsize)
                        : 0;

    printf("=========================================\n");
    printf("Original Size   : %ld bytes (%.2f MB)\n", fsize, fsize / (1024.0 * 1024.0));
    printf("Compressed Size : %zu bytes (%.2f MB)\n", final_size, final_size / (1024.0 * 1024.0));
    printf("Space Saved     : %.2f MB (%d%% reduction)\n", saved_mb, pct);
    printf("Execution Time  : %.2f ms\n", ms);
    printf("Dictionary Size : %d symbols\n", res.symbol_count);
    printf("=========================================\n");

    free(input); free(out_buf); free(dict_buf);
    return 0;
}
