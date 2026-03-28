CC      = gcc
CFLAGS  = -Wall -Wextra -Wpedantic -std=c11 -O3 -Isrc -MMD -MP
LDFLAGS = -lsqlite3

# -----------------------------------------------------------------------
# Object files
# Each .c compiles to its own .o.  Only changed files are ever recompiled.
# -----------------------------------------------------------------------
LIB_OBJ := src/cq_ngram.o    \
            src/cq_dict.o     \
            src/cq_compress.o \
            src/cq_cache.o    \
            src/cq_session.o

TEST_OBJ := tests/test_compress.o \
            tests/test_cache.o    \
            tests/test_intent.o   \
            tests/test_session.o

# -----------------------------------------------------------------------
# Auto-generated header-dependency files (.d)
# -MMD -MP writes a .d file next to every .o.  We include them below so
# that Make knows which .o files to rebuild when a .h changes.
# -----------------------------------------------------------------------
DEPS := $(LIB_OBJ:.o=.d) $(TEST_OBJ:.o=.d) \
        src/cli.d src/json_generator.d src/log_generator.d

.PHONY: all test cli generators clean

all: cli generators test

# -----------------------------------------------------------------------
# Pattern rule — compiles any .c to a .o in the same directory.
# This single rule covers src/, tests/, and everywhere else.
# -----------------------------------------------------------------------
%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# Pull in header dependencies silently (missing .d files on a clean build
# is fine — they get generated on the first compile).
-include $(DEPS)

# -----------------------------------------------------------------------
# Test binaries (real file targets — Make skips the link if nothing changed)
# -----------------------------------------------------------------------
test_runner:  $(LIB_OBJ) tests/test_compress.o
	$(CC) $^ -o $@ $(LDFLAGS)

test_cache:   $(LIB_OBJ) tests/test_cache.o
	$(CC) $^ -o $@ $(LDFLAGS)

test_intent:  $(LIB_OBJ) tests/test_intent.o
	$(CC) $^ -o $@ $(LDFLAGS)

test_session: $(LIB_OBJ) tests/test_session.o
	$(CC) $^ -o $@ $(LDFLAGS)

# PHONY test rule — always executes the test runners.
# Rebuilds any stale binary first, then runs all four suites.
test: test_runner test_cache test_intent test_session
	./test_runner
	./test_cache
	./test_intent
	./test_session

# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------
cli: contextquant_cli

contextquant_cli: $(LIB_OBJ) src/cli.o
	$(CC) $^ -o $@ $(LDFLAGS)

# -----------------------------------------------------------------------
# Generators (standalone — no library or SQLite dependency)
# -----------------------------------------------------------------------
generators: synthetic_json_gen log_gen

synthetic_json_gen: src/json_generator.o
	$(CC) $^ -o $@

log_gen: src/log_generator.o
	$(CC) $^ -o $@

# -----------------------------------------------------------------------
# Clean
# -----------------------------------------------------------------------
clean:
	rm -f $(LIB_OBJ) $(TEST_OBJ) src/cli.o src/json_generator.o src/log_generator.o
	rm -f $(DEPS)
	rm -f test_runner test_cache test_intent test_session
	rm -f contextquant_cli synthetic_json_gen log_gen *.db
