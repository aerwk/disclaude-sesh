#!/usr/bin/env bash
# claude-ops-repatch.sh — keeps the optional channel-buttons patch alive
# across Discord plugin updates. Run by claude-ops.sh before every claude
# launch. Does nothing unless CLAUDE_OPS_CHANNEL_BUTTONS=1 in
# ~/.config/claude-ops.env.
#
# The patch (see docs/channel-buttons-patch.md) makes permission prompts post
# to the paired group channel instead of DMs. A plugin update installs a
# fresh version dir with an unpatched server.ts, silently reverting to DM
# behaviour — this script detects that and re-applies the patch to the newest
# version, or alerts Discord if the upstream code changed too much to patch
# safely.
#
# Exit codes: 0 = patched, already patched, or patch not enabled;
# 1 = could not patch (stock DM behaviour retained; the launcher continues).
#
# Test overrides: CACHE_DIR, NOTIFY_CMD (replaces the Discord curl; message
# passed on stdin), SKIP_TRANSPILE_CHECK=1.
set -u
ENV_FILE="$HOME/.config/claude-ops.env"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

[ "${CLAUDE_OPS_CHANNEL_BUTTONS:-0}" = "1" ] || exit 0

CACHE_DIR="${CACHE_DIR:-$HOME/.claude/plugins/cache/claude-plugins-official/discord}"
MARKER='LOCAL PATCH (claude-ops channel-buttons'
ANCHOR='for (const userId of access.allowFrom) {'
LOG="$HOME/.local/state/claude-ops-repatch.log"
BUN="$HOME/.bun/bin/bun"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

notify() { # $1 = message; best-effort, never fatal
  if [ -n "${NOTIFY_CMD:-}" ]; then printf '%s' "$1" | $NOTIFY_CMD; return; fi
  [ -n "${SUPERVISOR_BOT_TOKEN:-}" ] || { log "notify skipped: no SUPERVISOR_BOT_TOKEN"; return; }
  [ -n "${OPS_CHANNEL_ID:-}" ] || { log "notify skipped: no OPS_CHANNEL_ID"; return; }
  curl -sf -m 15 -X POST \
    "https://discord.com/api/v10/channels/$OPS_CHANNEL_ID/messages" \
    -H "Authorization: Bot $SUPERVISOR_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1]}))' "$1")" \
    >/dev/null 2>>"$LOG" || log "notify: Discord POST failed"
}

# Newest version dir = what the plugin host will run.
ver=$(ls -1v "$CACHE_DIR" 2>/dev/null | tail -1)
[ -n "$ver" ] || { log "no plugin versions found in $CACHE_DIR"; exit 1; }
ts="$CACHE_DIR/$ver/server.ts"
[ -f "$ts" ] || { log "no server.ts in $ver"; exit 1; }

if grep -qF "$MARKER" "$ts"; then
  exit 0  # already patched — the common case, stay quiet
fi

log "unpatched server.ts detected in v$ver — attempting re-patch"
pristine="$ts.pristine"
[ -f "$pristine" ] || cp "$ts" "$pristine"

fail() { # $1 = reason — restore stock file, alert, bail
  cp "$pristine" "$ts"
  log "PATCH FAILED (v$ver): $1 — pristine restored, DM behaviour active"
  notify "⚠️ **claude-ops**: Discord plugin updated to v$ver and the channel-buttons patch could NOT be re-applied ($1). Permission prompts will arrive as **DMs** until it's re-patched by hand. See docs/channel-buttons-patch.md."
  exit 1
}

grep -qF "$ANCHOR" "$ts" || fail "anchor line not found (upstream rewrote the permission handler)"
grep -qF '🔐 Permission' "$ts" || fail "permission-request handler not found"

python3 - "$ts" <<'PYEOF' || fail "insertion script errored"
import sys

PATCH = '''    // LOCAL PATCH (claude-ops channel-buttons): prefer posting permission
    // prompts to group channels whose trigger allowlist is restricted to
    // already-paired users, falling back to DMs otherwise. Verdicts stay
    // safe: the interactionCreate handler rejects clicks from anyone not in
    // access.allowFrom, so channel visibility doesn't grant approval power.
    let sentToChannel = false
    for (const [channelId, policy] of Object.entries(access.groups)) {
      const g = policy.allowFrom ?? []
      if (g.length === 0 || !g.every(id => access.allowFrom.includes(id))) continue
      try {
        const ch = await client.channels.fetch(channelId)
        if (ch && ch.isSendable()) {
          await ch.send({ content: text, components: [row] })
          sentToChannel = true
        }
      } catch (e) {
        process.stderr.write(`permission_request send to channel ${channelId} failed: ${e}\\n`)
      }
    }
    if (sentToChannel) return
'''

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
emoji_at = src.find("\U0001F510 Permission")
if emoji_at < 0:
    sys.exit(1)
anchor = "    for (const userId of access.allowFrom) {"
at = src.find(anchor, emoji_at)
if at < 0:
    sys.exit(1)
open(path, "w", encoding="utf-8").write(src[:at] + PATCH + src[at:])
PYEOF

grep -qF "$MARKER" "$ts" || fail "patch text missing after insertion"

if [ -z "${SKIP_TRANSPILE_CHECK:-}" ] && [ -x "$BUN" ]; then
  "$BUN" -e 'const t = new Bun.Transpiler({ loader: "ts" }); t.transformSync(await Bun.file(Bun.argv[1]).text());' "$ts" \
    2>>"$LOG" || fail "patched file failed TypeScript transpile check"
fi

log "patch re-applied to v$ver OK"
notify "🔧 **claude-ops**: Discord plugin updated to v$ver — channel-buttons patch re-applied automatically. Pristine copy kept at server.ts.pristine."
exit 0
