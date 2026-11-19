import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from '@mushinjs/core'
import { CALL_TOOL, MAX_TOOLS, SEARCH_TOOL } from '@mushinjs/plugin-agent'
import { chatModelsFirst } from '@mushinjs/plugin-providers'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
const calls: number[] = []

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
  // More tools than a request may carry.
  for (let i = 0; i < 150; i++) {
    app.ctx.actions.define({
      name: `zfiller.tool${i}`,
      description: i === 149 ? 'Counts lighthouses on the coast.' : `Filler tool number ${i}.`,
      risk: 'read',
      input: z.object({ n: z.number().optional() }),
      handler: ({ n }) => {
        calls.push(n ?? -1)
        return { ok: true }
      },
    })
  }
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('agent tools', () => {
  it('lists at most 128 tools, core ones first, and reaches the rest through search and call', async () => {
    const tools = await app.ctx.agent.tools()
    expect(tools.length).toBe(MAX_TOOLS)
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['bots__list', 'flows__create', 'providers__list', SEARCH_TOOL, CALL_TOOL]))
    expect(names).not.toContain('zfiller__tool149')

    llm.enqueue({ toolCalls: [{ name: SEARCH_TOOL, arguments: { query: 'lighthouses' } }] })
    llm.enqueue({ toolCalls: [{ name: CALL_TOOL, arguments: { name: 'zfiller__tool149', input: { n: 7 } } }] })
    llm.enqueue({ text: 'Done.' })
    const { session } = await app.call('agent.send', { text: 'Count the lighthouses' })
    await waitFor(async () => !(await app.call('agent.session', { id: session })).running || undefined)
    const request = llm.requests.at(-3)
    expect(request.tools.length).toBeLessThanOrEqual(MAX_TOOLS)
    const found = llm.requests.at(-2).messages.at(-1).content as string
    expect(found).toContain('zfiller__tool149')
    expect(calls).toEqual([7])
  })

  it('puts models that answer chat first, so the default is one of them', () => {
    expect(chatModelsFirst(['gpt-5-chat-latest', 'text-embedding-3-small', 'gpt-5.1', 'whisper-1', 'gpt-5-mini'])).toEqual(['gpt-5.1', 'gpt-5-mini', 'gpt-5-chat-latest', 'text-embedding-3-small', 'whisper-1'])
  })
})
