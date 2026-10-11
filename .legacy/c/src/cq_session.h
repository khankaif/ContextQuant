#ifndef CQ_SESSION_H
#define CQ_SESSION_H

/*
 * cq_session.h — Session continuity layer for ContextQuant.
 *
 * A session groups multiple compression results under a single ID.
 * When an LLM conversation compacts and loses the symbol tables, call
 * cq_session_reinject_block() to get a single consolidated prompt prefix
 * containing all dictionary blocks that were used in the session.
 *
 * The session ID is stable across process restarts (stored in SQLite).
 * Pass NULL for `session_id` to cq_session_open() to get a new auto ID.
 *
 * Typical SDK flow:
 *   1. cq_session_open()             — once per conversation
 *   2. cq_session_compress()         — for each document sent to the LLM
 *   3. cq_session_reinject_block()   — to recover after context compaction
 */

#include "cq_cache.h"
#include <stddef.h>

/* ------------------------------------------------------------------ types   */

typedef struct {
    char  id[65];        /* session identifier, null-terminated             */
    char *project_dir;   /* heap-allocated, may be NULL                     */
    long  created_at;    /* unix timestamp                                  */
    long  last_used;     /* unix timestamp                                  */
    long  item_count;    /* number of compressions linked                   */
} cq_session_info_t;

void cq_session_info_free(cq_session_info_t *s);

/* --------------------------------------------------------- open / resume    */

/*
 * Open or resume a session.
 *
 * If `session_id` is NULL, a new unique ID is generated and written to
 * `out_id`.  If non-NULL, that exact ID is used (created if missing,
 * resumed if already present).
 *
 * `project_dir` is optional metadata (pass NULL to skip).
 * `out_id` must point to a char[65] buffer.
 *
 * Returns 0 on success, -1 on error.
 */
int cq_session_open(cq_cache_t *cache,
                    const char *session_id,
                    const char *project_dir,
                    char        out_id[65]);

/* --------------------------------------------------------------- add item   */

/*
 * Link a cached compression to a session.
 *
 * Looks up the compression by SHA-256 of `input`.  Silently skips if the
 * input has not been compressed yet (call cq_session_compress instead).
 * `label` is optional; overrides the compression's own label for this
 * session (useful for per-session human tagging).
 *
 * Returns 0 on success (including silent skip), -1 on error.
 */
int cq_session_add(cq_cache_t *cache,
                   const char *session_id,
                   const char *input,
                   size_t      input_len,
                   const char *label);

/* ---------------------------------------------------------- re-injection    */

/*
 * Build a consolidated re-injection block for all items in the session.
 * Suitable for use as a system-prompt prefix after context compaction.
 *
 * Format:
 *   [CQ-SESSION id=<short_id> items=N]
 *   [CQ-DICT label=<label> hash=<short_hash> symbols=N reduction=N%]
 *   ^0 = 'value'
 *   ...
 *   [/CQ-DICT]
 *   ...
 *   [/CQ-SESSION]
 *
 * Writes into `buf`.  Returns bytes written or -1.
 */
int cq_session_reinject_block(cq_cache_t *cache,
                              const char *session_id,
                              char       *buf,
                              size_t      buf_size);

/* --------------------------------------------------------------- inspect    */

/*
 * List all items in a session.  `items` must hold at least `max_items`
 * cq_cache_entry_t structs.  Caller must call cq_cache_entry_free() on
 * each entry after use.
 *
 * Returns number of items filled, or -1 on error.
 */
int cq_session_list_items(cq_cache_t       *cache,
                          const char       *session_id,
                          cq_cache_entry_t *items,
                          int               max_items);

/*
 * Retrieve session metadata.  Caller must call cq_session_info_free() after.
 * Returns 0 on success (including not-found → zeroed struct), -1 on error.
 */
int cq_session_info(cq_cache_t        *cache,
                    const char        *session_id,
                    cq_session_info_t *out);

/* ------------------------------------------------------------- housekeep    */

/*
 * Delete sessions (and their item links) not accessed in the last `days`
 * days.  The underlying compression records are NOT deleted.
 * Returns rows deleted or -1.
 */
int cq_session_evict_old(cq_cache_t *cache, int days);

/* ----------------------------------------------------------- combined API   */

/*
 * Compress + cache + add to session in one call.
 * Thin wrapper: cq_compress_cached() followed by cq_session_add().
 *
 * Returns 0 on success, -1 on error.
 */
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
                        int               *cache_hit);

#endif /* CQ_SESSION_H */
