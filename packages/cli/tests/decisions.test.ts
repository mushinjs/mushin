import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DecisionRequest } from '@mushin/plugin-providers'
import { z } from '@mushin/core'
import { startInstance, type TestInstance } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
const decisions: DecisionRequest[] = []

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  app.ctx.llm.defineType({
    id: 'fake-decision',
    displayName: 'Fake decisions',
    config: z.object({}),
    capabilities: ['decision'],
    create: () => ({
      chat: () => Promise.reject(new Error('cannot chat')),
      decide: async (request) => {
        decisions.push(request)
        return { answers: { ok: { type: 'noul', noul: 0.97 } }, usage: { inputTokens: 12, outputTokens: 1 } }
      },
    }),
  })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('decision providers', () => {
  let decider: string
  let chat: string

  it('do not become the default chat provider', async () => {
    // Created first, it would have become the default before decision providers existed.
    decider = (await app.call('providers.create', { name: 'Decider', type: 'fake-decision', config: {}, models: ['jev-latest'] })).id
    chat = (await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })).id
    const { providers } = await app.call('providers.list')
    expect(providers.find((item: any) => item.id === decider)).toMatchObject({ capabilities: ['decision'] })
    expect(providers.find((item: any) => item.id === chat)).toMatchObject({ isDefault: true, capabilities: ['chat'] })
    expect(await app.call('providers.choices')).not.toContainEqual(expect.objectContaining({ value: decider }))
    expect(await app.call('providers.decideChoices')).toEqual([{ value: decider, label: 'Decider' }])
  })

  it('are skipped for chat even when marked default', async () => {
    await app.call('providers.setDefault', { id: decider })
    const result = await app.ctx.llm.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(result.provider).toBe(chat)
    await expect(app.ctx.llm.chat({ provider: decider, messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(app.call('providers.createProfile', { name: 'Bad', models: [{ provider: decider, model: 'x' }] })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('answer providers.decide through the default decision provider', async () => {
    const result = await app.call('providers.decide', {
      state: 'The user says thanks.',
      questions: { ok: { type: 'noul', instructions: 'Is the user happy?' } },
    })
    expect(result).toMatchObject({ provider: decider, model: 'jev-latest', answers: { ok: { type: 'noul', noul: 0.97 } }, usage: { inputTokens: 12, outputTokens: 1 } })
    expect(decisions.at(-1)).toMatchObject({ model: 'jev-latest', state: 'The user says thanks.' })
    await expect(app.call('providers.decide', { provider: chat, state: 'x', questions: { ok: { type: 'noul' } } })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('are tested with a true-or-false question', async () => {
    const test = await app.call('providers.test', { id: decider })
    expect(test).toMatchObject({ ok: true, model: 'jev-latest' })
    expect(decisions.at(-1)?.questions).toEqual({ ok: { type: 'noul', instructions: 'Is the statement true?' } })
    // Only chat providers make the Agent ready.
    expect((await app.call('providers.list')).ready).toBe(false)
  })
})
