import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let working: string
let broken: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  working = (await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })).id
  // Nothing listens on port 9, so every request to it fails.
  broken = (await app.call('providers.create', { name: 'Down', type: 'openai', config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-1234567890' }, models: ['down-model'] })).id
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

describe('model profiles', () => {
  it('lists a profile with the providers and as a choice', async () => {
    const profile = await app.call('providers.createProfile', { name: 'Chat', models: [{ provider: working, model: 'mock-model' }] })
    const list = await app.call('providers.list')
    expect(list.profiles).toEqual([profile])
    expect(await app.call('providers.choices')).toContainEqual({ value: profile.id, label: 'Chat', group: 'profiles' })
    await app.call('providers.deleteProfile', { id: profile.id })
  })

  it('refuses a model on a provider that does not exist', async () => {
    await expect(app.call('providers.createProfile', { name: 'Bad', models: [{ provider: 'nope', model: 'x' }] })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('falls back to the next model when one fails', async () => {
    const profile = await app.call('providers.createProfile', {
      name: 'With fallback',
      models: [{ provider: broken, model: 'down-model' }, { provider: working, model: 'typed-by-hand' }],
    })
    const result = await app.ctx.llm.chat({ provider: profile.id, model: 'ignored', messages: [{ role: 'user', content: 'hi' }] })
    expect(result).toMatchObject({ text: 'Hi from LLM', provider: working, model: 'typed-by-hand' })
    expect(llm.requests.at(-1).model).toBe('typed-by-hand')

    let streamed = ''
    for await (const event of app.ctx.llm.stream({ provider: profile.id, messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'delta') streamed += event.text
      if (event.type === 'result') expect(event.result.provider).toBe(working)
    }
    expect(streamed).toBe('Hi from LLM')
  })

  it('drops a deleted provider from profiles', async () => {
    const profile = (await app.call('providers.list')).profiles.find((item: any) => item.name === 'With fallback')
    await app.call('providers.delete', { id: broken })
    expect((await app.call('providers.list')).profiles.find((item: any) => item.id === profile.id).models).toEqual([{ provider: working, model: 'typed-by-hand' }])
  })
})
