CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O3 -Isrc

SRC     = src/cq_ngram.c src/cq_dict.c src/cq_compress.c
TEST_SRC= tests/test_compress.c
CLI_SRC = src/cli.c
JSON_GEN_SRC = src/json_generator.c
LOG_GEN_SRC  = src/log_generator.c

.PHONY: all test cli generators clean

all: test cli generators

test: $(SRC) $(TEST_SRC)
	$(CC) $(CFLAGS) $(SRC) $(TEST_SRC) -o test_runner
	./test_runner

cli: $(SRC) $(CLI_SRC)
	$(CC) $(CFLAGS) $(SRC) $(CLI_SRC) -o contextquant_cli

generators: $(JSON_GEN_SRC) $(LOG_GEN_SRC)
	$(CC) $(CFLAGS) $(JSON_GEN_SRC) -o synthetic_json_gen
	$(CC) $(CFLAGS) $(LOG_GEN_SRC)  -o log_gen

clean:
	rm -f test_runner contextquant_cli synthetic_json_gen log_gen
