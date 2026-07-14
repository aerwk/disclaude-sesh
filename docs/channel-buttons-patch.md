# Channel permission buttons (optional patch)

**Quick links:** [Enabling it](#enabling-it) · [Disabling it](#disabling-it) · [← back to README](../README.md)

## The problem

When the Claude Code session wants to run a tool that needs approval, the
official Discord plugin sends the **Allow/Deny buttons to your DMs only** —
that's a deliberate upstream design. If you run your ops conversation in a
server channel, this splits the flow across two places: the conversation in
the channel, the approvals in your DMs.

## What the patch does

A small block is inserted into the plugin's `server.ts`
(`~/.claude/plugins/cache/claude-plugins-official/discord/<version>/server.ts`):
permission prompts are posted to group channels whose trigger allowlist is
non-empty **and** a subset of the paired allowlist, falling back to DMs
otherwise.

This is safe because the plugin's button-click handler independently rejects
anyone not in `access.allowFrom` — channel *visibility* never grants
*approval power*. The worst case for a misconfigured group is that untrusted
channel members can see the prompt text, which is why the patch refuses to
post to any channel whose `allowFrom` isn't a strict subset of the paired
users.

## Enabling it

1. In `~/.config/claude-ops.env`, set:

   ```ini
   CLAUDE_OPS_CHANNEL_BUTTONS=1
   OPS_CHANNEL_ID=your-ops-channel-id
   ```

2. Restart the session: `systemctl --user restart claude-ops` (or `!restart`
   from Discord).

The launcher runs `bin/claude-ops-repatch.sh` before every Claude start, so
the patch is applied on the next launch — no manual file editing.

## How the repatcher keeps it alive

Plugin updates install a fresh, unpatched `server.ts` under a new version
directory, which would silently revert you to DM behaviour. On every launch
(including crash-restarts) the repatcher:

1. Finds the **newest** version dir in the plugin cache (that's what the
   plugin host runs).
2. If the patch marker is already present → exits quietly (the common case).
3. Otherwise: backs up the stock file to `server.ts.pristine`, inserts the
   patch block at a known anchor, and verifies the result still transpiles as
   TypeScript (`Bun.Transpiler`, syntax only).
4. **On success:** posts a one-line 🔧 notice to `OPS_CHANNEL_ID`.
5. **On any failure** (anchor gone because upstream rewrote the handler,
   transpile error): restores the pristine file — stock DM behaviour, still
   fully functional — posts a ⚠️ alert naming the reason, and exits 1. It
   never guesses and never blocks the session from starting.

Log: `~/.local/state/claude-ops-repatch.log`.

## If the ⚠️ alert fires

Upstream changed the permission handler and the anchor no longer matches.
You keep working stock behaviour (buttons in DMs) until the patch is updated:

1. Diff the new `server.ts` against `server.ts.pristine` from the previous
   version to see what moved.
2. Update `ANCHOR` and/or the `PATCH` block in `bin/claude-ops-repatch.sh`
   to match the new code.
3. Re-run `bin/claude-ops-repatch.sh` and check the log.

## Disabling it

Set `CLAUDE_OPS_CHANNEL_BUTTONS=0` (or remove the line), then restore the
stock file and restart:

```bash
cache=~/.claude/plugins/cache/claude-plugins-official/discord
ver=$(ls -1v "$cache" | tail -1)
cp "$cache/$ver/server.ts.pristine" "$cache/$ver/server.ts"
systemctl --user restart claude-ops
```
