#!/bin/sh
# The whole suite at a spread of offsets: every weekday, both directions, both
# DST transitions, a month end, and a year out. Any test that reads the wall
# clock rather than a fixed anchor shows up as a failure at some offset.
set -e
fail=0
for d in -400 -31 -7 -3 -2 -1 0 1 2 3 4 5 6 7 21 51 82 113 180 365; do
  out=$(SHIFT_DAYS=$d node --require ./test/helpers/shift-clock.js --test test/*.test.js 2>&1 || true)
  n=$(echo "$out" | grep -E "^. fail" | awk '{print $3}')
  if [ "$n" != "0" ]; then
    echo "FAIL at ${d}d: $n failing"
    echo "$out" | grep -E "^. (not ok|✖)" | head -5
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "clock sweep clean: no test depends on today's date"
exit $fail
