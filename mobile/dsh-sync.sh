#!/bin/sh
# dsh-mobile-sync — move DSH session records between this phone and the desktop.
#
# This file is delivered by the desktop plugin with the three placeholders below
# already filled in, so running it needs no arguments:
#
#     sh dsh-sync.sh            # pair: install, then wait for the desktop button
#     sh dsh-sync.sh pair       # same as no argument
#     sh dsh-sync.sh wait       # only wait (no install)
#     sh dsh-sync.sh both       # push + pull right now (explicit, manual)
#     sh dsh-sync.sh push       # phone -> desktop only
#     sh dsh-sync.sh pull       # desktop -> phone only
#     sh dsh-sync.sh status     # reach the desktop and print its inventory
#     sh dsh-sync.sh install    # keep a copy at ~/.dsh-mobile-sync/sync.sh
#     sh dsh-sync.sh watch      # install, then wait in the background
#
# Downloading this script must never start a transfer. `pair` installs it and
# then holds a long poll against the desktop; only when the desktop panel's
# 「开始同步」button arms a request does this side run push + pull, and it reports
# back with `/api/done`. `both`/`push`/`pull` stay available for an explicit
# one-off run from a terminal.
#
# It needs nothing but the `curl`, `tar`, `gzip` and `sh` that already ship with
# the app's Termux snapshot: the desktop decompresses records, so no zstd exists
# here, and there is no Node, no `jq` and no YAML tool on this side at all.
#
# Every archive goes through an explicit `tar | gzip` (or `gzip | tar`) pipeline,
# and never through tar's own compression flag: on this Android image tar cannot
# exec gzip, and that failure is a hard stop halfway through a sync.
#
# Protocol — every API call carries the header `X-DSH-Sync-Token: $TOKEN`, and
# the device name rides along as `?device=` (only `/join.sh` still takes `?t=`):
#
#   GET  $BASE/api/ping      JSON liveness, nothing here parses it
#   GET  $BASE/api/manifest  plain key=value: sessions/models/plugins/skills/
#                            secrets/profile/desktop/manual/request
#   GET  $BASE/api/await     long poll: blocks up to `timeout` seconds and answers
#                            `request=<id>` when the desktop panel armed a sync
#                            (or `request=0` on timeout)
#   POST $BASE/api/done      `?request=<id>`: this side finished that request
#   POST $BASE/api/push      gzipped tar this script builds:
#                            --<project>--/<session>/session.v4.jsonl.zstd
#                            _meta/phone.env, plugins.txt, skills.txt,
#                            sessions.txt ("<id> <bytes>" per log), index.json
#                            _meta/profile/package.json   (manifest profile=1)
#                            _meta/patch/cordis.patch.yml (manifest models=1)
#                            _meta/patch/credentials.yaml (manifest secrets=1)
#   POST $BASE/api/pull      gzipped tar the desktop builds; applied in pull():
#                            sessions/...  _meta/index.json  _meta/profile/...
#                            _meta/plugins/<name>/...  _meta/skills/<name>[.md]
#                            _meta/patch/...  _meta/readme.txt
#
# Nothing is written outside $DSH_HOME, $PROFILE, $HOME/.dsh-mobile-sync and the
# scratch directory, and every overwrite keeps one rolling `<file>.bak-mobile-sync`.
set -eu

BASE='__BASE__'
TOKEN='__TOKEN__'
LABEL='__NAME__'

MODE="${1:-pair}"
API="$BASE/api"
SELF_DIR="$HOME/.dsh-mobile-sync"
BAK='.bak-mobile-sync'

# Workspace facts, filled in by the discovery block at the bottom before the
# mode is dispatched. They are initialised empty so the helpers below can be
# called (and the cleanup trap can run) at any point.
HOME_DIR=''
ROOT=''
PROFILE=''
PROFILE_NAME=''
META_DIR=''

# A scratch directory: prefer the runtime's own temp location, but never assume
# it exists — Android images differ on whether /tmp is present at all.
if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR:-}" ]; then
  TMP_BASE="$TMPDIR"
elif [ -d /tmp ]; then
  TMP_BASE=/tmp
else
  TMP_BASE="$HOME"
fi
TMP="$TMP_BASE/dsh-mobile-sync.$$"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
yesno() { if [ "$1" = "1" ]; then printf '是'; else printf '否'; fi; }

# The Termux snapshot ships curl and tar. Say so plainly when one is missing
# instead of failing halfway through a transfer.
need_curl() {
  command -v curl >/dev/null 2>&1 || die "缺少 curl。请在应用的终端里执行： pkg install curl"
}
if command -v tar >/dev/null 2>&1; then
  TAR=tar
elif command -v busybox >/dev/null 2>&1; then
  TAR='busybox tar'
else
  TAR=''
fi
need_tar() {
  [ -n "$TAR" ] || die "缺少 tar。请在应用的终端里执行： pkg install tar"
}

cleanup() {
  rm -rf "$TMP" 2>/dev/null || true
  # The push stages its `_meta/` inside the sessions root so that ONE `tar -C`
  # can carry both the logs and the metadata (a repositioned `-C` is not honoured
  # by every tar on Android). That staging directory must never survive.
  if [ -n "${META_DIR:-}" ] && [ -d "$META_DIR" ]; then
    rm -rf "$META_DIR" 2>/dev/null || true
  fi
}

# A bare `cleanup` trap on INT/TERM would leave the wait loop running after the
# signal (POSIX shells resume after a trap that returns), so a Ctrl-C or a kill
# from the desktop could never stop `pair`. Exit explicitly instead.
on_signal() {
  cleanup
  trap - EXIT
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

# ---------------------------------------------------------------- discovery

# A device name the desktop can show, without asking the user for one.
detect_device() {
  if [ -n "${DSH_SYNC_DEVICE:-}" ]; then printf '%s' "$DSH_SYNC_DEVICE"; return; fi
  if command -v getprop >/dev/null 2>&1; then
    model="$(getprop ro.product.model 2>/dev/null || true)"
    if [ -n "$model" ]; then printf '%s' "$model"; return; fi
  fi
  # The pairing value baked into LABEL when the script was delivered; useful on
  # a machine with no getprop (a desktop shell, a container).
  case "${LABEL:-}" in
    ''|'__NAME__') ;;
    *) printf '%s' "$LABEL"; return ;;
  esac
  host="$(uname -n 2>/dev/null || true)"
  if [ -n "$host" ]; then printf '%s' "$host"; return; fi
  printf 'android'
}

find_home() {
  if [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME/sessions" ]; then printf '%s' "$DSH_HOME"; return 0; fi
  for candidate in "$HOME/.dsh" "/data/data/com.dsharnessmobile.shell/files/home/.dsh" "/sdcard/.dsh"; do
    if [ -d "$candidate/sessions" ]; then printf '%s' "$candidate"; return 0; fi
  done
  # Last resort: the runtime may have moved its home; look for the sessions dir.
  if command -v find >/dev/null 2>&1; then
    found="$(find "$HOME" /data/data /sdcard -maxdepth 6 -type d -name sessions 2>/dev/null | head -n 1 || true)"
    if [ -n "$found" ]; then printf '%s' "$(dirname "$found")"; return 0; fi
  fi
  return 1
}

# Does this package.json compose bundles? The phone only has `sed`, so this is a
# substring test rather than a parse — the desktop's own rule is "has bundles".
has_bundles() {
  [ -f "$1" ] || return 1
  hit="$(sed -n 's/.*"bundles".*/x/p' "$1" 2>/dev/null | head -n 1)"
  [ -n "$hit" ]
}

find_profile() {
  home="$1"
  # An explicit choice wins, whether it names a directory or a profile name.
  if [ -n "${DSH_PROFILE:-}" ]; then
    if [ -f "$DSH_PROFILE/package.json" ]; then printf '%s' "$DSH_PROFILE"; return 0; fi
    if [ -f "$home/profiles/$DSH_PROFILE/package.json" ]; then printf '%s' "$home/profiles/$DSH_PROFILE"; return 0; fi
  fi
  [ -d "$home/profiles" ] || return 1
  # A directory literally called `desktop` is what a normal install has.
  if has_bundles "$home/profiles/desktop/package.json"; then printf '%s' "$home/profiles/desktop"; return 0; fi
  for dir in "$home"/profiles/*; do
    [ -d "$dir" ] || continue
    case "$dir" in
      "$home/profiles/desktop") continue ;;
    esac
    if has_bundles "$dir/package.json"; then printf '%s' "$dir"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- inventory

# First `"version": "x"` line in a package.json. The cap is what keeps a nested
# dependency's own `version` field from winning: in a normal manifest the
# top-level one comes first, and an indented line is matched first as well.
pkg_version() {
  [ -f "$1" ] || return 0
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1)"
  if [ -z "$version" ]; then
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1)"
  fi
  printf '%s' "$version"
}

# `_meta/plugins.txt`: "<package name> <version>" per installed plugin. The name
# comes from the directory (that is the npm identity), `@scope/name` for scoped
# packages. An entry without a readable package.json is skipped.
write_plugins() {
  out="$1"
  : > "$out"
  [ -n "$PROFILE" ] || return 0
  modules="$PROFILE/node_modules"
  [ -d "$modules" ] || return 0
  for dir in "$modules"/*; do
    [ -d "$dir" ] || continue
    case "${dir##*/}" in
      '@'*) continue ;;
    esac
    [ -f "$dir/package.json" ] || continue
    printf '%s %s\n' "${dir##*/}" "$(pkg_version "$dir/package.json")" >> "$out"
  done
  for scope in "$modules"/@*; do
    [ -d "$scope" ] || continue
    for dir in "$scope"/*; do
      [ -d "$dir" ] || continue
      [ -f "$dir/package.json" ] || continue
      printf '%s/%s %s\n' "${scope##*/}" "${dir##*/}" "$(pkg_version "$dir/package.json")" >> "$out"
    done
  done
}

# `_meta/skills.txt`: one installed skill name per line, from both roots, with a
# bundle's directory name and a flat `*.md` stem counting as the same identity.
write_skills() {
  out="$1"
  : > "$out"
  seen=''
  for skills_root in "$HOME_DIR/skills" "$HOME/.agents/skills"; do
    [ -d "$skills_root" ] || continue
    for entry in "$skills_root"/*; do
      [ -e "$entry" ] || continue
      case "${entry##*/}" in
        .*) continue ;;
      esac
      if [ -d "$entry" ]; then
        name="${entry##*/}"
      elif [ -f "$entry" ]; then
        case "$entry" in
          *.md) name="${entry##*/}" ; name="${name%.md}" ;;
          *) continue ;;
        esac
      else
        continue
      fi
      case " $seen " in
        *" $name "*) continue ;;
      esac
      seen="$seen $name"
      printf '%s\n' "$name" >> "$out"
    done
  done
}

# `_meta/sessions.txt`: `<session-id> <bytes>` per session log, so the desktop can
# skip re-sending a log the phone already holds byte-for-byte. It is uploaded on
# every push — empty when the phone has no logs yet.
write_sessions() {
  out="$1"
  : > "$out"
  [ -d "$ROOT" ] || return 0
  for file in "$ROOT"/*/*/session.v*.jsonl*; do
    [ -f "$file" ] || continue
    # Skip the push's own staging tree (an empty META_DIR must never become a
    # `/*` pattern that would match every absolute path).
    if [ -n "$META_DIR" ]; then
      case "$file" in
        "$META_DIR"/*) continue ;;
      esac
    fi
    dir="${file%/*}"
    printf '%s %s\n' "${dir##*/}" "$(wc -c < "$file" | tr -d ' ')" >> "$out"
  done
}

count_sessions() {
  n=0
  [ -d "$ROOT" ] || { printf '0'; return 0; }
  for project in "$ROOT"/*; do
    [ -d "$project" ] || continue
    case "${project##*/}" in
      _meta) continue ;;
    esac
    for session in "$project"/*; do
      [ -d "$session" ] || continue
      n=$((n + 1))
    done
  done
  printf '%s' "$n"
}

count_plugins() {
  [ -n "$PROFILE" ] || { printf '0'; return 0; }
  write_plugins "$TMP/count-plugins.txt"
  wc -l < "$TMP/count-plugins.txt" | tr -d ' '
}

count_skills() {
  write_skills "$TMP/count-skills.txt"
  wc -l < "$TMP/count-skills.txt" | tr -d ' '
}

# ---------------------------------------------------------------- transport

# The desktop's manifest is plain text precisely because this side cannot parse
# JSON. An older desktop has no manifest route, in which case the three optional
# files are simply left out.
manifest_value() {
  [ -f "$TMP/manifest" ] || return 0
  sed -n "s/^$1=//p" "$TMP/manifest" | head -n 1 | tr -d '\r'
}

fetch_manifest() {
  rm -f "$TMP/manifest"
  curl -fsS --max-time 15 -H "X-DSH-Sync-Token: $TOKEN" "$API/manifest?$DEVQ" -o "$TMP/manifest" 2>/dev/null || return 1
  return 0
}

# Read the four optional-channel switches out of the manifest, defaulting to
# "do not send" so an older desktop simply receives the required files.
read_manifest() {
  MAN_SESSIONS="$(manifest_value sessions)"
  MAN_MODELS="$(manifest_value models)"
  MAN_PROFILE="$(manifest_value profile)"
  MAN_SECRETS="$(manifest_value secrets)"
  if [ -z "$MAN_SESSIONS" ]; then MAN_SESSIONS=1; fi
  if [ -z "$MAN_MODELS" ]; then MAN_MODELS=0; fi
  if [ -z "$MAN_PROFILE" ]; then MAN_PROFILE=0; fi
  if [ -z "$MAN_SECRETS" ]; then MAN_SECRETS=0; fi
}

ping() {
  need_curl
  mkdir -p "$TMP"
  reply="$(curl -fsS --max-time 8 -H "X-DSH-Sync-Token: $TOKEN" "$API/ping?$DEVQ")" || die "桌面端不可达：$BASE
   请确认电脑和手机在同一局域网，且插件面板里显示「运行中」。"
  say "桌面响应：$reply"
}

# ---------------------------------------------------------------- push

# Fill $META_DIR (inside the sessions root, see cleanup()) with everything the
# desktop needs to know about this phone.
stage_meta() {
  rm -rf "$META_DIR"
  mkdir -p "$META_DIR" || die "无法创建元数据目录：$META_DIR"
  {
    printf 'device=%s\n' "$DEVICE"
    printf 'home=%s\n' "$HOME_DIR"
    printf 'sessions=%s\n' "$ROOT"
    printf 'profile=%s\n' "$PROFILE"
    printf 'profileName=%s\n' "$PROFILE_NAME"
  } > "$META_DIR/phone.env"
  write_plugins "$META_DIR/plugins.txt"
  write_skills "$META_DIR/skills.txt"
  write_sessions "$META_DIR/sessions.txt"

  # The index is what makes a session visible, so it travels whenever it exists,
  # even on a push that carries no logs at all.
  if [ -f "$HOME_DIR/storages/workspace.json" ]; then
    cp "$HOME_DIR/storages/workspace.json" "$META_DIR/index.json" || die "无法读取 workspace.json"
  fi

  if [ "$MAN_PROFILE" = "1" ] && [ -n "$PROFILE" ] && [ -f "$PROFILE/package.json" ]; then
    mkdir -p "$META_DIR/profile" || die "无法创建 $META_DIR/profile"
    cp "$PROFILE/package.json" "$META_DIR/profile/package.json" || die "无法读取 profile/package.json"
  fi

  if [ "$MAN_MODELS" = "1" ] && [ -n "$PROFILE" ] && [ -f "$PROFILE/cordis.patch.yml" ]; then
    mkdir -p "$META_DIR/patch" || die "无法创建 $META_DIR/patch"
    cp "$PROFILE/cordis.patch.yml" "$META_DIR/patch/cordis.patch.yml" || die "无法读取 cordis.patch.yml"
  fi

  if [ "$MAN_SECRETS" = "1" ] && [ -f "$HOME_DIR/.credentials.yaml" ]; then
    mkdir -p "$META_DIR/patch" || die "无法创建 $META_DIR/patch"
    cp "$HOME_DIR/.credentials.yaml" "$META_DIR/patch/credentials.yaml" || die "无法读取 .credentials.yaml"
  fi
}

# Build the archive as one `tar | gzip` pipeline. Every operand is relative to
# $ROOT and there is exactly ONE `-C`: repositioned `-C` arguments are not
# honoured by every tar that ships on Android, and a single root needs none.
pack_archive() {
  out="$1"
  set --
  packed=0
  # The manifest says which channels the desktop is accepting; logs are only
  # worth uploading when its sessions channel is on.
  if [ "$MAN_SESSIONS" = "1" ]; then
    for dir in "$ROOT"/*; do
      [ -d "$dir" ] || continue
      case "${dir##*/}" in
        _meta) continue ;;
      esac
      has_session=0
      for session in "$dir"/*; do
        if [ -d "$session" ]; then has_session=1; break; fi
      done
      [ "$has_session" = "1" ] || continue
      set -- "$@" "./${dir##*/}"
      packed=$((packed + 1))
    done
  fi
  set -- "$@" ./_meta
  PACKED_PROJECTS="$packed"
  $TAR cf - -C "$ROOT" "$@" | gzip > "$out" || die "打包失败"
  [ -s "$out" ] || die "打包失败：$out 是空的"
}

push() {
  need_curl
  need_tar
  mkdir -p "$ROOT" || die "无法创建会话目录：$ROOT"
  MAN_SESSIONS=1
  MAN_MODELS=0
  MAN_PROFILE=0
  MAN_SECRETS=0
  fetch_manifest || true
  read_manifest

  say "→ 上传到桌面（$BASE）..."
  stage_meta
  pack_archive "$TMP/push.tgz"
  if [ "$PACKED_PROJECTS" = "0" ]; then
    if [ "$MAN_SESSIONS" = "1" ]; then
      say "  本机还没有会话记录，只上传元数据（索引、插件、技能）。"
    else
      say "  桌面已关闭会话通道，本次只上传元数据。"
    fi
  fi
  bytes="$(wc -c < "$TMP/push.tgz" | tr -d ' ')"
  say "  打包完成：$bytes 字节"
  curl -fsS --max-time 300 -X POST \
    -H "X-DSH-Sync-Token: $TOKEN" \
    -H 'Content-Type: application/gzip' \
    --data-binary @"$TMP/push.tgz" \
    "$API/push?$DEVQ" || die "上传失败"
  say ''
}

# ---------------------------------------------------------------- pull

# Identical-bytes test for the small text files a pull installs. Sizes are
# compared first so a large unrelated file never gets read into the shell.
same_bytes() {
  [ -f "$1" ] && [ -f "$2" ] || return 1
  cmp_a="$(wc -c < "$1" | tr -d ' ')"
  cmp_b="$(wc -c < "$2" | tr -d ' ')"
  [ "$cmp_a" = "$cmp_b" ] || return 1
  cmp_x="$(cat "$1")"
  cmp_y="$(cat "$2")"
  [ "$cmp_x" = "$cmp_y" ]
}

# Copy one plain file into place, keeping a single rolling backup of what was
# there before. Never called for a session log (those append, they do not swap).
install_file() {
  mkdir -p "$(dirname "$2")" || die "无法创建目录：$(dirname "$2")"
  if [ -f "$2" ]; then
    cp "$2" "$2$BAK" || die "无法备份：$2"
  fi
  cp "$1" "$2" || die "无法写入：$2"
}

# Replace a whole directory (plugin or skill bundle) with the incoming one.
install_dir() {
  src="$1"
  dst="$2"
  mkdir -p "$(dirname "$dst")" || die "无法创建目录：$(dirname "$dst")"
  if [ -d "$dst" ]; then
    rm -rf "$dst$BAK" || die "无法清理旧备份：$dst$BAK"
    mv "$dst" "$dst$BAK" || die "无法备份：$dst"
  fi
  mkdir -p "$dst" || die "无法创建：$dst"
  cp -R "$src/." "$dst/" || die "无法写入：$dst"
}

apply_sessions() {
  n=0
  if [ ! -d "$TMP/x/sessions" ]; then SESSIONS_APPLIED=0; return 0; fi
  for project in "$TMP/x/sessions"/*; do
    [ -d "$project" ] || continue
    for session in "$project"/*; do
      [ -d "$session" ] || continue
      for file in "$session"/*; do
        [ -f "$file" ] || continue
        name="${file##*/}"
        dst="$ROOT/${project##*/}/${session##*/}/$name"
        if [ -f "$dst" ]; then
          # Session logs are append-only, so size is the freshness oracle: an
          # equal-size copy is the same log and must not be rewritten.
          have="$(wc -c < "$dst" | tr -d ' ')"
          want="$(wc -c < "$file" | tr -d ' ')"
          [ "$want" -gt "$have" ] || continue
          say "  ~ 会话 ${session##*/}（$have → $want 字节）"
        else
          say "  + 会话 ${session##*/}"
        fi
        mkdir -p "$ROOT/${project##*/}/${session##*/}" || die "无法创建会话目录"
        if [ -f "$dst" ]; then
          cp "$dst" "$dst$BAK" || die "无法备份：$dst"
        fi
        cp "$file" "$dst" || die "无法写入会话：$dst"
        n=$((n + 1))
      done
    done
  done
  SESSIONS_APPLIED=$n
}

apply_plugins() {
  PLUGINS_APPLIED=0
  [ -d "$TMP/x/_meta/plugins" ] || return 0
  if [ -z "$PROFILE" ]; then
    say "  跳过插件：本机没有找到 DSH profile（会话和技能仍会同步）。"
    return 0
  fi
  modules="$PROFILE/node_modules"
  mkdir -p "$modules" || die "无法创建：$modules"
  for entry in "$TMP/x/_meta/plugins"/*; do
    [ -d "$entry" ] || continue
    case "${entry##*/}" in
      '@'*)
        # A scoped package arrives as `_meta/plugins/@scope/name/...`.
        for scoped in "$entry"/*; do
          [ -d "$scoped" ] || continue
          install_dir "$scoped" "$modules/${entry##*/}/${scoped##*/}"
          say "  + 插件 ${entry##*/}/${scoped##*/}"
          PLUGINS_APPLIED=$((PLUGINS_APPLIED + 1))
        done
        ;;
      *)
        install_dir "$entry" "$modules/${entry##*/}"
        say "  + 插件 ${entry##*/}"
        PLUGINS_APPLIED=$((PLUGINS_APPLIED + 1))
        ;;
    esac
  done
}

apply_skills() {
  SKILLS_APPLIED=0
  [ -d "$TMP/x/_meta/skills" ] || return 0
  skills_root="$HOME_DIR/skills"
  mkdir -p "$skills_root" || die "无法创建：$skills_root"
  for src in "$TMP/x/_meta/skills"/*; do
    [ -e "$src" ] || continue
    name="${src##*/}"
    if [ -d "$src" ]; then
      install_dir "$src" "$skills_root/$name"
      say "  + 技能 $name"
      SKILLS_APPLIED=$((SKILLS_APPLIED + 1))
    elif [ -f "$src" ]; then
      case "$name" in
        *.md) ;;
        *) continue ;;
      esac
      dst="$skills_root/$name"
      same_bytes "$src" "$dst" && continue
      install_file "$src" "$dst"
      say "  + 技能 ${name%.md}"
      SKILLS_APPLIED=$((SKILLS_APPLIED + 1))
    fi
  done
}

apply_index() {
  INDEX_APPLIED=0
  src="$TMP/x/_meta/index.json"
  [ -f "$src" ] || return 0
  dst="$HOME_DIR/storages/workspace.json"
  same_bytes "$src" "$dst" && return 0
  install_file "$src" "$dst"
  say "  ~ 工作区索引已更新"
  INDEX_APPLIED=1
}

apply_profile() {
  PROFILE_APPLIED=0
  src="$TMP/x/_meta/profile/package.json"
  [ -f "$src" ] || return 0
  if [ -z "$PROFILE" ]; then
    say "  跳过 profile 注册：本机没有找到 DSH profile。"
    return 0
  fi
  dst="$PROFILE/package.json"
  same_bytes "$src" "$dst" && return 0
  install_file "$src" "$dst"
  say "  ~ profile 已更新（插件 bundle 已注册）"
  PROFILE_APPLIED=1
}

apply_patch() {
  PATCH_APPLIED=0
  src="$TMP/x/_meta/patch/cordis.patch.yml"
  [ -f "$src" ] || return 0
  if [ -z "$PROFILE" ]; then
    say "  跳过模型配置：本机没有找到 DSH profile。"
    return 0
  fi
  dst="$PROFILE/cordis.patch.yml"
  same_bytes "$src" "$dst" && return 0
  install_file "$src" "$dst"
  say "  ~ cordis.patch.yml 已更新"
  PATCH_APPLIED=1
}

apply_credentials() {
  src="$TMP/x/_meta/patch/credentials.yaml"
  [ -f "$src" ] || return 0
  dst="$HOME_DIR/.credentials.yaml"
  same_bytes "$src" "$dst" && return 0
  install_file "$src" "$dst"
  say "  ~ credentials.yaml 已更新"
}

pull() {
  need_curl
  need_tar
  mkdir -p "$ROOT" || die "无法创建会话目录：$ROOT"
  rm -rf "$TMP/x"
  mkdir -p "$TMP/x" || die "无法创建 $TMP/x"
  say "← 从桌面取回（$BASE）..."
  curl -fsS --max-time 300 -X POST \
    -H "X-DSH-Sync-Token: $TOKEN" \
    -o "$TMP/pull.tgz" \
    "$API/pull?$DEVQ" || die "下载失败"
  if [ ! -s "$TMP/pull.tgz" ]; then say "  桌面没有可下发的内容。"; return 0; fi

  # Refuse an archive that tries to climb out of the extraction root. The
  # desktop never writes such a path; this is the phone's own guard.
  gzip -dc "$TMP/pull.tgz" | $TAR tf - > "$TMP/list" 2>/dev/null || die "压缩包无法读取"
  while IFS= read -r item; do
    case "$item" in
      *..*) die "压缩包里含有不安全的路径：$item" ;;
    esac
  done < "$TMP/list"

  gzip -dc "$TMP/pull.tgz" | $TAR xf - -C "$TMP/x" || die "解包失败"

  SESSIONS_APPLIED=0
  PLUGINS_APPLIED=0
  SKILLS_APPLIED=0
  INDEX_APPLIED=0
  PROFILE_APPLIED=0
  PATCH_APPLIED=0
  apply_sessions
  apply_plugins
  apply_skills
  apply_index
  apply_profile
  apply_patch
  apply_credentials

  say ''
  say "应用：会话 $SESSIONS_APPLIED，插件 $PLUGINS_APPLIED，技能 $SKILLS_APPLIED，索引 $(yesno "$INDEX_APPLIED")，模型 $(yesno "$PATCH_APPLIED")"

  if [ -f "$TMP/x/_meta/readme.txt" ]; then
    say ''
    cat "$TMP/x/_meta/readme.txt"
  fi
  if [ "$PLUGINS_APPLIED" -gt 0 ] || [ "$PROFILE_APPLIED" = "1" ] || [ "$PATCH_APPLIED" = "1" ]; then
    say "提示：插件/配置已更新，重启 DSH 后生效。"
  fi
}

# ---------------------------------------------------------------- status

status() {
  need_curl
  mkdir -p "$TMP"
  say "桌面端：$BASE"
  reply="$(curl -fsS --max-time 8 -H "X-DSH-Sync-Token: $TOKEN" "$API/ping?$DEVQ")" || die "桌面端不可达，请确认电脑和手机在同一局域网。"
  say "  响应：$reply"
  say ''
  say "本机 DSH home：$HOME_DIR"
  say "本机 profile：${PROFILE:-未找到}"
  say "本机会话数：$(count_sessions)"
  say "已装插件数：$(count_plugins)"
  say "已装技能数：$(count_skills)"
  say ''
  say "桌面清单："
  if fetch_manifest; then
    while IFS= read -r line; do
      if [ -n "$line" ]; then say "  $line"; fi
    done < "$TMP/manifest"
  else
    say "  （桌面没有提供 manifest）"
  fi
}

# ---------------------------------------------------------------- self

install_self() {
  target="$SELF_DIR/sync.sh"
  if ! mkdir -p "$SELF_DIR" 2>/dev/null; then
    SELF_DIR="$HOME_DIR/dsh-mobile-sync"
    target="$SELF_DIR/sync.sh"
    mkdir -p "$SELF_DIR" || die "无法创建目录：$SELF_DIR"
  fi
  # A fresh copy from the desktop is preferred: the script is rendered per
  # request, so the installed copy always matches this desktop and this token.
  if curl -fsS --max-time 20 -H "X-DSH-Sync-Token: $TOKEN" "$BASE/join.sh?$DEVQ" -o "$target" 2>/dev/null; then
    chmod +x "$target" 2>/dev/null || true
    say "已安装：$target"
    return 0
  fi
  # Offline (or a desktop too old to re-serve it): keep the file we were run from.
  if [ -f "$0" ]; then
    cp "$0" "$target" || die "无法写入：$target"
    chmod +x "$target" 2>/dev/null || true
    say "已安装：$target"
    return 0
  fi
  say "提示：本机写不进 $target；当前窗口仍可等待同步，但关掉后要重新粘贴命令。"
}

# The core of the new behaviour: pair, then *wait*. A download never transfers
# anything; the desktop panel's 「开始同步」button is what releases this side.
wait_for_sync() {
  install_self
  say ''
  say "桌面端：$BASE"
  say "已配对。等待桌面面板点「开始同步」…（保持这个窗口；Ctrl-C 结束）"
  last="$(cat "$SELF_DIR/last-request" 2>/dev/null || true)"
  misses=0
  while :; do
    reply="$(curl -fsS --max-time 35 -H "X-DSH-Sync-Token: $TOKEN" "$API/await?timeout=25&$DEVQ" 2>/dev/null || true)"
    req="$(printf '%s\n' "$reply" | sed -n 's/^request=//p' | head -n 1 | tr -d '\r')"
    case "$req" in
      ''|0)
        # Desktop unreachable, or nothing armed yet: wait a beat and poll again.
        if [ -z "$req" ]; then
          misses=$((misses + 1))
          if [ "$misses" = "5" ]; then
            say "桌面端暂时不可达，继续重试…（确认电脑上的插件显示「运行中」）"
          fi
        else
          misses=0
        fi
        sleep 2
        continue
        ;;
    esac
    misses=0
    if [ "$req" = "$last" ]; then
      sleep 1
      continue
    fi
    last="$req"
    printf '%s\n' "$req" > "$SELF_DIR/last-request" 2>/dev/null || true
    say ''
    say "收到同步指令（$req），开始上传…"
    if ( push ); then :; else
      say "  上传失败，本次跳过；等下一次「开始同步」。"
      sleep 2
      continue
    fi
    say "开始下载…"
    if ( pull ); then :; else
      say "  下载失败，本次跳过；等下一次「开始同步」。"
      sleep 2
      continue
    fi
    curl -fsS --max-time 10 -X POST -H "X-DSH-Sync-Token: $TOKEN" \
      "$API/done?request=$req&$DEVQ" >/dev/null 2>&1 || true
    say ''
    say "本次同步完成。继续等待下一次「开始同步」…"
  done
}

watch() {
  install_self
  say "后台等待「开始同步」（日志 $SELF_DIR/sync.log）"
  (
    sh "$SELF_DIR/sync.sh" wait >> "$SELF_DIR/sync.log" 2>&1
  ) &
  say "已启动，PID $!"
}

# ---------------------------------------------------------------- main

# Escape the characters that would break the request line or the query parse.
# Everything else — including UTF-8 model names — travels as raw bytes, which
# both curl and Node's URL parser accept.
escape_query() {
  printf '%s' "$1" | tr -d '\r\n' | sed \
    -e 's/%/%25/g' \
    -e 's/ /%20/g' \
    -e 's/&/%26/g' \
    -e 's/#/%23/g' \
    -e 's/?/%3F/g' \
    -e 's/+/%2B/g' \
    -e 's/=/%3D/g'
}

DEVICE="$(detect_device)"
DEVQ="device=$(escape_query "$DEVICE")"
mkdir -p "$TMP" || die "无法创建临时目录：$TMP"

MANAGED_HOME="$(find_home || true)"
if [ -n "$MANAGED_HOME" ]; then
  HOME_DIR="$MANAGED_HOME"
else
  HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
fi
ROOT="$HOME_DIR/sessions"
PROFILE="$(find_profile "$HOME_DIR" || true)"
if [ -n "$PROFILE" ]; then PROFILE_NAME="${PROFILE##*/}"; fi
META_DIR="$ROOT/_meta"

case "$MODE" in
  push) push ;;
  pull) pull ;;
  status) status ;;
  install) install_self ;;
  pair|wait) wait_for_sync ;;
  watch|auto) watch ;;
  both|sync) ping; push; pull ;;
  *)
    say "用法: sh $0 [pair|wait|watch|both|push|pull|status|install]"
    exit 2
    ;;
esac

if [ "$MODE" = "both" ] || [ "$MODE" = "sync" ]; then
  say ''
  say "提示：不带参数运行是 pair 模式——配对后等桌面面板点「开始同步」，不会一上来就同步。"
fi
