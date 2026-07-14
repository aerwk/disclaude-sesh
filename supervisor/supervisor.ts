#!/usr/bin/env bun
// Claude Ops Supervisor — start/end Claude Code sessions from Discord.
// Deliberately dumb: four fixed verbs mapped to systemd, a single-user
// allowlist, no shell passthrough. Everything conversational goes to the
// separate Claude Ops bot (official discord channel plugin), not this one.
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'

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

async function sysctl(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['systemctl', '--user', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return (out + err).trim()
}

async function status(): Promise<string> {
  const active = await sysctl('is-active', UNIT)
  const since = await sysctl('show', UNIT, '--property=ActiveEnterTimestamp', '--value')
  const tmuxAlive = Bun.spawnSync(['tmux', 'has-session', '-t', TMUX_SESSION]).exitCode === 0
  return [
    `service: **${active}**${active === 'active' && since ? ` (since ${since})` : ''}`,
    `tmux session: ${tmuxAlive ? 'alive ✅' : 'not running ⛔'}`,
  ].join('\n')
}

const HELP = 'Commands: `!start` `!stop` `!restart` (fresh context) `!status` `!help`'

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
  const cmd = /^!(start|stop|restart|status|help)\b/.exec(msg.content.trim())?.[1]
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
