#include "cq_cache.h"
#include "cq_ngram.h"    /* cq_approx_token_count */

#include <sqlite3.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <stdint.h>

/* ============================================================================
 * Minimal SHA-256 (RFC 6234 / FIPS 180-4).
 * No external dependency — keeps the library self-contained.
 * ============================================================================ */

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
    0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
    0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
    0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
    0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

static void sha256_block(uint32_t h[8], const uint8_t *blk)
{
    uint32_t w[64], a,b,c,d,e,f,g,hh, t1,t2;
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)blk[i*4]<<24)|((uint32_t)blk[i*4+1]<<16)|
               ((uint32_t)blk[i*4+2]<<8)|(uint32_t)blk[i*4+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR32(w[i-15],7)^ROR32(w[i-15],18)^(w[i-15]>>3);
        uint32_t s1 = ROR32(w[i-2],17)^ROR32(w[i-2],19)^(w[i-2]>>10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROR32(e,6)^ROR32(e,11)^ROR32(e,25);
        uint32_t ch = (e&f)^(~e&g);
        t1 = hh + S1 + ch + K[i] + w[i];
        uint32_t S0 = ROR32(a,2)^ROR32(a,13)^ROR32(a,22);
        uint32_t maj = (a&b)^(a&c)^(b&c);
        t2 = S0 + maj;
        hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
}

static void sha256(const uint8_t *msg, size_t len, uint8_t out[32])
{
    uint32_t h[8] = {
        0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
        0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
    };
    uint8_t blk[64];
    size_t i;
    for (i = 0; i + 64 <= len; i += 64) sha256_block(h, msg + i);

    size_t rem = len - i;
    memcpy(blk, msg + i, rem);
    blk[rem++] = 0x80;
    if (rem > 56) { memset(blk+rem,0,64-rem); sha256_block(h,blk); rem=0; }
    memset(blk+rem, 0, 56-rem);
    uint64_t bits = (uint64_t)len * 8;
    for (int j = 7; j >= 0; j--) { blk[56+j] = (uint8_t)(bits & 0xff); bits >>= 8; }
    sha256_block(h, blk);

    for (int j = 0; j < 8; j++) {
        out[j*4]   = (uint8_t)(h[j]>>24);
        out[j*4+1] = (uint8_t)(h[j]>>16);
        out[j*4+2] = (uint8_t)(h[j]>>8);
        out[j*4+3] = (uint8_t)(h[j]);
    }
}

static void sha256_hex(const uint8_t *msg, size_t len, char hex[65])
{
    uint8_t digest[32];
    sha256(msg, len, digest);
    static const char hx[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        hex[i*2]   = hx[digest[i] >> 4];
        hex[i*2+1] = hx[digest[i] & 0xf];
    }
    hex[64] = '\0';
}

/* ============================================================================
 * Dict serialisation: cq_dict_t ↔ compact text
 *
 * Format (one line per symbol):
 *   <id>:<quoted>:<base64-or-raw-text>\n
 *
 * We use ':' as delimiter and percent-encode colons and newlines in the text
 * to keep it single-line.  This is simpler and more debuggable than binary.
 * ============================================================================ */

/* Percent-encode a string: replace ':' → %3A, '\n' → %0A, '%' → %25 */
static int pct_encode(const char *src, size_t slen, char *dst, size_t dsize)
{
    size_t o = 0;
    for (size_t i = 0; i < slen; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == ':' || c == '\n' || c == '%') {
            if (o + 3 >= dsize) return -1;
            dst[o++] = '%';
            dst[o++] = "0123456789ABCDEF"[c >> 4];
            dst[o++] = "0123456789ABCDEF"[c & 0xf];
        } else {
            if (o + 1 >= dsize) return -1;
            dst[o++] = (char)c;
        }
    }
    dst[o] = '\0';
    return (int)o;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
}

static int pct_decode(const char *src, size_t slen, char *dst, size_t dsize)
{
    size_t o = 0;
    for (size_t i = 0; i < slen; ) {
        if (src[i] == '%' && i + 2 < slen) {
            if (o + 1 >= dsize) return -1;
            dst[o++] = (char)((hexval(src[i+1]) << 4) | hexval(src[i+2]));
            i += 3;
        } else {
            if (o + 1 >= dsize) return -1;
            dst[o++] = src[i++];
        }
    }
    dst[o] = '\0';
    return (int)o;
}

/* Serialise dict → heap-allocated string.  Caller must free(). */
static char *dict_serialise(const cq_dict_t *dict)
{
    /* Each line: "<id>:<quoted>:<encoded_text>\n" — max ~700 chars per symbol */
    size_t cap = (size_t)dict->count * 700 + 16;
    char *out = malloc(cap);
    if (!out) return NULL;
    size_t pos = 0;
    char enc[CQ_MAX_TOKEN_LEN * 3 + 4];
    for (size_t i = 0; i < dict->count; i++) {
        const cq_symbol_t *s = &dict->entries[i];
        if (pct_encode(s->original, s->original_len, enc, sizeof(enc)) < 0) { free(out); return NULL; }
        int n = snprintf(out + pos, cap - pos, "%d:%d:%s\n",
                         s->symbol_id, s->quoted, enc);
        if (n < 0 || (size_t)n >= cap - pos) { free(out); return NULL; }
        pos += (size_t)n;
    }
    out[pos] = '\0';
    return out;
}

/* Deserialise back into a cq_dict_t. */
static int dict_deserialise(const char *serialised, cq_dict_t *dict)
{
    if (!serialised || !dict) return -1;
    memset(dict, 0, sizeof(*dict));
    const char *p = serialised;
    while (*p && dict->count < CQ_MAX_SYMBOLS) {
        cq_symbol_t *s = &dict->entries[dict->count];

        /* id */
        char *end;
        s->symbol_id = (int)strtol(p, &end, 10);
        if (*end != ':') return -1;
        p = end + 1;

        /* quoted */
        s->quoted = (int)strtol(p, &end, 10);
        if (*end != ':') return -1;
        p = end + 1;

        /* encoded text — ends at '\n' */
        const char *nl = strchr(p, '\n');
        size_t elen = nl ? (size_t)(nl - p) : strlen(p);
        int dlen = pct_decode(p, elen, s->original, sizeof(s->original));
        if (dlen < 0) return -1;
        s->original_len = (size_t)dlen;
        dict->count++;
        p = nl ? nl + 1 : p + elen;
    }
    return (int)dict->count;
}

/* ============================================================================
 * SQLite schema & handle
 * ============================================================================ */

#define SCHEMA \
    "CREATE TABLE IF NOT EXISTS compressions (" \
    "  id              INTEGER PRIMARY KEY AUTOINCREMENT," \
    "  input_hash      TEXT    NOT NULL UNIQUE," \
    "  format          INTEGER NOT NULL," \
    "  label           TEXT," \
    "  input_size      INTEGER NOT NULL," \
    "  compressed_size INTEGER NOT NULL," \
    "  reduction_pct   INTEGER NOT NULL," \
    "  dict_block      TEXT    NOT NULL," \
    "  dict_serial     TEXT    NOT NULL," \
    "  symbol_count    INTEGER NOT NULL," \
    "  input_tokens    INTEGER NOT NULL," \
    "  output_tokens   INTEGER NOT NULL," \
    "  created_at      INTEGER NOT NULL" \
    ");" \
    "CREATE INDEX IF NOT EXISTS idx_hash ON compressions(input_hash);" \
    "CREATE INDEX IF NOT EXISTS idx_created ON compressions(created_at);" \
    "CREATE TABLE IF NOT EXISTS sessions (" \
    "  id          TEXT    PRIMARY KEY," \
    "  project_dir TEXT," \
    "  created_at  INTEGER NOT NULL," \
    "  last_used   INTEGER NOT NULL" \
    ");" \
    "CREATE TABLE IF NOT EXISTS session_items (" \
    "  session_id  TEXT    NOT NULL REFERENCES sessions(id)," \
    "  comp_id     INTEGER NOT NULL REFERENCES compressions(id)," \
    "  label       TEXT," \
    "  added_at    INTEGER NOT NULL," \
    "  PRIMARY KEY (session_id, comp_id)" \
    ");"

struct cq_cache {
    sqlite3 *db;
};

/* ============================================================================
 * Public API
 * ============================================================================ */

cq_cache_t *cq_cache_open(const char *db_path)
{
    if (!db_path) return NULL;
    cq_cache_t *c = calloc(1, sizeof(cq_cache_t));
    if (!c) return NULL;

    if (sqlite3_open(db_path, &c->db) != SQLITE_OK) { free(c); return NULL; }

    /* Enable WAL for concurrent read/write */
    sqlite3_exec(c->db, "PRAGMA journal_mode=WAL;", NULL, NULL, NULL);
    sqlite3_exec(c->db, "PRAGMA synchronous=NORMAL;", NULL, NULL, NULL);

    if (sqlite3_exec(c->db, SCHEMA, NULL, NULL, NULL) != SQLITE_OK) {
        sqlite3_close(c->db); free(c); return NULL;
    }
    return c;
}

struct sqlite3 *cq_cache_db(cq_cache_t *cache)
{
    return cache ? cache->db : NULL;
}

void cq_cache_close(cq_cache_t *cache)
{
    if (!cache) return;
    sqlite3_close(cache->db);
    free(cache);
}

/* -------------------------------------------------------------------------- */

int cq_cache_store(cq_cache_t *cache,
                   const char *input, size_t input_len,
                   cq_format_t fmt, const char *label,
                   const cq_result_t *result)
{
    if (!cache || !input || !result) return -1;

    /* We need the dict_t to serialise it.  The dict_block text is already
     * in result->dict_block; we need the serialised form separately.
     * Caller stores result which has dict_block — we accept it from result. */

    char hex[65];
    sha256_hex((const uint8_t *)input, input_len, hex);

    long compressed_size = (long)(result->compressed_len + result->dict_block_len);
    int  pct = (input_len > 0)
               ? (int)(((long)input_len - compressed_size) * 100 / (long)input_len)
               : 0;

    /* We don't have dict_serial here; store NULL for now — updated via
     * cq_compress_cached which has the full cq_dict_t. */
    const char *sql =
        "INSERT OR REPLACE INTO compressions "
        "(input_hash,format,label,input_size,compressed_size,reduction_pct,"
        " dict_block,dict_serial,symbol_count,input_tokens,output_tokens,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?);";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(cache->db, sql, -1, &stmt, NULL) != SQLITE_OK) return -1;

    sqlite3_bind_text(stmt, 1, hex, -1, SQLITE_STATIC);
    sqlite3_bind_int (stmt, 2, (int)fmt);
    sqlite3_bind_text(stmt, 3, label ? label : "", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 4, (sqlite3_int64)input_len);
    sqlite3_bind_int64(stmt, 5, (sqlite3_int64)compressed_size);
    sqlite3_bind_int (stmt, 6, pct);
    sqlite3_bind_text(stmt, 7, result->dict_block, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 8, "",  -1, SQLITE_STATIC);  /* serial filled by compress_cached */
    sqlite3_bind_int (stmt, 9, result->symbol_count);
    sqlite3_bind_int64(stmt,10, (sqlite3_int64)result->input_tokens);
    sqlite3_bind_int64(stmt,11, (sqlite3_int64)result->output_tokens);
    sqlite3_bind_int64(stmt,12, (sqlite3_int64)time(NULL));

    int rc = sqlite3_step(stmt) == SQLITE_DONE ? 0 : -1;
    sqlite3_finalize(stmt);
    return rc;
}

/* -------------------------------------------------------------------------- */

int cq_cache_lookup(cq_cache_t *cache,
                    const char *input, size_t input_len,
                    cq_cache_entry_t *out)
{
    if (!cache || !input || !out) return -1;
    memset(out, 0, sizeof(*out));

    char hex[65];
    sha256_hex((const uint8_t *)input, input_len, hex);

    const char *sql =
        "SELECT input_hash,format,label,input_size,compressed_size,"
        "       reduction_pct,dict_block,symbol_count,input_tokens,"
        "       output_tokens,created_at "
        "FROM compressions WHERE input_hash = ? LIMIT 1;";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(cache->db, sql, -1, &stmt, NULL) != SQLITE_OK) return -1;
    sqlite3_bind_text(stmt, 1, hex, -1, SQLITE_STATIC);

    int found = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        memcpy(out->input_hash, sqlite3_column_text(stmt, 0), 64);
        out->input_hash[64] = '\0';
        out->format         = sqlite3_column_int(stmt, 1);
        const char *lbl     = (const char *)sqlite3_column_text(stmt, 2);
        out->label          = lbl ? strdup(lbl) : NULL;
        out->input_size     = sqlite3_column_int64(stmt, 3);
        out->compressed_size= sqlite3_column_int64(stmt, 4);
        out->reduction_pct  = sqlite3_column_int(stmt, 5);
        const char *db      = (const char *)sqlite3_column_text(stmt, 6);
        out->dict_block     = db ? strdup(db) : NULL;
        out->symbol_count   = sqlite3_column_int(stmt, 7);
        out->input_tokens   = sqlite3_column_int64(stmt, 8);
        out->output_tokens  = sqlite3_column_int64(stmt, 9);
        out->created_at     = sqlite3_column_int64(stmt, 10);
        found = 1;
    }
    sqlite3_finalize(stmt);
    return found;   /* 0 = miss, 1 = hit */
}

void cq_cache_entry_free(cq_cache_entry_t *e)
{
    if (!e) return;
    free(e->label);
    free(e->dict_block);
    memset(e, 0, sizeof(*e));
}

/* -------------------------------------------------------------------------- */

int cq_cache_reinject_block(const cq_cache_entry_t *entry,
                            char *buf, size_t buf_size)
{
    if (!entry || !buf || buf_size == 0) return -1;

    /* Short hash (first 8 chars) for the tag */
    char short_hash[9] = {0};
    memcpy(short_hash, entry->input_hash, 8);

    int n = snprintf(buf, buf_size,
        "[CQ-DICT label=\"%s\" hash=%s symbols=%d reduction=%d%%]\n"
        "%s"
        "[/CQ-DICT]\n",
        entry->label ? entry->label : "(unlabelled)",
        short_hash,
        entry->symbol_count,
        entry->reduction_pct,
        entry->dict_block ? entry->dict_block : "");

    return (n < 0 || (size_t)n >= buf_size) ? -1 : n;
}

/* -------------------------------------------------------------------------- */

int cq_compress_cached(cq_cache_t        *cache,
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
    if (cache_hit) *cache_hit = 0;
    int was_hit = 0;

    /* --- cache check --- */
    if (cache) {
        char hex[65];
        sha256_hex((const uint8_t *)input, input_len, hex);

        const char *sql =
            "SELECT dict_block, dict_serial FROM compressions "
            "WHERE input_hash = ? LIMIT 1;";
        sqlite3_stmt *stmt = NULL;
        if (sqlite3_prepare_v2(cache->db, sql, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_text(stmt, 1, hex, -1, SQLITE_STATIC);
            if (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *db_text  = (const char *)sqlite3_column_text(stmt, 0);
                const char *ser_text = (const char *)sqlite3_column_text(stmt, 1);

                if (ser_text && *ser_text &&
                    dict_deserialise(ser_text, dict_out) > 0) {

                    if (db_text) {
                        size_t dlen = strlen(db_text);
                        if (dlen < dict_buf_size)
                            memcpy(dict_buf, db_text, dlen + 1);
                    }
                    was_hit = 1;
                    if (cache_hit) *cache_hit = 1;
                }
            }
            sqlite3_finalize(stmt);
        }
    }

    /* --- full compression (always — no separate rewrite-only path yet) ---
     * TODO: expose cq_rewrite() to skip the ngram scan on cache hits.       */
    int rc = cq_compress(input, input_len, fmt, intent,
                         out_buf, out_buf_size,
                         dict_buf, dict_buf_size,
                         dict_out, result);
    if (rc != 0) return -1;

    /* --- store result in cache (skip if already stored) --- */
    if (cache && !was_hit) {
        char hex[65];
        sha256_hex((const uint8_t *)input, input_len, hex);

        char *serial = dict_serialise(dict_out);
        if (serial) {
            cq_cache_store(cache, input, input_len, fmt, label, result);

            const char *upd =
                "UPDATE compressions SET dict_serial = ? WHERE input_hash = ?;";
            sqlite3_stmt *stmt = NULL;
            if (sqlite3_prepare_v2(cache->db, upd, -1, &stmt, NULL) == SQLITE_OK) {
                sqlite3_bind_text(stmt, 1, serial, -1, SQLITE_STATIC);
                sqlite3_bind_text(stmt, 2, hex,    -1, SQLITE_STATIC);
                sqlite3_step(stmt);
                sqlite3_finalize(stmt);
            }
            free(serial);
        }
    }
    return 0;
}

/* -------------------------------------------------------------------------- */

int cq_cache_evict_old(cq_cache_t *cache, int days)
{
    if (!cache || days <= 0) return -1;
    long cutoff = (long)time(NULL) - (long)days * 86400L;
    char sql[128];
    snprintf(sql, sizeof(sql),
             "DELETE FROM compressions WHERE created_at < %ld;", cutoff);
    if (sqlite3_exec(cache->db, sql, NULL, NULL, NULL) != SQLITE_OK) return -1;
    return sqlite3_changes(cache->db);
}

int cq_cache_stats(cq_cache_t *cache, cq_cache_stats_t *out)
{
    if (!cache || !out) return -1;
    memset(out, 0, sizeof(*out));

    const char *sql =
        "SELECT COUNT(*), SUM(input_size), SUM(input_size - compressed_size),"
        "       AVG(reduction_pct) FROM compressions;";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(cache->db, sql, -1, &stmt, NULL) != SQLITE_OK) return -1;

    if (sqlite3_step(stmt) == SQLITE_ROW) {
        out->total_entries     = sqlite3_column_int64(stmt, 0);
        out->total_input_bytes = sqlite3_column_int64(stmt, 1);
        out->total_saved_bytes = sqlite3_column_int64(stmt, 2);
        out->avg_reduction_pct = sqlite3_column_double(stmt, 3);
    }
    sqlite3_finalize(stmt);
    return 0;
}
