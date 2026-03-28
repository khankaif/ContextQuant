#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define RECORD_BUF_SIZE 8192
#define FOOTER_RESERVE  1024
#define PADDING_CHUNK   256

typedef enum {
    SHAPE_CHARGES,
    SHAPE_EVENTS,
    SHAPE_USERS
} payload_shape_t;

typedef struct {
    uint64_t state;
} prng_t;

static uint64_t prng_next(prng_t *rng)
{
    uint64_t x = rng->state;
    if (x == 0) x = 0x9e3779b97f4a7c15ULL;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng->state = x;
    return x * 0x2545F4914F6CDD1DULL;
}

static size_t prng_range(prng_t *rng, size_t upper_bound)
{
    if (upper_bound == 0) return 0;
    return (size_t)(prng_next(rng) % upper_bound);
}

static const char *pick(const char *const *items, size_t count, prng_t *rng)
{
    return items[prng_range(rng, count)];
}

static int write_all(FILE *out, const char *buf, size_t len)
{
    return fwrite(buf, 1, len, out) == len ? 0 : -1;
}

static void write_padding(FILE *out, size_t len)
{
    static char chunk[PADDING_CHUNK];
    static int initialized = 0;

    if (!initialized) {
        memset(chunk, 'x', sizeof(chunk));
        initialized = 1;
    }

    while (len > 0) {
        size_t part = len < sizeof(chunk) ? len : sizeof(chunk);
        fwrite(chunk, 1, part, out);
        len -= part;
    }
}

static int parse_size_bytes(const char *arg, size_t *out_bytes)
{
    char *end = NULL;
    unsigned long long value = strtoull(arg, &end, 10);
    unsigned long long multiplier = 1;

    if (arg[0] == '\0' || end == arg || errno == ERANGE) return -1;

    while (*end && isspace((unsigned char)*end)) end++;

    if (*end != '\0') {
        char suffix[4] = {0};
        size_t i = 0;
        while (*end && i + 1 < sizeof(suffix)) {
            suffix[i++] = (char)tolower((unsigned char)*end++);
        }
        while (*end && isspace((unsigned char)*end)) end++;
        if (*end != '\0') return -1;

        if (strcmp(suffix, "k") == 0 || strcmp(suffix, "kb") == 0) {
            multiplier = 1024ULL;
        } else if (strcmp(suffix, "m") == 0 || strcmp(suffix, "mb") == 0) {
            multiplier = 1024ULL * 1024ULL;
        } else if (strcmp(suffix, "g") == 0 || strcmp(suffix, "gb") == 0) {
            multiplier = 1024ULL * 1024ULL * 1024ULL;
        } else {
            return -1;
        }
    }

    if (value > SIZE_MAX / multiplier) return -1;
    *out_bytes = (size_t)(value * multiplier);
    return 0;
}

static int parse_shape(const char *arg, payload_shape_t *shape_out)
{
    if (strcmp(arg, "charges") == 0) {
        *shape_out = SHAPE_CHARGES;
        return 0;
    }
    if (strcmp(arg, "events") == 0) {
        *shape_out = SHAPE_EVENTS;
        return 0;
    }
    if (strcmp(arg, "users") == 0) {
        *shape_out = SHAPE_USERS;
        return 0;
    }
    return -1;
}

static const char *shape_name(payload_shape_t shape)
{
    switch (shape) {
    case SHAPE_CHARGES: return "charges";
    case SHAPE_EVENTS:  return "events";
    case SHAPE_USERS:   return "users";
    }
    return "unknown";
}

static const char *shape_url(payload_shape_t shape)
{
    switch (shape) {
    case SHAPE_CHARGES: return "/v1/charges";
    case SHAPE_EVENTS:  return "/v1/events";
    case SHAPE_USERS:   return "/v1/users";
    }
    return "/v1/data";
}

static int build_charge_record(size_t index, prng_t *rng, char *buf, size_t buf_size)
{
    static const char *const statuses[]   = {"succeeded", "pending", "requires_capture", "refunded"};
    static const char *const currencies[] = {"usd", "eur", "gbp", "cad"};
    static const char *const brands[]     = {"visa", "mastercard", "amex"};
    static const char *const cities[]     = {"San Francisco", "New York", "Austin", "Berlin", "Toronto"};
    static const char *const states[]     = {"CA", "NY", "TX", "BE", "ON"};
    static const char *const domains[]    = {"acme.io", "example.com", "northwind.dev", "apex.cloud"};
    static const char *const segments[]   = {"enterprise", "growth", "startup", "platform"};
    static const char *const products[]   = {"analytics seat", "team workspace", "api overage", "enterprise plan"};

    const char *status   = pick(statuses, sizeof(statuses) / sizeof(statuses[0]), rng);
    const char *currency = pick(currencies, sizeof(currencies) / sizeof(currencies[0]), rng);
    const char *brand    = pick(brands, sizeof(brands) / sizeof(brands[0]), rng);
    const char *city     = pick(cities, sizeof(cities) / sizeof(cities[0]), rng);
    const char *state    = pick(states, sizeof(states) / sizeof(states[0]), rng);
    const char *domain   = pick(domains, sizeof(domains) / sizeof(domains[0]), rng);
    const char *segment  = pick(segments, sizeof(segments) / sizeof(segments[0]), rng);
    const char *product  = pick(products, sizeof(products) / sizeof(products[0]), rng);

    unsigned amount = 1500U + (unsigned)prng_range(rng, 250000);
    unsigned refunded = strcmp(status, "refunded") == 0 ? amount : 0U;
    unsigned created = 1712000000U + (unsigned)(index * 31U) + (unsigned)prng_range(rng, 29);
    unsigned customer_num = 1000U + (unsigned)(index % 750U);
    unsigned order_num = 900000U + (unsigned)index;
    unsigned batch_num = 4000U + (unsigned)(index / 25U);
    unsigned last4 = 1000U + (unsigned)prng_range(rng, 9000);

    return snprintf(
        buf, buf_size,
        "{\"id\":\"ch_%08zu\",\"object\":\"charge\",\"amount\":%u,"
        "\"amount_captured\":%u,\"amount_refunded\":%u,\"currency\":\"%s\","
        "\"status\":\"%s\",\"captured\":true,\"paid\":true,\"created\":%u,"
        "\"customer\":{\"id\":\"cus_%06u\",\"object\":\"customer\","
        "\"email\":\"buyer%06u@%s\",\"segment\":\"%s\"},"
        "\"billing_details\":{\"name\":\"Customer %06u\","
        "\"email\":\"buyer%06u@%s\",\"address\":{\"city\":\"%s\","
        "\"country\":\"US\",\"postal_code\":\"94%03u\",\"state\":\"%s\"}},"
        "\"payment_method_details\":{\"type\":\"card\",\"card\":{\"brand\":\"%s\","
        "\"country\":\"US\",\"exp_month\":12,\"exp_year\":2030,\"funding\":\"credit\","
        "\"last4\":\"%04u\",\"network\":\"%s\"}},"
        "\"metadata\":{\"source\":\"synthetic-generator\",\"batch\":\"batch_%04u\","
        "\"order_id\":\"ord_%06u\",\"product\":\"%s\"}}",
        index + 1, amount, amount, refunded, currency, status, created, customer_num,
        customer_num, domain, segment, customer_num, customer_num, domain, city,
        (unsigned)prng_range(rng, 900U), state, brand, last4, brand, batch_num,
        order_num, product
    );
}

static int build_event_record(size_t index, prng_t *rng, char *buf, size_t buf_size)
{
    static const char *const event_types[] = {
        "charge.succeeded", "invoice.paid", "customer.subscription.updated",
        "payment_intent.succeeded", "charge.refunded"
    };
    static const char *const environments[] = {"prod", "staging", "sandbox"};
    static const char *const regions[] = {"us-east-1", "us-west-2", "eu-central-1"};

    const char *type = pick(event_types, sizeof(event_types) / sizeof(event_types[0]), rng);
    const char *env  = pick(environments, sizeof(environments) / sizeof(environments[0]), rng);
    const char *region = pick(regions, sizeof(regions) / sizeof(regions[0]), rng);

    unsigned amount = 1000U + (unsigned)prng_range(rng, 120000);
    unsigned created = 1713000000U + (unsigned)(index * 17U) + (unsigned)prng_range(rng, 11);
    unsigned req_num = 500000U + (unsigned)index;
    unsigned acct_num = 10000U + (unsigned)(index % 250U);

    return snprintf(
        buf, buf_size,
        "{\"id\":\"evt_%08zu\",\"object\":\"event\",\"api_version\":\"2026-03-01\","
        "\"created\":%u,\"livemode\":false,\"pending_webhooks\":0,\"type\":\"%s\","
        "\"request\":{\"id\":\"req_%06u\",\"idempotency_key\":\"ik_%06u\"},"
        "\"account\":\"acct_%05u\",\"environment\":\"%s\",\"region\":\"%s\","
        "\"data\":{\"object\":{\"id\":\"pi_%08zu\",\"object\":\"payment_intent\","
        "\"amount\":%u,\"currency\":\"usd\",\"status\":\"succeeded\","
        "\"customer\":\"cus_%06u\",\"description\":\"Synthetic event flow %zu\","
        "\"metadata\":{\"source\":\"synthetic-generator\",\"pipeline\":\"event-replay\"}}}}",
        index + 1, created, type, req_num, req_num, acct_num, env, region,
        index + 1, amount, acct_num, index + 1
    );
}

static int build_user_record(size_t index, prng_t *rng, char *buf, size_t buf_size)
{
    static const char *const plans[]      = {"free", "team", "business", "enterprise"};
    static const char *const statuses[]   = {"active", "invited", "suspended"};
    static const char *const industries[] = {"fintech", "healthcare", "retail", "saas"};
    static const char *const roles[]      = {"admin", "member", "billing_admin", "developer"};
    static const char *const domains[]    = {"acme.io", "northwind.dev", "globex.net", "example.com"};

    const char *plan = pick(plans, sizeof(plans) / sizeof(plans[0]), rng);
    const char *status = pick(statuses, sizeof(statuses) / sizeof(statuses[0]), rng);
    const char *industry = pick(industries, sizeof(industries) / sizeof(industries[0]), rng);
    const char *role = pick(roles, sizeof(roles) / sizeof(roles[0]), rng);
    const char *domain = pick(domains, sizeof(domains) / sizeof(domains[0]), rng);

    unsigned org_num = 2000U + (unsigned)(index % 300U);
    unsigned created = 1711000000U + (unsigned)(index * 43U);
    unsigned projects = 1U + (unsigned)prng_range(rng, 28U);
    unsigned seats = 2U + (unsigned)prng_range(rng, 450U);
    unsigned api_calls = 1000U + (unsigned)prng_range(rng, 950000U);

    return snprintf(
        buf, buf_size,
        "{\"id\":\"usr_%08zu\",\"object\":\"user\",\"email\":\"user%06zu@%s\","
        "\"name\":\"User %06zu\",\"status\":\"%s\",\"created_at\":%u,"
        "\"organization\":{\"id\":\"org_%05u\",\"name\":\"Org %05u\","
        "\"industry\":\"%s\",\"plan\":\"%s\",\"seats\":%u},"
        "\"role\":\"%s\",\"preferences\":{\"locale\":\"en-US\",\"timezone\":\"UTC\","
        "\"email_notifications\":true,\"weekly_digest\":true},"
        "\"usage\":{\"projects\":%u,\"api_calls_30d\":%u,\"storage_bytes\":%u},"
        "\"feature_flags\":{\"audit_logs\":true,\"sso\":%s,\"advanced_exports\":%s}}",
        index + 1, index + 1, domain, index + 1, status, created, org_num, org_num,
        industry, plan, seats, role, projects, api_calls, api_calls * 32U,
        seats > 25U ? "true" : "false", strcmp(plan, "free") == 0 ? "false" : "true"
    );
}

static int build_record(payload_shape_t shape, size_t index, prng_t *rng, char *buf, size_t buf_size)
{
    switch (shape) {
    case SHAPE_CHARGES:
        return build_charge_record(index, rng, buf, buf_size);
    case SHAPE_EVENTS:
        return build_event_record(index, rng, buf, buf_size);
    case SHAPE_USERS:
        return build_user_record(index, rng, buf, buf_size);
    }
    return -1;
}

static void print_usage(const char *argv0)
{
    fprintf(stderr,
            "Usage: %s <output.json|-> <size> [charges|events|users] [seed]\n"
            "Examples:\n"
            "  %s payload.json 64mb charges\n"
            "  %s - 1048576 events 42\n",
            argv0, argv0, argv0);
}

int main(int argc, char **argv)
{
    FILE *out = NULL;
    payload_shape_t shape = SHAPE_CHARGES;
    size_t target_bytes = 0;
    size_t written = 0;
    size_t records = 0;
    char header[256];
    char footer_prefix[256];
    char record[RECORD_BUF_SIZE];
    const char *output_path = NULL;
    prng_t rng;
    uint64_t seed;

    if (argc < 3 || argc > 5) {
        print_usage(argv[0]);
        return 1;
    }

    output_path = argv[1];

    if (parse_size_bytes(argv[2], &target_bytes) != 0 || target_bytes == 0) {
        fprintf(stderr, "Invalid size: %s\n", argv[2]);
        return 1;
    }

    if (argc >= 4 && parse_shape(argv[3], &shape) != 0) {
        fprintf(stderr, "Invalid shape: %s\n", argv[3]);
        return 1;
    }

    if (argc == 5) {
        char *end = NULL;
        seed = strtoull(argv[4], &end, 10);
        if (argv[4][0] == '\0' || *end != '\0') {
            fprintf(stderr, "Invalid seed: %s\n", argv[4]);
            return 1;
        }
    } else {
        seed = (uint64_t)time(NULL);
    }

    rng.state = seed;

    if (strcmp(output_path, "-") == 0) {
        out = stdout;
    } else {
        out = fopen(output_path, "wb");
        if (!out) {
            fprintf(stderr, "Could not open %s for writing\n", output_path);
            return 1;
        }
    }

    int header_len = snprintf(
        header, sizeof(header),
        "{\"object\":\"list\",\"url\":\"%s\",\"has_more\":false,"
        "\"generated_by\":\"synthetic_json_gen\",\"data\":[",
        shape_url(shape)
    );
    if (header_len < 0 || (size_t)header_len >= sizeof(header)) {
        fprintf(stderr, "Header generation failed\n");
        if (out != stdout) fclose(out);
        return 1;
    }

    int min_footer_len = snprintf(
        footer_prefix, sizeof(footer_prefix),
        "],\"summary\":{\"shape\":\"%s\",\"records\":0,\"target_bytes\":%zu,"
        "\"seed\":%" PRIu64 ",\"padding\":\"",
        shape_name(shape), target_bytes, seed
    );
    if (min_footer_len < 0 || (size_t)min_footer_len >= sizeof(footer_prefix)) {
        fprintf(stderr, "Footer generation failed\n");
        if (out != stdout) fclose(out);
        return 1;
    }

    if (target_bytes <= (size_t)header_len + (size_t)min_footer_len + 4U) {
        fprintf(stderr, "Target size too small. Use something larger than %zu bytes.\n",
                (size_t)header_len + (size_t)min_footer_len + 4U);
        if (out != stdout) fclose(out);
        return 1;
    }

    if (write_all(out, header, (size_t)header_len) != 0) {
        fprintf(stderr, "Failed while writing header\n");
        if (out != stdout) fclose(out);
        return 1;
    }
    written = (size_t)header_len;

    for (;;) {
        int record_len = build_record(shape, records, &rng, record, sizeof(record));
        size_t separator_len = records == 0 ? 0U : 1U;

        if (record_len < 0 || (size_t)record_len >= sizeof(record)) {
            fprintf(stderr, "Record generation failed at index %zu\n", records);
            if (out != stdout) fclose(out);
            return 1;
        }

        if (written + separator_len + (size_t)record_len + FOOTER_RESERVE > target_bytes) {
            break;
        }

        if (separator_len && write_all(out, ",", 1) != 0) {
            fprintf(stderr, "Failed while writing separator\n");
            if (out != stdout) fclose(out);
            return 1;
        }

        if (write_all(out, record, (size_t)record_len) != 0) {
            fprintf(stderr, "Failed while writing record\n");
            if (out != stdout) fclose(out);
            return 1;
        }

        written += separator_len + (size_t)record_len;
        records++;
    }

    int footer_prefix_len = snprintf(
        footer_prefix, sizeof(footer_prefix),
        "],\"summary\":{\"shape\":\"%s\",\"records\":%zu,\"target_bytes\":%zu,"
        "\"seed\":%" PRIu64 ",\"padding\":\"",
        shape_name(shape), records, target_bytes, seed
    );
    if (footer_prefix_len < 0 || (size_t)footer_prefix_len >= sizeof(footer_prefix)) {
        fprintf(stderr, "Footer generation failed\n");
        if (out != stdout) fclose(out);
        return 1;
    }

    {
        const char footer_suffix[] = "\"}}\n";
        size_t footer_len = (size_t)footer_prefix_len + sizeof(footer_suffix) - 1U;

        if (written + footer_len > target_bytes) {
            fprintf(stderr, "Target size too small for footer metadata\n");
            if (out != stdout) fclose(out);
            return 1;
        }

        if (write_all(out, footer_prefix, (size_t)footer_prefix_len) != 0) {
            fprintf(stderr, "Failed while writing footer prefix\n");
            if (out != stdout) fclose(out);
            return 1;
        }

        write_padding(out, target_bytes - written - footer_len);

        if (write_all(out, footer_suffix, sizeof(footer_suffix) - 1U) != 0) {
            fprintf(stderr, "Failed while writing footer suffix\n");
            if (out != stdout) fclose(out);
            return 1;
        }
    }

    if (out != stdout) fclose(out);

    fprintf(stderr,
            "Generated %zu bytes using shape=%s records=%zu seed=%" PRIu64 "\n",
            target_bytes, shape_name(shape), records, seed);
    return 0;
}
