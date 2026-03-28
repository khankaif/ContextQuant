#include "cq_ngram.h"

#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <ctype.h>

/* --------------------------------------------------------------------------
 * Token-count heuristic  (~4 bytes/token for English/JSON text)
 * -------------------------------------------------------------------------- */
int cq_approx_token_count(const char *str, size_t len)
{
    (void)str;
    if (len == 0) return 0;
    return (int)((len + 3) / 4);
}

#define CQ_DICT_SYNTAX_TOKENS 2

/* --------------------------------------------------------------------------
 * Internal frequency hash table
 *
 * Open addressing + linear probing, power-of-2 bucket count.
 * Load factor capped at 70%: once occupied >= HT_MAX_LOAD, new unique
 * strings are dropped (existing entries still get their frequency bumped).
 * This guarantees O(1) amortised probe cost for any input size.
 *
 * Memory: ~20 MB slots + 24 MB pool = ~44 MB heap (freed before return).
 * -------------------------------------------------------------------------- */
#define HT_SLOTS    (1u << 20)
#define HT_MASK     (HT_SLOTS - 1)
#define HT_MAX_LOAD (HT_SLOTS * 7 / 10)
#define POOL_SIZE   (24u * 1024u * 1024u)
#define SLOT_EMPTY  UINT32_MAX

typedef struct {
    uint64_t hash;
    uint32_t pool_off;
    uint32_t str_len;
    uint32_t frequency;
    uint32_t boosted;   /* 1 if recorded with keep_keys boost */
} ht_slot_t;

typedef struct {
    ht_slot_t *slots;
    char      *pool;
    uint32_t   pool_used;
    uint32_t   occupied;
} freq_ht_t;

static uint64_t fnv1a(const char *s, size_t len)
{
    uint64_t h = 14695981039346656037ULL;
    for (size_t i = 0; i < len; i++) { h ^= (uint8_t)s[i]; h *= 1099511628211ULL; }
    return h;
}

static freq_ht_t *ht_alloc(void)
{
    freq_ht_t *ht = malloc(sizeof(freq_ht_t));
    if (!ht) return NULL;
    ht->slots = malloc(HT_SLOTS * sizeof(ht_slot_t));
    ht->pool  = malloc(POOL_SIZE);
    if (!ht->slots || !ht->pool) { free(ht->slots); free(ht->pool); free(ht); return NULL; }
    memset(ht->slots, 0xFF, HT_SLOTS * sizeof(ht_slot_t));
    ht->pool_used = 0;
    ht->occupied  = 0;
    return ht;
}

static void ht_free(freq_ht_t *ht)
{
    if (!ht) return;
    free(ht->slots); free(ht->pool); free(ht);
}

/* boost > 1 increases the effective frequency of keep_keys values so they
 * sort into the top-256 symbol slots even at low natural frequency.        */
static void ht_record(freq_ht_t *ht, const char *text, size_t len, uint32_t boost)
{
    if (len == 0 || len >= CQ_MAX_TOKEN_LEN) return;
    uint64_t h   = fnv1a(text, len);
    uint32_t idx = (uint32_t)(h & HT_MASK);
    for (uint32_t probe = 0; probe < HT_SLOTS; probe++) {
        ht_slot_t *s = &ht->slots[(idx + probe) & HT_MASK];
        if (s->pool_off == SLOT_EMPTY) {
            if (ht->occupied >= HT_MAX_LOAD)             return;
            if (ht->pool_used + len + 1 > POOL_SIZE)     return;
            s->hash = h; s->pool_off = ht->pool_used;
            s->str_len = (uint32_t)len; s->frequency = boost;
            s->boosted  = (boost > 1u) ? 1u : 0u;
            memcpy(ht->pool + ht->pool_used, text, len);
            ht->pool[ht->pool_used + len] = '\0';
            ht->pool_used += (uint32_t)(len + 1);
            ht->occupied++;
            return;
        }
        if (s->hash == h && s->str_len == (uint32_t)len &&
            memcmp(ht->pool + s->pool_off, text, len) == 0) {
            s->frequency += boost;
            if (boost > 1u) s->boosted = 1u;
            return;
        }
    }
}

/* -----------------------------------------------------------------------
 * Intent helpers
 * ----------------------------------------------------------------------- */
#define KEEP_BOOST 5u

static int intent_key_match(const char * const *keys, int count,
                            const char *text, size_t len)
{
    if (!keys || count <= 0) return 0;
    for (int i = 0; i < count; i++) {
        if (keys[i] && strlen(keys[i]) == len &&
            memcmp(keys[i], text, len) == 0) return 1;
    }
    return 0;
}

/* Skip over a single JSON value starting at `pos`.  Returns new position. */
static size_t skip_json_value_ng(const char *input, size_t input_len, size_t pos)
{
    while (pos < input_len && (input[pos] == ' ' || input[pos] == '\t')) pos++;
    if (pos >= input_len) return pos;
    char ch = input[pos];
    if (ch == '"') {
        pos++;
        while (pos < input_len) {
            if (input[pos] == '\\') { pos += 2; continue; }
            if (input[pos] == '"') { pos++; break; }
            pos++;
        }
    } else if (ch == '{' || ch == '[') {
        char close = (ch == '{') ? '}' : ']';
        int depth = 1; pos++;
        while (pos < input_len && depth > 0) {
            if (input[pos] == '"') {
                pos++;
                while (pos < input_len) {
                    if (input[pos] == '\\') { pos += 2; continue; }
                    if (input[pos] == '"') { pos++; break; }
                    pos++;
                }
                continue;
            }
            if (input[pos] == '{' || input[pos] == '[') depth++;
            if (input[pos] == close || (ch=='{' && input[pos]==']') ||
                (ch=='[' && input[pos]=='}')) { /* handle mismatched — stop */
                if (input[pos] == close) depth--;
            }
            pos++;
        }
    } else {
        while (pos < input_len && input[pos] != ',' && input[pos] != '}'
               && input[pos] != ']' && input[pos] != '\n') pos++;
    }
    return pos;
}

/* --------------------------------------------------------------------------
 * Format-specific extractors
 *
 * Each extractor walks the input in whatever way suits the format and calls
 * ht_record() for every token worth considering for symbol substitution.
 * The `quoted` field on candidates is set by the dump loop below based on
 * which extractor was used.
 * -------------------------------------------------------------------------- */

/* JSON — extract every '"…"'-delimited span, honouring intent.
 *
 * When intent is set:
 *   drop_keys → key and its value are skipped entirely (no symbol slot used)
 *   keep_keys → value is recorded with KEEP_BOOST frequency multiplier
 *
 * When intent is NULL, behaviour is identical to the original implementation.
 */
static void extract_json(const char *input, size_t input_len,
                         freq_ht_t *ht, const cq_intent_t *intent)
{
    size_t i = 0;
    while (i < input_len) {
        if (input[i] != '"') { i++; continue; }
        size_t start = i + 1, j = start;
        while (j < input_len) {
            if (input[j] == '\\') { j += 2; continue; }
            if (input[j] == '"')  break;
            j++;
        }
        if (j >= input_len) { i = j + 1; continue; }

        size_t slen = j - start;

        if (intent) {
            /* Peek ahead: is this a key (followed by ':')? */
            size_t k = j + 1;
            while (k < input_len && (input[k] == ' ' || input[k] == '\t')) k++;

            if (k < input_len && input[k] == ':') {
                const char *key = input + start;
                int is_drop = intent_key_match(intent->drop_keys, intent->drop_count, key, slen);
                int is_keep = !is_drop &&
                              intent_key_match(intent->keep_keys, intent->keep_count, key, slen);

                /* Advance past ':' to the value */
                k++;
                while (k < input_len && (input[k] == ' ' || input[k] == '\t')) k++;

                if (input[k] == '"') {
                    /* String value — handle inline */
                    size_t vs = k + 1, vj = vs;
                    while (vj < input_len) {
                        if (input[vj] == '\\') { vj += 2; continue; }
                        if (input[vj] == '"')  break;
                        vj++;
                    }
                    if (vj < input_len && !is_drop) {
                        ht_record(ht, key, slen, 1u);
                        ht_record(ht, input + vs, vj - vs,
                                  is_keep ? KEEP_BOOST : 1u);
                    }
                    i = vj + 1;
                    continue;
                }

                /* Non-string value (number/bool/null/object/array).
                 * Record key if not dropped; skip nested value so its
                 * strings don't consume symbol slots of a dropped key. */
                if (!is_drop) {
                    ht_record(ht, key, slen, 1u);
                } else {
                    i = skip_json_value_ng(input, input_len, k);
                    continue;
                }
                i = j + 1;
                continue;
            }
        }

        /* No intent, or not a key — record as-is */
        ht_record(ht, input + start, slen, 1u);
        i = j + 1;
    }
}

/*
 * CSV — extract each comma/newline-delimited field.
 * Handles optional RFC-4180 double-quoting but stores content without quotes.
 */
static void extract_csv(const char *input, size_t input_len,
                        freq_ht_t *ht, const cq_intent_t *intent)
{
    size_t i = 0;
    while (i < input_len) {
        /* Skip leading whitespace that isn't a delimiter */
        while (i < input_len && input[i] == ' ') i++;
        if (i >= input_len) break;

        if (input[i] == '"') {
            /* RFC-4180 quoted field */
            size_t start = i + 1, j = start;
            while (j < input_len) {
                if (input[j] == '"' && j + 1 < input_len && input[j + 1] == '"') {
                    j += 2; continue;   /* escaped double-quote inside field */
                }
                if (input[j] == '"') break;
                j++;
            }
            if (j < input_len) ht_record(ht, input + start, j - start, 1u);
            i = j + 1;
            /* skip past the field delimiter */
            while (i < input_len && (input[i] == ',' || input[i] == '\r')) i++;
            if (i < input_len && input[i] == '\n') i++;
        } else {
            /* Unquoted field — ends at comma or newline */
            size_t start = i;
            while (i < input_len && input[i] != ',' && input[i] != '\n' && input[i] != '\r') i++;
            size_t len = i - start;
            /* trim trailing spaces */
            while (len > 0 && input[start + len - 1] == ' ') len--;
            if (len > 0) ht_record(ht, input + start, len, 1u);
            while (i < input_len && (input[i] == ',' || input[i] == '\r')) i++;
            if (i < input_len && input[i] == '\n') i++;
        }
    }
    (void)intent;
}

/*
 * LOG / plain-text — extract whitespace-delimited tokens.
 * Minimum length 4 chars to avoid noise from punctuation and short words.
 */
static void extract_log(const char *input, size_t input_len,
                        freq_ht_t *ht, const cq_intent_t *intent)
{
    size_t i = 0;
    while (i < input_len) {
        /* skip non-alphanumeric / non-token characters */
        while (i < input_len && !isalnum((unsigned char)input[i]) &&
               input[i] != '_' && input[i] != '.' && input[i] != '-' &&
               input[i] != '/' && input[i] != ':') {
            i++;
        }
        if (i >= input_len) break;
        size_t start = i;
        while (i < input_len && !isspace((unsigned char)input[i])) i++;
        size_t len = i - start;
        if (len >= 4) ht_record(ht, input + start, len, 1u);
    }
    (void)intent;
}

/*
 * CODE — extract string literals (single and double quoted) and identifiers.
 * Identifiers: sequences of [A-Za-z0-9_] starting with a letter or _.
 */
static void extract_code(const char *input, size_t input_len,
                         freq_ht_t *ht, const cq_intent_t *intent)
{
    size_t i = 0;
    while (i < input_len) {
        char ch = input[i];

        /* String literals: single or double quoted */
        if (ch == '"' || ch == '\'') {
            char delim = ch;
            size_t start = i + 1, j = start;
            while (j < input_len) {
                if (input[j] == '\\') { j += 2; continue; }
                if (input[j] == delim) break;
                j++;
            }
            if (j < input_len && j > start) ht_record(ht, input + start, j - start, 1u);
            i = j + 1;
            continue;
        }

        /* Identifiers */
        if (isalpha((unsigned char)ch) || ch == '_') {
            size_t start = i;
            while (i < input_len && (isalnum((unsigned char)input[i]) || input[i] == '_')) i++;
            size_t len = i - start;
            if (len >= 4) ht_record(ht, input + start, len, 1u);
            continue;
        }

        i++;
    }
    (void)intent;
}

/* --------------------------------------------------------------------------
 * Dispatch table
 * -------------------------------------------------------------------------- */
typedef void (*extractor_fn)(const char *, size_t, freq_ht_t *, const cq_intent_t *);

static const extractor_fn extractors[CQ_FMT_COUNT] = {
    [CQ_FMT_JSON] = extract_json,
    [CQ_FMT_CSV]  = extract_csv,
    [CQ_FMT_LOG]  = extract_log,
    [CQ_FMT_CODE] = extract_code,
};

/* quoted flag per format (1 = tokens were inside quotes and must be
 * re-wrapped with '"' on expansion; 0 = bare tokens) */
static const int fmt_quoted[CQ_FMT_COUNT] = {
    [CQ_FMT_JSON] = 1,
    [CQ_FMT_CSV]  = 0,
    [CQ_FMT_LOG]  = 0,
    [CQ_FMT_CODE] = 0,
};

/* --------------------------------------------------------------------------
 * Comparator
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
                  cq_format_t fmt, const cq_intent_t *intent,
                  cq_candidate_list_t *out)
{
    if (!input || !out) return -1;
    if (fmt < 0 || fmt >= CQ_FMT_COUNT) fmt = CQ_FMT_JSON;
    memset(out, 0, sizeof(*out));

    freq_ht_t *ht = ht_alloc();
    if (!ht) return -1;

    extractors[fmt](input, input_len, ht, intent);

    size_t         tmp_cap   = 4096;
    cq_candidate_t *tmp      = malloc(tmp_cap * sizeof(cq_candidate_t));
    size_t          tmp_count = 0;
    if (!tmp) { ht_free(ht); return -1; }

    int quoted = fmt_quoted[fmt];

    for (uint32_t i = 0; i < HT_SLOTS; i++) {
        const ht_slot_t *s = &ht->slots[i];
        if (s->pool_off == SLOT_EMPTY || s->frequency < 2) continue;

        int  tl  = cq_approx_token_count(ht->pool + s->pool_off, s->str_len);
        long ps  = (long)(tl - 1) * (long)s->frequency;
        long dc  = (long)tl + (long)CQ_DICT_SYNTAX_TOKENS;
        long net = ps - dc;
        /* keep_keys override: force inclusion even when economic saving is ≤0 */
        if (net <= 0) {
            if (s->boosted && s->frequency >= 2u) net = 999999L;
            else continue;
        }

        if (tmp_count >= tmp_cap) {
            size_t nc = tmp_cap * 2;
            cq_candidate_t *t2 = realloc(tmp, nc * sizeof(cq_candidate_t));
            if (!t2) break;
            tmp = t2; tmp_cap = nc;
        }

        cq_candidate_t *c = &tmp[tmp_count++];
        memcpy(c->text, ht->pool + s->pool_off, s->str_len);
        c->text[s->str_len] = '\0';
        c->length    = s->str_len;
        c->frequency = s->frequency;
        c->token_len = tl;
        c->net_saving = net;
        c->quoted    = quoted;
    }

    ht_free(ht);

    qsort(tmp, tmp_count, sizeof(cq_candidate_t), cmp_by_saving);

    size_t copy = tmp_count < CQ_MAX_CANDIDATES ? tmp_count : CQ_MAX_CANDIDATES;
    memcpy(out->items, tmp, copy * sizeof(cq_candidate_t));
    out->count = copy;

    free(tmp);
    return (int)copy;
}
