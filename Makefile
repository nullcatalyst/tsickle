# Use /bin/bash for executing shell commands; this is necessary for
# the <(...) command-line arg to clang-format.
SHELL := /bin/bash

clang_format := node_modules/.bin/clang-format -style=file
tslint := node_modules/.bin/tslint -t verbose
mocha := node_modules/.bin/mocha --timeout=25000

srcs := $(wildcard src/*.ts test/*.ts)
js := $(srcs:%.ts=build/%.js)
types := $(wildcard node_modules/@types/**)

# Build the "compile" target by default.
.PHONY: all
all: compile

# Create a pattern for each foo.ts file that is a matching
# build/foo.check-format.  This a stamp file that tracks whether
# foo has been checked for clang-formatting.
build/%.check-format: src/%.ts
	@if ! diff -q <($(clang_format) $<) $< > /dev/null; then \
		echo '$<: needs clang-format'; \
		exit 1; \
	fi
	@mkdir -p $(dirname $@) && touch $@
.PHONY: check-format
check-format: $(all_srcs:%=build/%.check-format)

# "make format" has clang-format update all source files.
.PHONY: format
format: $(srcs)
	$(clang_format) -i $^

# "make lint" runs tslint over the source.
.PHONY: lint
lint: $(srcs)
	$(tlint) $^

# "make compile" runs tsc over the source.
.PHONY: compile
$(js): $(srcs) $(types) tsconfig.json
	tsc
compile: $(js)

# Gather up the tests, specifically the test/foo_test.js files
# that we will pass to mocha.
tests := $(sort $(filter %test.js,$(js)))
# Split out the e2e test so we can run it last (it's slow).
e2e_test := $(filter %/e2e_test.js,$(tests))
tests_except_e2e := $(filter-out $(e2e_test),$(tests))

# "make test" runs the test suite over the source.
.PHONY: test
test: $(tests)
	$(mocha) $(tests_except_e2e) $(e2e_test)
