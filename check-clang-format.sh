#!/bin/bash

# check-clang-format checks whether each input file (specified on the
# command line) is formatted with clang-format, and exits with an error
# code if not.

clang_format="node_modules/.bin/clang-format -style=file"

for f in "$@"; do
  if ! diff -q <($clang_format "$f") "$f" > /dev/null; then
    echo "$f: needs clang-format"
    exit 1
  fi
done
