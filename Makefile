CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O3 -Isrc

SRC     = src/cq_ngram.c src/cq_dict.c src/cq_compress.c
TEST_SRC= tests/test_compress.c
CLI_SRC = src/cli.c

.PHONY: all test cli clean

all: test cli

test: $(SRC) $(TEST_SRC)
	$(CC) $(CFLAGS) $(SRC) $(TEST_SRC) -o test_runner
	./test_runner

cli: $(SRC) $(CLI_SRC)
	$(CC) $(CFLAGS) $(SRC) $(CLI_SRC) -o contextquant_cli

clean:
	rm -f test_runner contextquant_cli