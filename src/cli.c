// src/cli.c
#include "cq_compress.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    printf("Usage: %s <file.json>\n", argv[0]);
    return 1;
  }

  // 1. Open and measure the file
  FILE *f = fopen(argv[1], "rb");
  if (!f) {
    printf("Error: Could not open file %s\n", argv[1]);
    return 1;
  }
  fseek(f, 0, SEEK_END);
  long fsize = ftell(f);
  fseek(f, 0, SEEK_SET);

  // 2. Allocate memory for the raw file
  char *input = malloc(fsize + 1);
  if (!input) {
    printf("Error: Failed to allocate %ld bytes for input.\n", fsize);
    fclose(f);
    return 1;
  }
  fread(input, 1, fsize, f);
  input[fsize] = '\0';
  fclose(f);

  // 3. Allocate memory for the output (We assume it won't grow larger than
  // input + overhead)
  char *out_buf = malloc(fsize + 4096);
  char *dict_buf = malloc(4096);
  cq_dict_t dict;
  cq_result_t res;

  printf("Ingested %s (%.2f MB)\n", argv[1], fsize / (1024.0 * 1024.0));
  printf("Compressing...\n");

  // 4. Run the compression engine and benchmark the CPU time
  clock_t start_time = clock();
  int rc = cq_compress(input, fsize, out_buf, fsize + 4096, dict_buf, 4096,
                       &dict, &res);
  clock_t end_time = clock();

  if (rc != 0) {
    printf("Compression failed (Buffer too small or bad input)\n");
    free(input);
    free(out_buf);
    free(dict_buf);
    return 1;
  }

  // 5. Calculate Metrics
  double time_taken = (double)(end_time - start_time) / CLOCKS_PER_SEC * 1000.0;
  size_t final_size = res.compressed_len + res.dict_block_len;
  double saved_mb = (fsize - final_size) / (1024.0 * 1024.0);
  int pct = (int)(((long)fsize - (long)final_size) * 100 / fsize);

  printf("=========================================\n");
  printf("Original Size   : %ld bytes (%.2f MB)\n", fsize,
         fsize / (1024.0 * 1024.0));
  printf("Compressed Size : %zu bytes (%.2f MB)\n", final_size,
         final_size / (1024.0 * 1024.0));
  printf("Space Saved     : %.2f MB (%d%% reduction)\n", saved_mb, pct);
  printf("Execution Time  : %.2f ms\n", time_taken);
  printf("Dictionary Size : %d symbols\n", res.symbol_count);
  printf("=========================================\n");

  free(input);
  free(out_buf);
  free(dict_buf);
  return 0;
}