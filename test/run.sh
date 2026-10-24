#!/bin/sh
# Run every check: the unit suites, then a real phone-shaped round trip against a
# throwaway desktop listener.
#
# Usage:
#   NODE=/path/to/node sh test/run.sh [port]
#   SKIP_SHELL=1 NODE=... sh test/run.sh        # unit suites only
#
# Every step is bounded: a hanging fixture must fail the run, not wedge it.
#
# The round trip deliberately starts the fixture inside a subshell and stops it
# with an explicit `kill "$(cat pid)"` instead of `wait`. A shell that waits on a
# background listener can block forever when the listener is a native Windows
# child (its signal handling belongs to another process tree), and this is the
# shape that has been observed to return promptly on this machine.
set -eu

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
PORT=${1:-8733}
LOG=$(mktemp 2>/dev/null || mktemp -t dsh-mobile-sync-log)

echo "== unit suites =="
for suite in host entry client qr plugins skills models transfer; do
  printf '%-10s ' "$suite"
  if "$NODE" "$SELF_DIR/$suite.mjs" >"$LOG" 2>&1; then
    tail -1 "$LOG"
  else
    echo "FAILED"
    cat "$LOG" >&2
    rm -f "$LOG"
    exit 1
  fi
done
rm -f "$LOG"

if [ "${SKIP_SHELL:-0}" = "1" ]; then
  echo
  echo "ALL CHECKS PASSED (shell round trip skipped)"
  exit 0
fi

echo
echo "== phone round trip =="
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t dsh-mobile-sync)

(
  # Arm the panel's「开始同步」request a few seconds after the listener is up, so
  # the pair-mode step can prove the phone waits for it instead of syncing on
  # download.
  DSH_FIXTURE_ARM_MS="${DSH_FIXTURE_ARM_MS:-4000}" \
    "$NODE" "$SELF_DIR/fixture.mjs" "$WORK" "$PORT" >"$WORK/fixture.log" 2>&1 &
  echo $! >"$WORK/pid"
)

stop_fixture() {
  if [ -f "$WORK/pid" ]; then
    kill "$(cat "$WORK/pid")" 2>/dev/null || true
  fi
}

attempt=0
while [ "$attempt" -lt 300 ]; do
  if grep -q '^READY ' "$WORK/fixture.log" 2>/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if ! grep -q '^READY ' "$WORK/fixture.log" 2>/dev/null; then
  echo "the fixture listener did not start:" >&2
  cat "$WORK/fixture.log" >&2
  stop_fixture
  exit 1
fi

BASE=$(sed -n 's/^READY \([^ ][^ ]*\) [^ ][^ ]* [0-9][0-9]*$/\1/p' "$WORK/fixture.log" | head -1)
TOKEN=$(sed -n 's/^READY [^ ][^ ]* \([^ ][^ ]*\) [0-9][0-9]*$/\1/p' "$WORK/fixture.log" | head -1)

if command -v timeout >/dev/null 2>&1; then
  if NODE="$NODE" timeout 300 sh "$SELF_DIR/phone.sh" "$WORK" "$BASE" "$TOKEN"; then rc=0; else rc=$?; fi
else
  if NODE="$NODE" sh "$SELF_DIR/phone.sh" "$WORK" "$BASE" "$TOKEN"; then rc=0; else rc=$?; fi
fi

stop_fixture
if [ "$rc" -ne 0 ]; then
  echo "phone round trip failed (exit $rc)" >&2
  exit "$rc"
fi

echo
echo "ALL CHECKS PASSED"
