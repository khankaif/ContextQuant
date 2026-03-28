#include "cq_ngram.h"

#include <string.h>
#include <stdlib.h>
#include <stdint.h>

/* --------------------------------------------------------------------------
 * Token-count heuristic
 * --------------------------------------------------------------------------
 * GPT-family tokenisers average ~4 bytes per token for English/JSON text.
 */
int cq_approx_token_count(const char *str, size_t len)
{
    (void)str;
    if (len == 0) return 0;
    return (int)((len + 3) / 4);   /* ceil(len / 4) */
}

/* --------------------------------------------------------------------------
 * Syntax-only overhead (tokens) for one dict entry line "^N = '...'\n"
 * -------------------------------------------------------------------------- */
#define CQ_DICT_SYNTAX_TOKENS 2

/* --------------------------------------------------------------------------
 * Internal frequency hash table
 *
 * Design:
 *   - Open addressing, linear probing, power-of-2 size for fast modulo.
 *   - Strings stored in a separate pool (no per-entry heap alloc).
 *   - FNV-1a hash for speed and good distribution on short strings.
 *   - Load factor capped at 70%: once occupied >= HT_MAX_LOAD, new unique
 *     strings are dropped (existing ones still get their frequency bumped).
 *     This guarantees O(1) amortised probe cost regardless of input size.
 *
 * Memory footprint (heap-allocated, freed before returning):
 *   slots : HT_SLOTS * 20 bytes = ~20 MB
 *   pool  : POOL_SIZE           =  24 MB
 *   total :                       ~44 MB
 * -------------------------------------------------------------------------- */

#define HT_SLOTS    (1u << 20)              /* 1 048 576 buckets            */
#define HT_MASK     (HT_SLOTS - 1)
#define HT_MAX_LOAD (HT_SLOTS * 7 / 10)    /* 70% — hard cap on inserts    */
#define POOL_SIZE   (24u * 1024u * 1024u)   /* 24 MB string pool            */
#define SLOT_EMPTY  UINT32_MAX

typedef struct {
    uint64_t hash;
    uint32_t pool_off;   /* byte offset into pool[], SLOT_EMPTY = unused */
    uint32_t str_len;
    uint32_t frequency;
} ht_slot_t;

typedef struct {
    ht_slot_t *slots;      /* heap, HT_SLOTS entries */
    char      *pool;       /* heap, POOL_SIZE bytes  */
    uint32_t   pool_used;
    uint32_t   occupied;   /* number of filled slots (for load-factor check) */
} freq_ht_t;

/* FNV-1a 64-bit */
static uint64_t fnv1a(const char *s, size_t len)
{
    uint64_t h = 14695981039346656037ULL;
    for (size_t i = 0; i < len; i++) {
        h ^= (uint8_t)s[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static freq_ht_t *ht_alloc(void)
{
    freq_ht_t *ht = malloc(sizeof(freq_ht_t));
    if (!ht) return NULL;

    ht->slots = malloc(HT_SLOTS * sizeof(ht_slot_t));
    ht->pool  = malloc(POOL_SIZE);
    if (!ht->slots || !ht->pool) { free(ht->slots); free(ht->pool); free(ht); return NULL; }

    /* Mark all slots empty — memset works because SLOT_EMPTY = 0xFFFFFFFF */
    memset(ht->slots, 0xFF, HT_SLOTS * sizeof(ht_slot_t));
    ht->pool_used = 0;
    ht->occupied  = 0;
    return ht;
}

static void ht_free(freq_ht_t *ht)
{
    if (!ht) return;
    free(ht->slots);
    free(ht->pool);
    free(ht);
}

/* Record one string occurrence.  O(1) amortised (load factor <= 70%). */
static void ht_record(freq_ht_t *ht, const char *text, size_t len)
{
    if (len == 0 || len >= CQ_MAX_TOKEN_LEN) return;

    uint64_t h   = fnv1a(text, len);
    uint32_t idx = (uint32_t)(h & HT_MASK);

    for (uint32_t probe = 0; probe < HT_SLOTS; probe++) {
        ht_slot_t *s = &ht->slots[(idx + probe) & HT_MASK];

        if (s->pool_off == SLOT_EMPTY) {
            /* Empty slot — insert only if we're under the load-factor cap. */
            if (ht->occupied >= HT_MAX_LOAD) return;   /* drop new uniques   */
            if (ht->pool_used + len + 1 > POOL_SIZE)   return;   /* pool full */
            s->hash      = h;
            s->pool_off  = ht->pool_used;
            s->str_len   = (uint32_t)len;
            s->frequency = 1;
            memcpy(ht->pool + ht->pool_used, text, len);
            ht->pool[ht->pool_used + len] = '\0';
            ht->pool_used += (uint32_t)(len + 1);
            ht->occupied++;
            return;
        }

        if (s->hash == h && s->str_len == (uint32_t)len &&
            memcmp(ht->pool + s->pool_off, text, len) == 0) {
            s->frequency++;   /* existing entry — always update */
            return;
        }
        /* Hash collision — probe next slot */
    }
    /* Table 100% full (impossible at <=70% load with power-of-2 size) */
}

/* --------------------------------------------------------------------------
 * JSON string extraction
 *
 * Walks byte-by-byte, extracts every '"…"'-delimited span, feeds it to
 * ht_record.  Escape sequences are skipped without interpretation so
 * the recorded bytes are byte-identical to what compression will re-emit.
 * -------------------------------------------------------------------------- */
static void extract_strings(const char *input, size_t input_len, freq_ht_t *ht)
{
    size_t i = 0;
    while (i < input_len) {
        if (input[i] != '"') { i++; continue; }

        size_t start = i + 1;
        size_t j     = start;
        while (j < input_len) {
            if (input[j] == '\\') { j += 2; continue; }
            if (input[j] == '"')  break;
            j++;
        }
        if (j < input_len) ht_record(ht, input + start, j - start);
        i = j + 1;
    }
}

/* --------------------------------------------------------------------------
 * Comparator: sort candidates by net_saving descending
 * -------------------------------------------------------------------------- */
static int cmp_by_saving(const void *a, const void *b)
{
    const cq_candidate_t *ca = (const cq_candidate_t *)a;
    const cq_candidate_t *cb = (const cq_candidate_t *)b;
    if (cb->net_saving > ca->net_saving) return  1;
    if (cb->net_saving < ca->net_saving) return -1;
    return 0;
}

/* --------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */
int cq_ngram_scan(const char *input, size_t input_len,
                  cq_candidate_list_t *out)
{
    if (!input || !out) return -1;
    memset(out, 0, sizeof(*out));

    /* --- Phase 1: count frequencies via hash table --- */
    freq_ht_t *ht = ht_alloc();
    if (!ht) return -1;

    extract_strings(input, input_len, ht);

    /* --- Phase 2: collect candidates with positive net saving --- */

    /* Temporary dynamic array for good candidates before top-N selection. */
    size_t         tmp_cap   = 4096;
    cq_candidate_t *tmp      = malloc(tmp_cap * sizeof(cq_candidate_t));
    size_t          tmp_count = 0;

    if (!tmp) { ht_free(ht); return -1; }

    for (uint32_t i = 0; i < HT_SLOTS; i++) {
        const ht_slot_t *s = &ht->slots[i];
        if (s->pool_off == SLOT_EMPTY || s->frequency < 2) continue;

        int  tl  = cq_approx_token_count(ht->pool + s->pool_off, s->str_len);
        long ps  = (long)(tl - 1) * (long)s->frequency;          /* payload saving */
        long dc  = (long)tl + (long)CQ_DICT_SYNTAX_TOKENS;       /* dict cost      */
        long net = ps - dc;
        if (net <= 0) continue;

        if (tmp_count >= tmp_cap) {
            size_t new_cap = tmp_cap * 2;
            cq_candidate_t *t2 = realloc(tmp, new_cap * sizeof(cq_candidate_t));
            if (!t2) break;   /* stop collecting, work with what we have */
            tmp     = t2;
            tmp_cap = new_cap;
        }

        cq_candidate_t *c = &tmp[tmp_count++];
        memcpy(c->text, ht->pool + s->pool_off, s->str_len);
        c->text[s->str_len] = '\0';
        c->length    = s->str_len;
        c->frequency = s->frequency;
        c->token_len = tl;
        c->net_saving = net;
    }

    ht_free(ht);   /* done with the hash table */

    /* --- Phase 3: sort and copy top CQ_MAX_CANDIDATES into out --- */
    qsort(tmp, tmp_count, sizeof(cq_candidate_t), cmp_by_saving);

    size_t copy = tmp_count < CQ_MAX_CANDIDATES ? tmp_count : CQ_MAX_CANDIDATES;
    memcpy(out->items, tmp, copy * sizeof(cq_candidate_t));
    out->count = copy;

    free(tmp);
    return (int)copy;
}
