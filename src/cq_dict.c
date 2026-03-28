#include "cq_dict.h"

#include <string.h>
#include <stdio.h>

int cq_dict_build(const cq_candidate_list_t *list, cq_dict_t *dict)
{
    if (!list || !dict) return -1;

    memset(dict, 0, sizeof(*dict));

    size_t limit = list->count < CQ_MAX_SYMBOLS ? list->count : CQ_MAX_SYMBOLS;

    for (size_t i = 0; i < limit; i++) {
        cq_symbol_t *s = &dict->entries[i];
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

        /* Each line: "^N = 'original'\n" */
        int n = snprintf(buf + pos, buf_size - pos,
                         "^%d = '%s'\n", s->symbol_id, s->original);
        if (n < 0 || (size_t)n >= buf_size - pos) return -1;
        pos += (size_t)n;
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
