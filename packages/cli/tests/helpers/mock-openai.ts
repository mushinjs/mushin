import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockReply {
  text?: string
  toolCalls?: { name: string; arguments: Record<string, unknown> }[]
}

/** A minimal OpenAI-compatible server: chat completions (plain and streamed) and the model list. */
export async function createMockOpenAI() {
  const requests: any[] = []
  const queue: MockReply[] = []
  let fallback: MockReply = { text: 'Hi from LLM' }
  let counter = 0

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })

  const server = createServer(async (req, res) => {
    // Test hook: queue scripted replies from outside the process (used by the demo).
    if (req.method === 'POST' && req.url === '/__enqueue') {
      queue.push(...JSON.parse(await readBody(req)))
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404
      res.end()
      return
    }
    const body = JSON.parse(await readBody(req))
    requests.push(body)
    const reply = queue.shift() ?? fallback
    const id = `chatcmpl-${++counter}`
    const toolCalls = (reply.toolCalls ?? []).map((call, index) => ({
      index,
      id: `call_${counter}_${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }))
    const finish = toolCalls.length ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

    if (!body.stream) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: 0, model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: reply.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...call }) => call) } : {}) },
          finish_reason: finish,
        }],
        usage,
      }))
      return
    }

    res.setHeader('content-type', 'text/event-stream')
    const chunk = (delta: object, finishReason: string | null = null) => {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
    }
    chunk({ role: 'assistant', content: '' })
    if (reply.text) {
      for (const piece of reply.text.match(/.{1,6}/gs) ?? []) chunk({ content: piece })
    }
    if (toolCalls.length) chunk({ tool_calls: toolCalls })
    chunk({}, finish)
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage })}\n\n`)
    res.end('data: [DONE]\n\n')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Queues replies for the next requests, in order. */
    enqueue: (...replies: MockReply[]) => queue.push(...replies),
    setFallback: (reply: MockReply) => (fallback = reply),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
