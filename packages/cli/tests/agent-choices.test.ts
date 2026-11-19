import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let provider: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  app = await startInstance()
  provider = (await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model', 'mock-big'] })).id
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
})

async function turn(input: Record<string, unknown>) {
  const { session } = await app.call('agent.send', input)
  await waitFor(async () => !(await app.call('agent.session', { id: session })).running || undefined)
  return session as string
}

describe('agent model, effort and edits', () => {
  it('uses the model and effort picked for a message', async () => {
    llm.enqueue({ text: 'One.' })
    await turn({ text: 'hi', provider, model: 'mock-big', effort: 'high' })
    expect(llm.requests.at(-1)).toMatchObject({ model: 'mock-big', reasoning_effort: 'high' })

    llm.enqueue({ text: 'Two.' })
    await turn({ text: 'hi', effort: 'max' })
    expect(llm.requests.at(-1)).toMatchObject({ model: 'mock-model', reasoning_effort: 'xhigh' })

    llm.enqueue({ text: 'Three.' })
    await turn({ text: 'hi' })
    expect(llm.requests.at(-1).reasoning_effort).toBeUndefined()
  })

  it('edits a user message: what followed it is replaced', async () => {
    llm.enqueue({ text: 'Answer one.' }, { text: 'Answer two.' })
    const session = await turn({ text: 'first question' })
    await turn({ session, text: 'second question' })

    llm.enqueue({ text: 'Answer to the edit.' })
    await turn({ session, text: 'first question, edited', rewind: 0 })
    const { messages } = await app.call('agent.session', { id: session })
    expect(messages.filter((message: any) => message.role === 'user').map((message: any) => message.display)).toEqual(['first question, edited'])
    expect(messages.at(-1).content).toBe('Answer to the edit.')
    const sent = llm.requests.at(-1).messages.map((message: any) => message.content).join('\n')
    expect(sent).not.toContain('second question')
    await expect(app.call('agent.send', { session, text: 'x', rewind: 5 })).rejects.toThrow(/no user message 5/)
  })
})
