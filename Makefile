CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O3 -Isrc
LDFLAGS = -lsqlite3

SRC      = src/cq_ngram.c src/cq_dict.c src/cq_compress.c src/cq_cache.c src/cq_session.c
CLI_SRC  = src/cli.c
JSON_GEN_SRC = src/json_generator.c
LOG_GEN_SRC  = src/log_generator.c

.PHONY: all test cli generators clean

all: test cli generators

test: $(SRC) tests/test_compress.c tests/test_cache.c tests/test_intent.c tests/test_session.c
	$(CC) $(CFLAGS) $(SRC) tests/test_compress.c -o test_runner  $(LDFLAGS)
	$(CC) $(CFLAGS) $(SRC) tests/test_cache.c    -o test_cache   $(LDFLAGS)
	$(CC) $(CFLAGS) $(SRC) tests/test_intent.c   -o test_intent  $(LDFLAGS)
	$(CC) $(CFLAGS) $(SRC) tests/test_session.c  -o test_session $(LDFLAGS)
	./test_runner
	./test_cache
	./test_intent
	./test_session

cli: $(SRC) $(CLI_SRC)
	$(CC) $(CFLAGS) $(SRC) $(CLI_SRC) -o contextquant_cli $(LDFLAGS)

generators: $(JSON_GEN_SRC) $(LOG_GEN_SRC)
	$(CC) $(CFLAGS) $(JSON_GEN_SRC) -o synthetic_json_gen
	$(CC) $(CFLAGS) $(LOG_GEN_SRC)  -o log_gen

clean:
	rm -f test_runner test_cache test_intent test_session contextquant_cli synthetic_json_gen log_gen *.db
