#include "cq_session.h"

#include <sqlite3.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

/* ============================================================================
 * Internal helpers
 * ============================================================================ */

/* Generate a unique session ID: "<yyyymmddHHMMSS>_<pid4hex>"
 * 19 characters, readable, sortable, fits in char[65].             */
static void gen_session_id(char out[65])
{
    time_t t = time(NULL);
    struct tm *tm_info = localtime(&t);
    /* Use a second counter as tie-breaker if called multiple times/sec */
    static unsigned counter = 0;
    snprintf(out, 65, "%04d%02d%02d%02d%02d%02d_%04x",
             tm_info->tm_year + 1900,
             tm_info->tm_mon  + 1,
             tm_info->tm_mday,
             tm_info->tm_hour,
             tm_info->tm_min,
             tm_info->tm_sec,
             counter++ & 0xFFFFu);
}

/* SHA-256 of input → 8-char hex prefix (for display only). */
static void short_hash(const char *full_hex_64, char out[9])
{
    memcpy(out, full_hex_64, 8);
    out[8] = '\0';
}

/* ============================================================================
 * Public API
 * ============================================================================ */

void cq_session_info_free(cq_session_info_t *s)
{
    if (!s) return;
    free(s->project_dir);
    memset(s, 0, sizeof(*s));
}

/* -------------------------------------------------------------------------- */

int cq_session_open(cq_cache_t *cache,
                    const char *session_id,
                    const char *project_dir,
                    char        out_id[65])
{
    if (!cache || !out_id) return -1;

    sqlite3 *db = cq_cache_db(cache);
    char generated[65] = {0};

    if (!session_id || session_id[0] == '\0') {
        gen_session_id(generated);
        session_id = generated;
    }
    memcpy(out_id, session_id, 64);
    out_id[64] = '\0';

    long now = (long)time(NULL);

    /* Create if missing */
    const char *ins =
        "INSERT OR IGNORE INTO sessions (id, project_dir, created_at, last_used)"
        " VALUES (?, ?, ?, ?);";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, ins, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text (stmt, 1, session_id,               -1, SQLITE_STATIC);
    sqlite3_bind_text (stmt, 2, project_dir ? project_dir : "", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 3, (sqlite3_int64)now);
    sqlite3_bind_int64(stmt, 4, (sqlite3_int64)now);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    /* Touch last_used */
    const char *upd = "UPDATE sessions SET last_used = ? WHERE id = ?;";
    if (sqlite3_prepare_v2(db, upd, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_int64(stmt, 1, (sqlite3_int64)now);
    sqlite3_bind_text (stmt, 2, session_id, -1, SQLITE_STATIC);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return 0;
}

/* -------------------------------------------------------------------------- */

int cq_session_add(cq_cache_t *cache,
                   const char *session_id,
                   const char *input,
                   size_t      input_len,
                   const char *label)
{
    if (!cache || !session_id || !input) return -1;

    sqlite3 *db = cq_cache_db(cache);

    /* Compute the input hash to find the comp_id */
    cq_cache_entry_t entry;
    int found = cq_cache_lookup(cache, input, input_len, &entry);
    if (found <= 0) return 0;  /* not cached yet — silently skip */

    /* Retrieve the integer id for this compression */
    const char *id_sql =
        "SELECT id FROM compressions WHERE input_hash = ? LIMIT 1;";
    sqlite3_stmt *stmt = NULL;
    sqlite3_int64 comp_id = -1;
    if (sqlite3_prepare_v2(db, id_sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, entry.input_hash, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) == SQLITE_ROW)
            comp_id = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
    }
    cq_cache_entry_free(&entry);

    if (comp_id < 0) return 0;  /* compression not found — skip */

    long now = (long)time(NULL);
    const char *ins =
        "INSERT OR IGNORE INTO session_items"
        " (session_id, comp_id, label, added_at)"
        " VALUES (?, ?, ?, ?);";
    if (sqlite3_prepare_v2(db, ins, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text (stmt, 1, session_id, -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 2, comp_id);
    sqlite3_bind_text (stmt, 3, label ? label : "", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 4, (sqlite3_int64)now);
    int rc = sqlite3_step(stmt) == SQLITE_DONE ? 0 : -1;
    sqlite3_finalize(stmt);

    /* Update session last_used */
    const char *upd = "UPDATE sessions SET last_used = ? WHERE id = ?;";
    if (sqlite3_prepare_v2(db, upd, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, (sqlite3_int64)now);
        sqlite3_bind_text (stmt, 2, session_id, -1, SQLITE_STATIC);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }

    return rc;
}

/* -------------------------------------------------------------------------- */

int cq_session_reinject_block(cq_cache_t *cache,
                              const char *session_id,
                              char       *buf,
                              size_t      buf_size)
{
    if (!cache || !session_id || !buf || buf_size == 0) return -1;

    sqlite3 *db = cq_cache_db(cache);
    size_t pos = 0;

    /* Count items first for the header */
    const char *cnt_sql =
        "SELECT COUNT(*) FROM session_items WHERE session_id = ?;";
    sqlite3_stmt *stmt = NULL;
    long item_count = 0;
    if (sqlite3_prepare_v2(db, cnt_sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, session_id, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) == SQLITE_ROW)
            item_count = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
    }

    /* Short session ID (first 8 chars) */
    char sid8[9] = {0};
    memcpy(sid8, session_id, session_id[8] ? 8 : strlen(session_id));

    int n = snprintf(buf + pos, buf_size - pos,
                     "[CQ-SESSION id=%s items=%ld]\n", sid8, item_count);
    if (n < 0 || (size_t)n >= buf_size - pos) return -1;
    pos += (size_t)n;

    /* Retrieve each item's dict block */
    const char *sel =
        "SELECT c.input_hash,"
        "       CASE WHEN si.label != '' THEN si.label ELSE c.label END,"
        "       c.symbol_count, c.reduction_pct, c.dict_block"
        " FROM session_items si"
        " JOIN compressions c ON c.id = si.comp_id"
        " WHERE si.session_id = ?"
        " ORDER BY si.added_at ASC;";

    if (sqlite3_prepare_v2(db, sel, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text(stmt, 1, session_id, -1, SQLITE_STATIC);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *full_hash = (const char *)sqlite3_column_text(stmt, 0);
        const char *lbl       = (const char *)sqlite3_column_text(stmt, 1);
        int  sym_count        = sqlite3_column_int(stmt, 2);
        int  reduction        = sqlite3_column_int(stmt, 3);
        const char *dict_blk  = (const char *)sqlite3_column_text(stmt, 4);

        char sh[9] = {0};
        if (full_hash) short_hash(full_hash, sh);

        n = snprintf(buf + pos, buf_size - pos,
                     "[CQ-DICT label=\"%s\" hash=%s symbols=%d reduction=%d%%]\n"
                     "%s"
                     "[/CQ-DICT]\n",
                     lbl ? lbl : "(unlabelled)", sh,
                     sym_count, reduction,
                     dict_blk ? dict_blk : "");
        if (n < 0 || (size_t)n >= buf_size - pos) {
            sqlite3_finalize(stmt);
            return -1;
        }
        pos += (size_t)n;
    }
    sqlite3_finalize(stmt);

    n = snprintf(buf + pos, buf_size - pos, "[/CQ-SESSION]\n");
    if (n < 0 || (size_t)n >= buf_size - pos) return -1;
    pos += (size_t)n;

    return (int)pos;
}

/* -------------------------------------------------------------------------- */

int cq_session_list_items(cq_cache_t       *cache,
                          const char       *session_id,
                          cq_cache_entry_t *items,
                          int               max_items)
{
    if (!cache || !session_id || !items || max_items <= 0) return -1;

    sqlite3 *db = cq_cache_db(cache);
    const char *sql =
        "SELECT c.input_hash, c.format,"
        "       CASE WHEN si.label != '' THEN si.label ELSE c.label END,"
        "       c.input_size, c.compressed_size, c.reduction_pct,"
        "       c.dict_block, c.symbol_count, c.input_tokens,"
        "       c.output_tokens, c.created_at"
        " FROM session_items si"
        " JOIN compressions c ON c.id = si.comp_id"
        " WHERE si.session_id = ?"
        " ORDER BY si.added_at ASC"
        " LIMIT ?;";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text(stmt, 1, session_id, -1, SQLITE_STATIC);
    sqlite3_bind_int (stmt, 2, max_items);

    int filled = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && filled < max_items) {
        cq_cache_entry_t *e = &items[filled];
        memset(e, 0, sizeof(*e));

        const char *h = (const char *)sqlite3_column_text(stmt, 0);
        if (h) { memcpy(e->input_hash, h, 64); e->input_hash[64] = '\0'; }
        e->format         = sqlite3_column_int(stmt, 1);
        const char *lbl   = (const char *)sqlite3_column_text(stmt, 2);
        e->label          = lbl ? strdup(lbl) : NULL;
        e->input_size     = sqlite3_column_int64(stmt, 3);
        e->compressed_size= sqlite3_column_int64(stmt, 4);
        e->reduction_pct  = sqlite3_column_int(stmt, 5);
        const char *db_   = (const char *)sqlite3_column_text(stmt, 6);
        e->dict_block     = db_ ? strdup(db_) : NULL;
        e->symbol_count   = sqlite3_column_int(stmt, 7);
        e->input_tokens   = sqlite3_column_int64(stmt, 8);
        e->output_tokens  = sqlite3_column_int64(stmt, 9);
        e->created_at     = sqlite3_column_int64(stmt, 10);
        filled++;
    }
    sqlite3_finalize(stmt);
    return filled;
}

/* -------------------------------------------------------------------------- */

int cq_session_info(cq_cache_t        *cache,
                    const char        *session_id,
                    cq_session_info_t *out)
{
    if (!cache || !session_id || !out) return -1;
    memset(out, 0, sizeof(*out));

    sqlite3 *db = cq_cache_db(cache);
    const char *sql =
        "SELECT s.id, s.project_dir, s.created_at, s.last_used,"
        "       (SELECT COUNT(*) FROM session_items WHERE session_id = s.id)"
        " FROM sessions s WHERE s.id = ?;";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text(stmt, 1, session_id, -1, SQLITE_STATIC);

    if (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *id  = (const char *)sqlite3_column_text(stmt, 0);
        const char *dir = (const char *)sqlite3_column_text(stmt, 1);
        if (id) { memcpy(out->id, id, 64); out->id[64] = '\0'; }
        out->project_dir = (dir && dir[0]) ? strdup(dir) : NULL;
        out->created_at  = sqlite3_column_int64(stmt, 2);
        out->last_used   = sqlite3_column_int64(stmt, 3);
        out->item_count  = sqlite3_column_int64(stmt, 4);
    }
    sqlite3_finalize(stmt);
    return 0;
}

/* -------------------------------------------------------------------------- */

int cq_session_evict_old(cq_cache_t *cache, int days)
{
    if (!cache || days <= 0) return -1;

    sqlite3 *db  = cq_cache_db(cache);
    long cutoff  = (long)time(NULL) - (long)days * 86400L;

    /* Delete item links first (foreign key constraint) */
    char sql[256];
    snprintf(sql, sizeof(sql),
             "DELETE FROM session_items WHERE session_id IN"
             " (SELECT id FROM sessions WHERE last_used < %ld);", cutoff);
    sqlite3_exec(db, sql, NULL, NULL, NULL);

    snprintf(sql, sizeof(sql),
             "DELETE FROM sessions WHERE last_used < %ld;", cutoff);
    if (sqlite3_exec(db, sql, NULL, NULL, NULL) != SQLITE_OK) return -1;
    return sqlite3_changes(db);
}

/* -------------------------------------------------------------------------- */

int cq_session_compress(cq_cache_t        *cache,
                        const char        *session_id,
                        const char        *input,
                        size_t             input_len,
                        cq_format_t        fmt,
                        const cq_intent_t *intent,
                        const char        *label,
                        char              *out_buf,
                        size_t             out_buf_size,
                        char              *dict_buf,
                        size_t             dict_buf_size,
                        cq_dict_t         *dict_out,
                        cq_result_t       *result,
                        int               *cache_hit)
{
    int rc = cq_compress_cached(cache, input, input_len, fmt, intent, label,
                                out_buf, out_buf_size,
                                dict_buf, dict_buf_size,
                                dict_out, result, cache_hit);
    if (rc != 0) return -1;

    if (session_id && session_id[0])
        cq_session_add(cache, session_id, input, input_len, label);

    return 0;
}
