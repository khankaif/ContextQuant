#include "cq_dict.h"

#include <string.h>
#include <stdio.h>

/* Alphabet for TILDE_ALPHA: A-Z a-z 0-9 (62 entries) */
static const char tilde_chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/* Write the symbol bytes for slot sym_id into buf (at least 4 bytes).
 * Returns bytes written, or -1 if buf too small or sym_id out of range. */
int cq_dict_emit_symbol_bytes(const cq_dict_t *dict, int sym_id,
                              char *buf, size_t buf_size)
{
    if (!dict || !buf || sym_id < 0) return -1;

    switch (dict->scheme) {
    case CQ_SYM_PUA_UNICODE:
        if (sym_id >= CQ_SYM_PUA_MAX || buf_size < 3) return -1;
        buf[0] = (char)0xEE;
        buf[1] = (char)(0x80 + (sym_id >> 6));
        buf[2] = (char)(0x80 + (sym_id & 0x3F));
        return 3;

    case CQ_SYM_TILDE_ALPHA:
        if (sym_id >= CQ_SYM_TILDE_MAX || buf_size < 2) return -1;
        buf[0] = '~';
        buf[1] = tilde_chars[sym_id];
        return 2;

    case CQ_SYM_CARET_DECIMAL:
    default: {
        int n = snprintf(buf, buf_size, "^%d", sym_id);
        if (n < 0 || (size_t)n >= buf_size) return -1;
        return n;
    }
    }
}

int cq_dict_build(const cq_candidate_list_t *list, cq_symbol_scheme_t scheme,
                  cq_dict_t *dict)
{
    if (!list || !dict) return -1;

    memset(dict, 0, sizeof(*dict));
    dict->scheme = scheme;

    /* Cap at the scheme's slot limit */
    size_t slot_max;
    switch (scheme) {
    case CQ_SYM_TILDE_ALPHA:   slot_max = CQ_SYM_TILDE_MAX; break;
    case CQ_SYM_PUA_UNICODE:
    case CQ_SYM_CARET_DECIMAL:
    default:                   slot_max = CQ_SYM_PUA_MAX;   break;
    }

    size_t limit = list->count;
    if (limit > CQ_MAX_SYMBOLS) limit = CQ_MAX_SYMBOLS;
    if (limit > slot_max)       limit = slot_max;

    for (size_t i = 0; i < limit; i++) {
        cq_symbol_t *s  = &dict->entries[i];
        s->symbol_id    = (int)i;
        memcpy(s->original, list->items[i].text, list->items[i].length);
        s->original[list->items[i].length] = '\0';
        s->original_len = list->items[i].length;
        s->quoted       = list->items[i].quoted;
    }
    dict->count = limit;

    return (int)limit;
}

int cq_dict_render(const cq_dict_t *dict, char *buf, size_t buf_size)
{
    if (!dict || !buf || buf_size == 0) return -1;

    size_t pos = 0;

    for (size_t i = 0; i < dict->count; i++) {
        const cq_symbol_t *s = &dict->entries[i];

        /* Emit symbol bytes */
        char sym_bytes[8] = {0};
        int sym_len = cq_dict_emit_symbol_bytes(dict, s->symbol_id,
                                                sym_bytes, sizeof(sym_bytes));
        if (sym_len < 0) return -1;

        /* Format: "<sym> = '<original>'\n" */
        if (pos + (size_t)sym_len + 6 + s->original_len >= buf_size) return -1;

        memcpy(buf + pos, sym_bytes, (size_t)sym_len);
        pos += (size_t)sym_len;
        buf[pos++] = ' ';
        buf[pos++] = '=';
        buf[pos++] = ' ';
        buf[pos++] = '\'';
        memcpy(buf + pos, s->original, s->original_len);
        pos += s->original_len;
        buf[pos++] = '\'';
        buf[pos++] = '\n';
    }

    buf[pos] = '\0';
    return (int)pos;
}

int cq_dict_lookup(const cq_dict_t *dict, const char *text, size_t len)
{
    if (!dict || !text || len == 0) return -1;

    for (size_t i = 0; i < dict->count; i++) {
        if (dict->entries[i].original_len == len &&
            memcmp(dict->entries[i].original, text, len) == 0) {
            return dict->entries[i].symbol_id;
        }
    }
    return -1;
}
