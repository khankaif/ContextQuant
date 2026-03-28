#include <stdio.h>
#include <string.h>
#include <assert.h>
#include <stdlib.h>

#include "../src/cq_cache.h"

#define DB_PATH "/tmp/cq_test_cache.db"

static void section(const char *t) { printf("\n=== %s ===\n", t); }

/* ------------------------------------------------------------------ helpers */

static const char *json_input =
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":1000},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":2000},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"paid\":true,\"currency\":\"usd\",\"amount\":3000}";

/* ---------------------------------------------------------------- store/hit */

static void test_store_and_hit(cq_cache_t *cache)
{
    section("store + lookup");

    char out[8192] = {0}, dict[4096] = {0};
    cq_dict_t   d;
    cq_result_t r;
    int hit = -1;

    int rc = cq_compress_cached(cache,
                                json_input, strlen(json_input),
                                CQ_FMT_JSON, NULL, "test-charge",
                                out, sizeof(out),
                                dict, sizeof(dict),
                                &d, &r, &hit);
    assert(rc == 0);
    assert(hit == 0);   /* first call → miss */
    printf("Miss: symbols=%d  saved=%d%%\n",
           r.symbol_count,
           r.input_tokens ? (int)((r.input_tokens - r.output_tokens) * 100 /
                                   r.input_tokens) : 0);

    /* Second call with identical input → should be a hit (dict in cache) */
    char out2[8192] = {0}, dict2[4096] = {0};
    cq_dict_t   d2;
    cq_result_t r2;
    int hit2 = -1;

    rc = cq_compress_cached(cache,
                            json_input, strlen(json_input),
                            CQ_FMT_JSON, NULL, "test-charge",
                            out2, sizeof(out2),
                            dict2, sizeof(dict2),
                            &d2, &r2, &hit2);
    assert(rc == 0);
    assert(hit2 == 1);  /* second call → hit */
    printf("Hit:  symbols=%d\n", r2.symbol_count);
}

/* --------------------------------------------------------------- lookup API */

static void test_lookup_api(cq_cache_t *cache)
{
    section("cq_cache_lookup");

    cq_cache_entry_t e;
    int found = cq_cache_lookup(cache, json_input, strlen(json_input), &e);
    assert(found == 1);

    printf("Hash : %.8s...\n", e.input_hash);
    printf("Label: %s\n",      e.label ? e.label : "(none)");
    printf("Size : %ld → %ld bytes (%d%% reduction)\n",
           e.input_size, e.compressed_size, e.reduction_pct);
    printf("Syms : %d\n", e.symbol_count);

    /* Re-injection block */
    char buf[4096];
    int n = cq_cache_reinject_block(&e, buf, sizeof(buf));
    assert(n > 0);
    printf("Re-inject block (%d bytes):\n%s", n, buf);

    cq_cache_entry_free(&e);
}

/* ------------------------------------------------------------------- stats  */

static void test_stats(cq_cache_t *cache)
{
    section("stats");

    cq_cache_stats_t s;
    int rc = cq_cache_stats(cache, &s);
    assert(rc == 0);
    printf("Entries: %ld  input_bytes: %ld  saved_bytes: %ld  avg_pct: %.1f\n",
           s.total_entries, s.total_input_bytes,
           s.total_saved_bytes, s.avg_reduction_pct);
    assert(s.total_entries >= 1);
}

/* ------------------------------------------------------------------- miss   */

static void test_miss(cq_cache_t *cache)
{
    section("cache miss");

    const char *other = "{\"x\":1}";
    cq_cache_entry_t e;
    int found = cq_cache_lookup(cache, other, strlen(other), &e);
    assert(found == 0);
    printf("Lookup for unknown input: miss (correct)\n");
}

/* ------------------------------------------------------------------- evict  */

static void test_evict(cq_cache_t *cache)
{
    section("evict_old (0-day, removes nothing recent)");
    /* Pass 0 days → should return -1 (guard in impl) */
    int r = cq_cache_evict_old(cache, 0);
    assert(r == -1);

    /* Pass a huge number → removes entries older than 9999 days (none) */
    r = cq_cache_evict_old(cache, 9999);
    assert(r == 0);
    printf("Evict 9999 days: %d rows removed (expected 0)\n", r);
}

/* ------------------------------------------------------------------- main   */

int main(void)
{
    printf("ContextQuant — Cache Test Suite\n");

    /* Always start with a clean DB */
    remove(DB_PATH);

    cq_cache_t *cache = cq_cache_open(DB_PATH);
    assert(cache && "cq_cache_open failed");

    test_store_and_hit(cache);
    test_lookup_api(cache);
    test_stats(cache);
    test_miss(cache);
    test_evict(cache);

    cq_cache_close(cache);
    remove(DB_PATH);

    printf("\nAll cache tests passed.\n");
    return 0;
}
