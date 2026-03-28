#include <stdio.h>
#include <string.h>
#include <assert.h>
#include <stdlib.h>

#include "../src/cq_session.h"

#define DB_PATH "/tmp/cq_test_session.db"

static void section(const char *t) { printf("\n=== %s ===\n", t); }

/* ----------------------------------------------------------------- fixtures */

static const char *doc_a =
    "[{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"currency\":\"usd\",\"amount\":1000},"
    "{\"object\":\"charge\",\"status\":\"succeeded\","
    "\"currency\":\"usd\",\"amount\":2000},"
    "{\"object\":\"charge\",\"status\":\"failed\","
    "\"currency\":\"usd\",\"amount\":300}]";

static const char *doc_b =
    "[{\"object\":\"customer\",\"email\":\"alice@example.com\","
    "\"plan\":\"enterprise\",\"status\":\"active\"},"
    "{\"object\":\"customer\",\"email\":\"bob@example.com\","
    "\"plan\":\"enterprise\",\"status\":\"active\"},"
    "{\"object\":\"customer\",\"email\":\"carol@example.com\","
    "\"plan\":\"starter\",\"status\":\"inactive\"}]";

/* ---------------------------------------------------------------- open/info */

static void test_open(cq_cache_t *cache, char out_id[65])
{
    section("session_open (new session)");

    int rc = cq_session_open(cache, NULL, "/Users/user/myproject", out_id);
    assert(rc == 0);
    assert(out_id[0] != '\0');
    printf("Session ID: %s\n", out_id);

    cq_session_info_t info;
    rc = cq_session_info(cache, out_id, &info);
    assert(rc == 0);
    printf("project_dir: %s\n", info.project_dir ? info.project_dir : "(none)");
    printf("items: %ld\n", info.item_count);
    assert(info.item_count == 0);
    cq_session_info_free(&info);
}

/* ------------------------------------------------------------ compress+add  */

static void test_compress(cq_cache_t *cache, const char *session_id)
{
    section("session_compress × 2 documents");

    char out[8192] = {0}, dict[4096] = {0};
    cq_dict_t d; cq_result_t r; int hit;

    /* Document A */
    int rc = cq_session_compress(cache, session_id,
                                 doc_a, strlen(doc_a),
                                 CQ_FMT_JSON, NULL, "charges",
                                 out, sizeof(out),
                                 dict, sizeof(dict),
                                 &d, &r, &hit);
    assert(rc == 0);
    printf("doc_a: symbols=%d  hit=%d\n", r.symbol_count, hit);

    /* Document B */
    memset(out, 0, sizeof(out)); memset(dict, 0, sizeof(dict));
    rc = cq_session_compress(cache, session_id,
                             doc_b, strlen(doc_b),
                             CQ_FMT_JSON, NULL, "customers",
                             out, sizeof(out),
                             dict, sizeof(dict),
                             &d, &r, &hit);
    assert(rc == 0);
    printf("doc_b: symbols=%d  hit=%d\n", r.symbol_count, hit);

    /* Verify item count */
    cq_session_info_t info;
    cq_session_info(cache, session_id, &info);
    printf("Session items after 2 compress: %ld\n", info.item_count);
    assert(info.item_count == 2);
    cq_session_info_free(&info);
}

/* ----------------------------------------------------------- list items     */

static void test_list(cq_cache_t *cache, const char *session_id)
{
    section("session_list_items");

    cq_cache_entry_t items[8];
    int n = cq_session_list_items(cache, session_id, items, 8);
    assert(n == 2);
    printf("Item 0: label=%s  symbols=%d  reduction=%d%%\n",
           items[0].label, items[0].symbol_count, items[0].reduction_pct);
    printf("Item 1: label=%s  symbols=%d  reduction=%d%%\n",
           items[1].label, items[1].symbol_count, items[1].reduction_pct);
    for (int i = 0; i < n; i++) cq_cache_entry_free(&items[i]);
}

/* ---------------------------------------------------------- reinject block  */

static void test_reinject(cq_cache_t *cache, const char *session_id)
{
    section("session_reinject_block");

    char buf[16384];
    int n = cq_session_reinject_block(cache, session_id, buf, sizeof(buf));
    assert(n > 0);
    printf("Block (%d bytes):\n%s\n", n, buf);

    /* Must contain session header + both dict blocks */
    assert(strstr(buf, "[CQ-SESSION")   != NULL);
    assert(strstr(buf, "[/CQ-SESSION]") != NULL);
    assert(strstr(buf, "[CQ-DICT")      != NULL);
    assert(strstr(buf, "[/CQ-DICT]")    != NULL);
    /* Both labels must appear */
    assert(strstr(buf, "charges")   != NULL);
    assert(strstr(buf, "customers") != NULL);
    printf("reinject_block: PASS\n");
}

/* -------------------------------------------------------------- resume      */

static void test_resume(cq_cache_t *cache, const char *session_id)
{
    section("session_open (resume existing)");

    char same_id[65];
    int rc = cq_session_open(cache, session_id, NULL, same_id);
    assert(rc == 0);
    assert(strcmp(same_id, session_id) == 0);

    cq_session_info_t info;
    cq_session_info(cache, session_id, &info);
    printf("Resumed session items: %ld\n", info.item_count);
    assert(info.item_count == 2);
    cq_session_info_free(&info);
    printf("resume: PASS\n");
}

/* ----------------------------------------------------------------- add dup  */

static void test_add_duplicate(cq_cache_t *cache, const char *session_id)
{
    section("session_add duplicate (idempotent)");

    /* Adding doc_a again should be a no-op (INSERT OR IGNORE) */
    int rc = cq_session_add(cache, session_id, doc_a, strlen(doc_a), "charges-dup");
    assert(rc == 0);

    cq_session_info_t info;
    cq_session_info(cache, session_id, &info);
    printf("Items after duplicate add: %ld (expected 2)\n", info.item_count);
    assert(info.item_count == 2);
    cq_session_info_free(&info);
    printf("add_duplicate: PASS\n");
}

/* ------------------------------------------------------------------ evict   */

static void test_evict(cq_cache_t *cache)
{
    section("session_evict_old");

    /* Days=0 → guard returns -1 */
    assert(cq_session_evict_old(cache, 0) == -1);

    /* Days=9999 → nothing removed */
    int r = cq_session_evict_old(cache, 9999);
    assert(r == 0);
    printf("Evict 9999 days: %d sessions removed (expected 0)\n", r);
    printf("evict: PASS\n");
}

/* ------------------------------------------------------------------- main   */

int main(void)
{
    printf("ContextQuant — Session Test Suite\n");

    remove(DB_PATH);

    cq_cache_t *cache = cq_cache_open(DB_PATH);
    assert(cache && "cq_cache_open failed");

    char session_id[65];

    test_open(cache, session_id);
    test_compress(cache, session_id);
    test_list(cache, session_id);
    test_reinject(cache, session_id);
    test_resume(cache, session_id);
    test_add_duplicate(cache, session_id);
    test_evict(cache);

    cq_cache_close(cache);
    remove(DB_PATH);

    printf("\nAll session tests passed.\n");
    return 0;
}
