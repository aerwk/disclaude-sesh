# Troubleshooting

**Quick links:** [Installation](installation.md) · [Security](security.md) · [← back to README](../README.md)

| Symptom | Fix |
|---|---|
| Supervisor never comes online | `journalctl --user -u claude-supervisor -f`; commonest cause is the **Message Content intent** not enabled in the Developer Portal, or a missing/typo'd token in `~/.config/claude-ops.env` |
| Bot never replies in the channel | The channel isn't enabled in `~/.claude/channels/discord/access.json` (`groups` entry with your channel ID, `requireMention: false`) — see [`examples/access.json.example`](../examples/access.json.example) |
| `!stop` doesn't stick / session won't die | Stop goes through `tmux kill-session -t claudeops`, which also kills the restart loop; if tmux lingers, kill it by hand once and check `ExecStop` ran |
| Buttons still arrive as DMs after enabling the patch | The patch applies at next launch — `!restart` (or `systemctl --user restart claude-ops`), then check `~/.local/state/claude-ops-repatch.log` |
| ⚠️ repatch alert in Discord | Upstream rewrote the handler; you're safely on stock DM behaviour — see [channel-buttons-patch.md](channel-buttons-patch.md) for the re-patch path |
| `claude` exits every 10s inside tmux | Not logged in (`claude` needs its one-time auth) or the workspace folder-trust prompt is waiting — `tmux attach -t claudeops` and answer it once |
| Nothing runs after a reboot | `loginctl enable-linger $USER` was never run — user units only start at boot with linger enabled |

Still stuck? [Open an issue](https://github.com/aerwk/disclaude-sesh/issues) with the relevant `journalctl` lines (mind your tokens).
