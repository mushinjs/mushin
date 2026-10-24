// A local demo: a Mushin.js instance wired to a mock NapCat and a mock OpenAI-compatible LLM,
// seeded with a provider, two bots, a flow, chat traffic and one Agent conversation.
// Run: pnpm --filter @mushin/cli exec tsx tests/helpers/demo.ts  (then open http://127.0.0.1:5160, token "demo")
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../../src/start'
import { createMockNapCat } from './mock-napcat'
import { createMockOpenAI } from './mock-openai'

const port = Number(process.env.PORT ?? 5160)
process.env.MUSHIN_ADMIN_TOKEN = process.env.MUSHIN_ADMIN_TOKEN ?? 'demo'

const llm = await createMockOpenAI()
llm.setFallback({ text: 'Sunny and 22°C today. A good day to go outside!' })
const napcat = await createMockNapCat({ token: 'napcat', nickname: 'Mushin Bot' })
const baseDir = await mkdtemp(join(tmpdir(), 'mushin-demo-'))
const { ctx } = await start({ baseDir, port })

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
while (!ctx.manager.entries.every((entry) => ctx.manager.status(entry.id).status === 'active')) await wait(50)
const call = (name: string, input: unknown = {}) => ctx.actions.call(name, input) as Promise<any>

const provider = await call('providers.create', {
  name: 'DeepSeek',
  type: 'openai',
  config: { baseURL: llm.baseURL, apiKey: 'sk-demo-0123456789abcdef' },
  models: ['deepseek-chat', 'deepseek-reasoner'],
})
await call('providers.test', { id: provider.id })

const alpha = await call('bots.create', {
  name: 'Alpha',
  adapter: { type: 'onebot', config: { mode: 'forward', url: napcat.url, token: 'napcat' } },
  plugins: [{ package: '@mushin/bot-plugin-echo' }, { package: '@mushin/bot-plugin-llm-chat' }],
})
await call('bots.create', { name: 'Beta', adapter: { type: 'onebot', config: { mode: 'reverse', token: 'secret' } } })
while ((await call('bots.get', { id: alpha.id })).status !== 'online') await wait(50)

await call('flows.create', {
  name: 'Greeter',
  description: 'Greets people who say hello and counts visitors, at most once every 10 seconds per chat.',
  bots: [alpha.id],
  nodes: [
    { id: 'hello', type: 'trigger.keyword', config: { keywords: ['hello', 'hi there'], mode: 'startsWith' } },
    { id: 'cooldown', type: 'logic.cooldown', config: { seconds: 10, scope: 'chat' } },
    { id: 'count', type: 'data.increment', label: 'Visitor count', config: { name: 'visitors', scope: 'flow' } },
    { id: 'reply', type: 'action.reply', config: { text: 'Hi {{sys.user}}! You are visitor #{{count.value}} today.' } },
    { id: 'slow', type: 'action.reply', label: 'Slow down', config: { text: 'One moment, {{sys.user}}…' } },
  ],
  edges: [
    { source: 'hello', sourceHandle: 'exec:next', target: 'cooldown', targetHandle: 'exec' },
    { source: 'cooldown', sourceHandle: 'exec:ready', target: 'count', targetHandle: 'exec' },
    { source: 'cooldown', sourceHandle: 'exec:cooling', target: 'slow', targetHandle: 'exec' },
    { source: 'count', sourceHandle: 'exec:next', target: 'reply', targetHandle: 'exec' },
  ],
})

napcat.pushGroupMessage('500', '42', [{ type: 'text', data: { text: 'echo hello, Mushin!' } }])
await wait(300)
napcat.pushGroupMessage('500', '43', [{ type: 'text', data: { text: 'nice' } }])
await wait(300)
napcat.pushGroupMessage('500', '44', [{ type: 'text', data: { text: 'hello everyone!' } }])
await wait(300)
napcat.pushGroupMessage('500', '43', [{ type: 'at', data: { qq: napcat.selfId } }, { type: 'text', data: { text: ' what is the weather like?' } }])
await wait(500)
napcat.pushPrivateMessage('42', [{ type: 'text', data: { text: 'Can you recommend a book?' } }])
await wait(500)

llm.enqueue(
  { toolCalls: [{ name: 'bots__list', arguments: {} }] },
  { text: 'You have 2 bots. Alpha is online with Echo and LLM chat enabled. Beta is waiting for NapCat to connect in reverse mode.' },
)
await call('agent.send', { text: 'Which bots do I have, and are they online?' })

console.log(`Mushin.js demo running at http://127.0.0.1:${port} (admin token: ${process.env.MUSHIN_ADMIN_TOKEN})`)
console.log(`Mock LLM: POST scripted replies to ${llm.baseURL.replace(/\/v1$/, '')}/__enqueue`)

let tick = 0
setInterval(() => {
  tick++
  napcat.pushGroupMessage('500', String(40 + (tick % 4)), [{ type: 'text', data: { text: `echo live message #${tick}` } }])
}, 45_000)
