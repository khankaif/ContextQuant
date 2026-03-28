CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O2 -Isrc

SRC     = src/cq_ngram.c src/cq_dict.c src/cq_compress.c
TEST_SRC= tests/test_compress.c

.PHONY: all test clean

all: test

test: $(SRC) $(TEST_SRC)
	$(CC) $(CFLAGS) $(SRC) $(TEST_SRC) -o test_runner
	./test_runner

clean:
	rm -f test_runner
