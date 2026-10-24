#!/bin/sh
# Simulates the phone: a private DSH home *with a profile, a skill and an index*,
# the delivered join.sh, and the real network round trip against a desktop
# listener.
#
# Usage: sh test/phone.sh <workdir> <base-url> <token>
#
# The phone home deliberately looks like a real install, because that is what
# makes the interesting channels reachable: without `<home>/profiles/<name>/
# package.json` the script has nowhere to put a plugin and no bundle list to
# register it in, so a profile-less fixture would only ever test sessions.
set -eu

WORK="$1"
BASE="$2"
TOKEN="$3"

SELF_DIR=$(cd "$(dirname "$0")" && pwd)

PHONE_HOME="$WORK/phone-home"
PHONE_SESSIONS="$PHONE_HOME/sessions"
PHONE_PROFILE="$PHONE_HOME/profiles/desktop"
PHONE_STATE="$WORK/desktop-home/dsh-mobile-sync/state.json"
rm -rf "$PHONE_HOME"
mkdir -p "$PHONE_SESSIONS" "$PHONE_PROFILE/node_modules/dsh-pet" "$PHONE_HOME/skills" "$PHONE_HOME/storages"

fail() {
  echo "ASSERTION FAILED: $*" >&2
  exit 1
}
ok() { echo "  ok  $*"; }

# Unix mtime in seconds, with a byte-count fallback for a stat that does not
# speak either dialect (the point is only "did this file get replaced").
mtime_of() {
  if stat -c %Y "$1" >/dev/null 2>&1; then stat -c %Y "$1"
  elif stat -f %m "$1" >/dev/null 2>&1; then stat -f %m "$1"
  else wc -c < "$1" | tr -d ' '
  fi
}

# ---------------------------------------------------------- a fake phone home

cat > "$PHONE_PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile-phone",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["dsh-pet"]
    }
  },
  "dependencies": {
    "dsh-pet": "0.3.8"
  }
}
JSON

cat > "$PHONE_PROFILE/node_modules/dsh-pet/package.json" <<'JSON'
{
  "name": "dsh-pet",
  "version": "0.3.8",
  "description": "The phone's own plugin; a sync must leave it registered.",
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    }
  }
}
JSON
echo "export const name = 'dsh-pet'" > "$PHONE_PROFILE/node_modules/dsh-pet/index.js"
echo '[]' > "$PHONE_PROFILE/cordis.patch.yml"

mkdir -p "$PHONE_HOME/skills/phone-skill"
cat > "$PHONE_HOME/skills/phone-skill/SKILL.md" <<'MD'
---
name: phone-skill
description: A skill that only exists on the phone.
---

# phone-skill

It must survive a pull untouched.
MD

cat > "$PHONE_HOME/storages/workspace.json" <<'JSON'
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": [],
    "archivedSessionIds": [],
    "pinnedSessionIds": []
  },
  "tables": { "workspaces": {} }
}
JSON

# ------------------------------------------------------------------- the run

echo "--- fetching join.sh"
curl -fsS "$BASE/join.sh?t=$TOKEN&device=Pixel%209" -o "$WORK/join.sh"
echo "--- fetched join.sh ($(wc -c < "$WORK/join.sh" | tr -d ' ') bytes)"
sh -n "$WORK/join.sh" && ok "sh -n on the rendered script"

echo "--- fetching the control page"
curl -fsS "$BASE/j?t=$TOKEN&device=Pixel%209" -o "$WORK/page.html"
grep -q '开始同步' "$WORK/page.html" || fail "the control page does not mention the sync button"
grep -q '模型组' "$WORK/page.html" || fail "the control page does not list model groups"
grep -q '只会配对并等待' "$WORK/page.html" || fail "the control page does not explain that pair only waits"
ok "the control page renders the sync button, model groups and the pair explanation"

# The Android tar cannot exec gzip, so no on-the-fly compressed tar may appear.
old=$(grep -c -e 'tar czf' -e 'tar xzf' -e 'tar -z' "$WORK/join.sh" || true)
[ "$old" = "0" ] || fail "the rendered script still contains a compressed-tar shortcut ($old)"
ok "no tar -z / tar czf / tar xzf in the rendered script"

echo
echo "=== 1. status (empty phone) ==="
DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" status > "$WORK/status.log" 2>&1 || {
  cat "$WORK/status.log"
  exit 1
}
cat "$WORK/status.log"
grep -q '^桌面清单：' "$WORK/status.log" || fail "status did not print the desktop manifest"
grep -q '^[[:space:]]*profile=1$' "$WORK/status.log" || fail "the manifest in status does not report profile=1"
grep -Fq "$PHONE_PROFILE" "$WORK/status.log" || fail "status did not report the phone profile"
ok "status prints the address, home, profile, counts and the manifest"

echo
echo "=== 2. push with no sessions yet (metadata only) ==="
DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" push > "$WORK/push-empty.log" 2>&1 || {
  cat "$WORK/push-empty.log"
  exit 1
}
cat "$WORK/push-empty.log"
grep -q '本机还没有会话记录，只上传元数据' "$WORK/push-empty.log" || fail "the empty push did not say it was metadata-only"
[ -f "$PHONE_STATE" ] || fail "the desktop kept no state.json"
grep -Fq '"device": "SHELL-TEST"' "$PHONE_STATE" || fail "the desktop did not record the device name"
grep -Fq "$PHONE_HOME" "$PHONE_STATE" || fail "the desktop did not record the phone home from _meta/phone.env"
grep -Fq '来自 SHELL-TEST' "$PHONE_STATE" || fail "the desktop did not log the device"
ok "_meta/phone.env reached the desktop (device + home), and the desktop logged it"

# `_meta/sessions.txt` travels on every push, even with nothing to list.
PEER_SESSIONS="$WORK/desktop-home/dsh-mobile-sync/peer/sessions.txt"
[ -f "$PEER_SESSIONS" ] || fail "_meta/sessions.txt was not uploaded by the empty push"
if [ -s "$PEER_SESSIONS" ]; then fail "_meta/sessions.txt should be empty when the phone has no sessions"; fi
ok "_meta/sessions.txt uploaded and empty (no phone sessions yet)"

echo
echo "=== 3. pull desktop -> phone ==="
DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" pull > "$WORK/pull-1.log" 2>&1 || {
  cat "$WORK/pull-1.log"
  exit 1
}
cat "$WORK/pull-1.log"
grep -q '应用：会话 1，插件 1，技能 2' "$WORK/pull-1.log" || fail "first pull did not apply 1 session / 1 plugin / 2 skills"
ok "first pull summary: 1 / 1 / 2"

# The one desktop session's id, taken from where the fixture put it.
DESKTOP_SESSION=''
for candidate in "$WORK"/desktop-home/sessions/*/*; do
  [ -d "$candidate" ] || continue
  DESKTOP_SESSION="${candidate##*/}"
done
[ -n "$DESKTOP_SESSION" ] || fail "the fixture has no desktop session to carry"
echo "--- phone now holds:"
find "$PHONE_SESSIONS" -type f | sed "s#$PHONE_SESSIONS#  #"
[ -f "$PHONE_SESSIONS"/*/"$DESKTOP_SESSION"/session.v4.jsonl.zstd ] || fail "the desktop session was not installed"
ok "session $DESKTOP_SESSION installed under \$DSH_HOME/sessions"

grep -Fq "$DESKTOP_SESSION" "$PHONE_HOME/storages/workspace.json" || fail "the installed index does not list the desktop session"
[ -f "$PHONE_HOME/storages/workspace.json.bak-mobile-sync" ] || fail "the installed index kept no rolling backup"
ok "workspace.json lists the session and the previous copy was backed up"

[ -f "$PHONE_PROFILE/node_modules/dsh-demo/package.json" ] || fail "the dsh-demo plugin was not installed"
grep -q '"version": "1.2.3"' "$PHONE_PROFILE/node_modules/dsh-demo/package.json" || fail "the installed plugin has the wrong version"
[ -f "$PHONE_PROFILE/node_modules/dsh-demo/index.js" ] || fail "the plugin's JS file was not installed"
ok "plugin dsh-demo@1.2.3 installed into the phone profile"

grep -q '"dsh-demo"' "$PHONE_PROFILE/package.json" || fail "the phone profile does not list dsh-demo in dsh.profile.bundles"
grep -q '"dsh-pet"' "$PHONE_PROFILE/package.json" || fail "the phone profile lost its own dsh-pet bundle"
[ -f "$PHONE_PROFILE/package.json.bak-mobile-sync" ] || fail "the profile was overwritten without a backup"
ok "phone profile now bundles dsh-demo, still bundles dsh-pet, with a backup"

[ -f "$PHONE_HOME/skills/desk-skill/SKILL.md" ] || fail "the bundle skill was not installed"
[ -f "$PHONE_HOME/skills/desk-flat.md" ] || fail "the flat skill was not installed"
[ -f "$PHONE_HOME/skills/phone-skill/SKILL.md" ] || fail "the phone's own skill disappeared"
ok "skills desk-skill/ and desk-flat.md installed, phone-skill kept"

echo
echo "=== 4. fabricate a phone-originated session, then push ==="
"${NODE:?}" "$SELF_DIR/make-phone-session.mjs" "$PHONE_SESSIONS" session-phone-aaaa 4096
DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" push > "$WORK/push-2.log" 2>&1 || {
  cat "$WORK/push-2.log"
  exit 1
}
cat "$WORK/push-2.log"
grep -Fq '来自 SHELL-TEST' "$WORK/push-2.log" || fail "the desktop did not attribute the push to this device"
grep -Fq '"dsh-demo": "1.2.3"' "$PHONE_STATE" || fail "plugins.txt did not report the installed dsh-demo"
grep -Fq '"dsh-pet": "0.3.8"' "$PHONE_STATE" || fail "plugins.txt did not report the phone's own dsh-pet"
grep -Fq '"desk-skill"' "$PHONE_STATE" || fail "skills.txt did not report desk-skill"
grep -Fq '"desk-flat"' "$PHONE_STATE" || fail "skills.txt did not report desk-flat"
ok "the desktop received plugins.txt (dsh-demo, dsh-pet) and skills.txt"

# `_meta/sessions.txt` now names both logs with the exact bytes on disk, which is
# what lets the desktop skip a re-send the phone would refuse anyway.
[ -f "$PEER_SESSIONS" ] || fail "_meta/sessions.txt was not uploaded by the populated push"
REPORTED=$(wc -l < "$PEER_SESSIONS" | tr -d ' ')
[ "$REPORTED" = "2" ] || fail "_meta/sessions.txt should list 2 session logs, listed $REPORTED"
# Resolve the glob into a variable first: a redirection target is not
# pathname-expanded by a POSIX shell, so `wc -c < "$dir"/*/f` would not work.
DESKTOP_FILE=''
for candidate in "$PHONE_SESSIONS"/*/"$DESKTOP_SESSION"/session.v4.jsonl.zstd; do
  [ -f "$candidate" ] || continue
  DESKTOP_FILE="$candidate"
done
[ -n "$DESKTOP_FILE" ] || fail "the pulled session file is not on disk"
DESKTOP_BYTES=$(wc -c < "$DESKTOP_FILE" | tr -d ' ')
grep -Fq "$DESKTOP_SESSION $DESKTOP_BYTES" "$PEER_SESSIONS" || fail "_meta/sessions.txt does not report $DESKTOP_SESSION at $DESKTOP_BYTES bytes"
grep -Eq '^session-phone-aaaa [0-9]+$' "$PEER_SESSIONS" || fail "_meta/sessions.txt does not report the fabricated phone session"
ok "_meta/sessions.txt lists both logs with their byte sizes ($DESKTOP_SESSION $DESKTOP_BYTES)"

echo
echo "=== 5. second pull is a no-op (same versions / digests) ==="
BEFORE_SUM=$(cksum "$PHONE_PROFILE/node_modules/dsh-demo/package.json")
BEFORE_MTIME=$(mtime_of "$PHONE_PROFILE/node_modules/dsh-demo/package.json")
DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" pull > "$WORK/pull-2.log" 2>&1 || {
  cat "$WORK/pull-2.log"
  exit 1
}
cat "$WORK/pull-2.log"
grep -q '应用：会话 0，插件 0，技能 0' "$WORK/pull-2.log" || fail "second pull was not a no-op"
AFTER_SUM=$(cksum "$PHONE_PROFILE/node_modules/dsh-demo/package.json")
AFTER_MTIME=$(mtime_of "$PHONE_PROFILE/node_modules/dsh-demo/package.json")
[ "$BEFORE_SUM" = "$AFTER_SUM" ] || fail "the plugin file was rewritten on the second pull"
[ "$BEFORE_MTIME" = "$AFTER_MTIME" ] || fail "the plugin file's mtime moved on the second pull"
ok "second pull reported 0/0/0 and left the plugin file byte-identical (mtime unchanged)"

echo
echo "=== 6. install ==="
# Keep the install inside the work dir: a real $HOME would be polluted.
mkdir -p "$WORK/home"
HOME="$WORK/home" DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" install || exit 1
test -f "$WORK/home/.dsh-mobile-sync/sync.sh" || {
  echo "install did not land in \$HOME/.dsh-mobile-sync" >&2
  exit 1
}
echo "--- installed at \$HOME/.dsh-mobile-sync/sync.sh"

echo
echo "=== 7. pair waits for the desktop button (no auto sync on download) ==="
PAIR_OUT="$WORK/pair.log"
rm -f "$PAIR_OUT"
HOME="$WORK/home" DSH_HOME="$PHONE_HOME" sh "$WORK/join.sh" pair > "$PAIR_OUT" 2>&1 &
PAIR_PID=$!
attempt=0
while [ "$attempt" -lt 200 ]; do
  if grep -q '本次同步完成' "$PAIR_OUT" 2>/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 0.5
done
# SIGKILL: the pair loop may be parked in a long `curl`, and MSYS/Git-Bash does
# not always deliver SIGTERM through a blocked native child. The script's own
# TERM trap (exit after cleanup) is what a real Ctrl-C uses.
kill -9 "$PAIR_PID" 2>/dev/null || true
cat "$PAIR_OUT"
grep -q '等待桌面面板点' "$PAIR_OUT" || fail "pair did not say it waits for the desktop button"
grep -q '收到同步指令' "$PAIR_OUT" || fail "pair never received the armed sync request"
grep -q '本次同步完成' "$PAIR_OUT" || fail "pair did not finish the sync"

# The ordering is the proof: the wait line comes first, then the request, and
# only then an upload. A script that synced on download would upload before it.
WAIT_LINE=$(grep -n '等待桌面面板点' "$PAIR_OUT" | head -1 | cut -d: -f1)
REQ_LINE=$(grep -n '收到同步指令' "$PAIR_OUT" | head -1 | cut -d: -f1)
UP_LINE=$(grep -n '上传到桌面' "$PAIR_OUT" | head -1 | cut -d: -f1)
[ -n "$WAIT_LINE" ] && [ -n "$REQ_LINE" ] && [ -n "$UP_LINE" ] || fail "pair log is missing one of wait/request/upload"
[ "$WAIT_LINE" -lt "$REQ_LINE" ] || fail "pair received the request before it started waiting"
[ "$UP_LINE" -gt "$REQ_LINE" ] || fail "pair uploaded before the desktop button was pressed"
grep -Fq '"status": "done"' "$PHONE_STATE" || fail "the desktop did not record the finished sync request"
ok "pair installed, waited, and only synced after the request was armed"

echo
echo "SHELL ROUND TRIP DONE"
