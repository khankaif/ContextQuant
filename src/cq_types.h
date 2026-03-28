#ifndef CQ_TYPES_H
#define CQ_TYPES_H

/*
 * cq_types.h — Shared type definitions for the ContextQuant public API.
 *
 * Kept separate so SDK bindings (Python, Node) can include just this header
 * to understand the format enum without pulling in the full compression API.
 */

typedef enum {
    CQ_FMT_JSON  = 0,   /* JSON / API payloads                     */
    CQ_FMT_CSV   = 1,   /* CSV / TSV tabular data                  */
    CQ_FMT_LOG   = 2,   /* Plain text logs, server traces          */
    CQ_FMT_CODE  = 3,   /* Source code (JS, Python, Go, etc.)      */
    CQ_FMT_COUNT = 4    /* Sentinel — always keep last             */
} cq_format_t;

/*
 * Derive format from a file path based on extension.
 * Returns CQ_FMT_JSON as the default for unknown extensions.
 */
cq_format_t cq_format_from_path(const char *path);

#endif /* CQ_TYPES_H */
