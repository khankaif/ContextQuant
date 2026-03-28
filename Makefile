CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O3 -Isrc

SRC     = src/cq_ngram.c src/cq_dict.c src/cq_compress.c
TEST_SRC= tests/test_compress.c
CLI_SRC = src/cli.c
GEN_SRC = src/json_generator.c

.PHONY: all test cli generator clean

all: test cli generator

test: $(SRC) $(TEST_SRC)
	$(CC) $(CFLAGS) $(SRC) $(TEST_SRC) -o test_runner
	./test_runner

cli: $(SRC) $(CLI_SRC)
	$(CC) $(CFLAGS) $(SRC) $(CLI_SRC) -o contextquant_cli

generator: $(GEN_SRC)
	$(CC) $(CFLAGS) $(GEN_SRC) -o synthetic_json_gen

clean:
	rm -f test_runner contextquant_cli synthetic_json_gen
