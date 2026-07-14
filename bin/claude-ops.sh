#!/usr/bin/env bash
# claude-ops.sh — runs the Discord-bridged Claude Code ops session.
# Started/stopped via the claude-ops systemd user unit (inside tmux).
# The loop restarts claude after a crash; a deliberate `systemctl --user stop
# claude-ops` kills the whole tmux session, loop included, so stop sticks.
#
# Configuration comes from ~/.config/claude-ops.env (see
# examples/claude-ops.env.example):
#   CLAUDE_OPS_WORKSPACE        session working directory
#                               (default: <repo>/workspace)
#   CLAUDE_OPS_SKIP_PERMISSIONS 1 = run with --dangerously-skip-permissions
#                               (read "Permission modes" in the README first)
#   CLAUDE_OPS_CHANNEL_BUTTONS  1 = keep the channel-buttons patch applied
#                               (see docs/channel-buttons-patch.md)
set -u
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

ENV_FILE="$HOME/.config/claude-ops.env"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${CLAUDE_OPS_WORKSPACE:-$REPO_DIR/workspace}"
cd "$WORKSPACE" || exit 1

CLAUDE_ARGS=(--channels plugin:discord@claude-plugins-official)
if [ "${CLAUDE_OPS_SKIP_PERMISSIONS:-0}" = "1" ]; then
  CLAUDE_ARGS=(--dangerously-skip-permissions "${CLAUDE_ARGS[@]}")
fi

while true; do
  # Re-apply the channel-buttons patch if a plugin update replaced server.ts.
  # No-op unless CLAUDE_OPS_CHANNEL_BUTTONS=1; alerts Discord if it can't
  # patch. Never blocks the session.
  "$REPO_DIR/bin/claude-ops-repatch.sh" || true
  claude "${CLAUDE_ARGS[@]}"
  echo "claude exited $(date) — restarting in 10s (Ctrl-C or systemctl stop to end)"
  sleep 10
done
