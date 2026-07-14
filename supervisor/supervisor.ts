#!/usr/bin/env bun
// Claude Ops Supervisor — start/end Claude Code sessions from Discord.
// Deliberately dumb: fixed verbs mapped to systemd/tmux, a single-user
// allowlist, no shell passthrough. Everything conversational goes to the
// separate Claude Ops bot (official discord channel plugin), not this one.
//
// The session commands (!usage !context !save !resume !handoff) talk to the
// running session through tmux. They only ever inject FIXED strings (plus
// supervisor-computed file paths) — user message content is never forwarded.
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import { readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = process.env.SUPERVISOR_BOT_TOKEN
const ALLOWED = (process.env.ALLOWED_USER_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
if (!TOKEN || ALLOWED.length === 0) {
  console.error(
    'SUPERVISOR_BOT_TOKEN and ALLOWED_USER_IDS must be set (see ~/.config/claude-ops.env)',
  )
  process.exit(1)
}

const UNIT = 'claude-ops'
const TMUX_SESSION = 'claudeops'
const HOME = process.env.HOME ?? '~'
// !save writes here; !resume reads the newest file from here.
const SAVE_DIR = process.env.CLAUDE_OPS_SAVE_DIR ?? join(HOME, '.claude', 'session-data', 'disclaude')
// !handoff writes here — the default place a terminal /resume-session looks.
const HANDOFF_DIR = process.env.CLAUDE_OPS_HANDOFF_DIR ?? join(HOME, '.claude', 'session-data')

async function run(cmd: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, text: (out + err).trim() }
}

const sysctl = (...args: string[]) => run(['systemctl', '--user', ...args]).then(r => r.text)

const tmuxAlive = () => Bun.spawnSync(['tmux', 'has-session', '-t', TMUX_SESSION]).exitCode === 0

// Type a line into the session's composer. Literal mode + array args: nothing
// is shell-interpreted, and the text must be a single line.
async function tmuxType(line: string): Promise<void> {
  await run(['tmux', 'send-keys', '-t', TMUX_SESSION, '-l', line.replace(/\s*\n\s*/g, ' ')])
  await run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'])
}

const tmuxKey = (key: string) => run(['tmux', 'send-keys', '-t', TMUX_SESSION, key])

async function capture(scrollback = 0): Promise<string[]> {
  const args = ['tmux', 'capture-pane', '-t', TMUX_SESSION, '-p']
  if (scrollback > 0) args.push('-S', `-${scrollback}`)
  const { text } = await run(args)
  return text
    .replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI colors
    .split('\n')
    .map(l => l.trimEnd())
}

// If the terminal is showing a blocking dialog (trust prompt, permission
// prompt, open modal) or is mid-response, injected keystrokes would land in
// the wrong place — refuse and say why.
async function paneBlocked(): Promise<string | null> {
  const txt = (await capture()).join('\n')
  if (/Enter to confirm/i.test(txt) || /Do you want/i.test(txt) || /trust this folder/i.test(txt))
    return 'a dialog is open in the terminal (trust/permission prompt?) — it needs a human: `tmux attach -t ' + TMUX_SESSION + '`'
  if (/Esc to cancel/i.test(txt))
    return 'a modal panel is open in the terminal — close it first: `tmux attach -t ' + TMUX_SESSION + '`'
  if (/esc to interrupt/i.test(txt))
    return 'the session is mid-task right now — try again when it goes quiet'
  return null
}

const statusLine = (lines: string[]) =>
  lines.find(l => /% used/.test(l))?.trim() ?? null

function clip(lines: string[], max = 1800): string {
  let out = ''
  for (const l of lines) {
    if (out.length + l.length + 1 > max) break
    out += l + '\n'
  }
  return out.trimEnd().replace(/```/g, "'''")
}

async function status(): Promise<string> {
  const active = await sysctl('is-active', UNIT)
  const since = await sysctl('show', UNIT, '--property=ActiveEnterTimestamp', '--value')
  const alive = tmuxAlive()
  const rows = [
    `service: **${active}**${active === 'active' && since ? ` (since ${since})` : ''}`,
    `tmux session: ${alive ? 'alive ✅' : 'not running ⛔'}`,
  ]
  if (alive) {
    const blocked = await paneBlocked()
    if (blocked && !/mid-task/.test(blocked)) rows.push(`⚠️ session is NOT taking messages: ${blocked}`)
    const sl = statusLine(await capture())
    if (sl) rows.push(`statusline: \`${sl}\``)
  }
  return rows.join('\n')
}

// Session-facing commands need the session up and its composer reachable.
async function requireComposer(msg: Message): Promise<boolean> {
  if (!tmuxAlive()) {
    await msg.reply('⛔ no running session — `!start` first')
    return false
  }
  const blocked = await paneBlocked()
  if (blocked) {
    await msg.reply(`⚠️ can't reach the composer: ${blocked}`)
    return false
  }
  return true
}

// The default detached pane (80x24) is too short for the /usage panel — grow
// it so the session/week bars are on screen. Attaching later re-sizes to the
// client, so this is safe to leave. Best-effort on older tmux.
const ensurePaneSize = () =>
  run(['tmux', 'resize-window', '-t', TMUX_SESSION, '-x', '100', '-y', '55']).catch(() => {})

async function usage(msg: Message): Promise<void> {
  if (!(await requireComposer(msg))) return
  await ensurePaneSize()
  await tmuxType('/usage')
  await Bun.sleep(4000)
  const lines = await capture()
  const keep = lines
    .filter(l => /%/.test(l) || /session|week|resets|credits/i.test(l))
    .filter(l => !/Esc to cancel|d to day|Settings\s+Status/i.test(l))
    .map(l => l.replace(/[█▌▏▎▍▋▊▉]+\s*/g, '').trim())
    .filter(Boolean)
  await tmuxKey('Escape') // close the modal so the composer is free again
  await Bun.sleep(600)
  const sl = statusLine(await capture())
  const body = clip(keep.length ? keep : lines.slice(-25))
  await msg.reply('```\n' + body + '\n```' + (sl ? `\n\`${sl.trim()}\`` : ''))
}

async function context(msg: Message): Promise<void> {
  if (!(await requireComposer(msg))) return
  await ensurePaneSize()
  await tmuxType('/context')
  await Bun.sleep(4000)
  const lines = await capture(400)
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].includes('Context Usage')) { start = i; break }
  const block = start >= 0 ? lines.slice(start) : lines.slice(-40)
  let end = Math.min(block.length, 30)
  for (let i = 3; i < block.length; i++)
    if (/MCP tools|· \/mcp/.test(block[i])) { end = i; break }
  const cleaned = block.slice(0, end)
    .map(l => l.replace(/[⛁⛀⛶]/g, '').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
  await msg.reply('```\n' + clip(cleaned) + '\n```')
}

function newestSave(): string | null {
  try {
    const files = readdirSync(SAVE_DIR)
      .filter(f => f.endsWith('-session.tmp'))
      .map(f => ({ f, t: statSync(join(SAVE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return files[0] ? join(SAVE_DIR, files[0].f) : null
  } catch {
    return null
  }
}

async function save(msg: Message, dir: string, label: string): Promise<void> {
  if (!(await requireComposer(msg))) return
  mkdirSync(dir, { recursive: true })
  await tmuxType(
    `Run /save-session now, but write the session file into ${dir} (keep the usual ` +
    `YYYY-MM-DD-<short-id>-session.tmp naming; create the folder if needed). If the ` +
    `/save-session skill is not installed, write an equivalent comprehensive ` +
    `session-state file there instead. When the file is written, confirm in the ` +
    `Discord channel with id ${msg.channelId} via the discord reply tool, quoting ` +
    `the full file path.`,
  )
  await msg.reply(`📝 asked the session to ${label} — it will confirm here with the file path when done`)
}

async function resume(msg: Message): Promise<void> {
  const file = newestSave()
  if (!file) {
    await msg.reply(`⛔ no saved sessions in \`${SAVE_DIR}\` — use \`!save\` first`)
    return
  }
  if (!(await requireComposer(msg))) return
  await tmuxType(
    `Run /resume-session with the file ${file} — read it fully and load its state. ` +
    `If the /resume-session skill is not installed, read the file and continue ` +
    `exactly where it left off. Then confirm in the Discord channel with id ` +
    `${msg.channelId} via the discord reply tool, summarizing the loaded state and ` +
    `the next step.`,
  )
  await msg.reply(`⏪ asked the session to resume \`${file.split('/').pop()}\` — briefing will arrive here (tip: \`!restart\` first for a clean context)`)
}

const HELP = [
  '`!start` `!stop` `!restart` (fresh context) `!status` — session control',
  '`!usage` — plan usage + time left · `!context` — context window used',
  '`!save` — save session state to the disclaude folder · `!resume` — load the latest one',
  '`!handoff` — save to the default session folder, so a terminal `/resume-session` picks it up',
].join('\n')

async function handle(cmd: string, msg: Message): Promise<void> {
  switch (cmd) {
    case 'start':
      await sysctl('start', UNIT)
      await msg.reply(`▶️ start requested\n${await status()}`)
      break
    case 'stop':
      await sysctl('stop', UNIT)
      await msg.reply(`⏹️ stopped\n${await status()}`)
      break
    case 'restart':
      await sysctl('restart', UNIT)
      await msg.reply(`🔄 restarted — fresh session, old context gone\n${await status()}`)
      break
    case 'status':
      await msg.reply(await status())
      break
    case 'usage':
      await usage(msg)
      break
    case 'context':
      await context(msg)
      break
    case 'save':
      await save(msg, SAVE_DIR, 'save to the disclaude folder')
      break
    case 'handoff':
      await save(msg, HANDOFF_DIR, 'save a terminal handoff')
      break
    case 'resume':
      await resume(msg)
      break
    case 'help':
      await msg.reply(HELP)
      break
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel], // required to receive DMs
})

client.on('messageCreate', async msg => {
  if (msg.author.bot) return
  if (!ALLOWED.includes(msg.author.id)) return // silently drop strangers
  const cmd = /^!(start|stop|restart|status|usage|context|save|resume|handoff|help)\b/.exec(
    msg.content.trim(),
  )?.[1]
  if (!cmd) return
  try {
    await handle(cmd, msg)
  } catch (e) {
    await msg.reply(`⚠️ error: ${e}`).catch(() => {})
  }
})

client.once('clientReady', () => {
  console.log(`supervisor ready as ${client.user?.tag}, unit=${UNIT}, allowed=${ALLOWED.join(',')}`)
})

await client.login(TOKEN)
