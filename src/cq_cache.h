#ifndef CQ_CACHE_H
#define CQ_CACHE_H

/*
 * cq_cache.h — SQLite-backed compression cache for ContextQuant.
 *
 * Stores the dictionary block from each compression, keyed by SHA-256 of the
 * raw input.  When a conversation compacts and the LLM loses its symbol table,
 * the caller can retrieve and re-inject the dict block without re-reading or
 * re-compressing the original file.
 *
 * The compressed payload itself is NOT stored (too large).  The dict block is
 * all that is needed for re-injection — it is < 256 KB even at 256 symbols.
 *
 * Thread-safety: one handle per thread.  Open separate handles for concurrent
 * use; SQLite WAL mode keeps them from blocking each other.
 */

#include "cq_types.h"
#include "cq_compress.h"   /* cq_result_t, cq_dict_t */
#include <stddef.h>

/* ------------------------------------------------------------------ types   */

typedef struct cq_cache cq_cache_t;   /* opaque */

typedef struct {
    char   input_hash[65];     /* hex SHA-256, null-terminated            */
    int    format;             /* cq_format_t                             */
    char  *label;              /* heap-allocated human label (may be NULL)*/
    long   input_size;         /* bytes                                   */
    long   compressed_size;    /* bytes (payload + dict block combined)   */
    int    reduction_pct;      /* 0-100                                   */
    char  *dict_block;         /* heap-allocated prompt-ready dict string */
    int    symbol_count;
    long   input_tokens;
    long   output_tokens;
    long   created_at;         /* unix timestamp                          */
} cq_cache_entry_t;

typedef struct {
    long   total_entries;
    long   total_input_bytes;
    long   total_saved_bytes;
    double avg_reduction_pct;
} cq_cache_stats_t;

/* ----------------------------------------------------------- open / close   */

/*
 * Open (or create) the cache database at `db_path`.
 * Returns NULL on failure.
 */
cq_cache_t *cq_cache_open(const char *db_path);

void cq_cache_close(cq_cache_t *cache);

/* ----------------------------------------------------------------- store    */

/*
 * Persist a compression result.  `label` is optional (pass NULL).
 * Silently overwrites any existing entry for the same input hash.
 * Returns 0 on success, -1 on error.
 */
int cq_cache_store(cq_cache_t    *cache,
                   const char    *input,
                   size_t         input_len,
                   cq_format_t    fmt,
                   const char    *label,
                   const cq_result_t *result);

/* ----------------------------------------------------------------- lookup   */

/*
 * Look up by raw input bytes.
 * Returns  1 → hit:  `out` populated (call cq_cache_entry_free when done)
 *          0 → miss
 *         -1 → error
 */
int cq_cache_lookup(cq_cache_t       *cache,
                    const char       *input,
                    size_t            input_len,
                    cq_cache_entry_t *out);

void cq_cache_entry_free(cq_cache_entry_t *e);

/* --------------------------------------------------------- re-injection     */

/*
 * Build a formatted re-injection block suitable for an LLM system prompt.
 * Format:
 *   [CQ-DICT label=<label> hash=<short_hash> symbols=<N>]
 *   ^0 = 'value'
 *   ^1 = 'value'
 *   ...
 *   [/CQ-DICT]
 *
 * Writes into `buf`.  Returns bytes written or -1.
 */
int cq_cache_reinject_block(const cq_cache_entry_t *entry,
                            char *buf, size_t buf_size);

/* ---------------------------------------------------------------- combined  */

/*
 * Compress with automatic cache check-and-store.
 *
 * On CACHE HIT : skips the expensive ngram scan; runs only the fast rewrite
 *                pass using the cached dict.  Sets *cache_hit = 1.
 * On CACHE MISS: runs full compression, stores result.  Sets *cache_hit = 0.
 *
 * `label`     optional human label stored in cache (pass NULL to skip)
 * `cache_hit` may be NULL if the caller doesn't need it
 *
 * Returns 0 on success, -1 on error.
 */
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
                       int               *cache_hit);

/* --------------------------------------------------------- internal access  */

/*
 * Returns the raw sqlite3 handle.  Intended for use by cq_session.c only.
 * Do not use from SDK-layer code.
 */
struct sqlite3 *cq_cache_db(cq_cache_t *cache);

/* ---------------------------------------------------------------- housekeep */

/* Delete entries older than `days` days.  Returns rows deleted or -1. */
int cq_cache_evict_old(cq_cache_t *cache, int days);

int cq_cache_stats(cq_cache_t *cache, cq_cache_stats_t *out);

#endif /* CQ_CACHE_H */
