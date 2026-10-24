import { field, z } from '@mushin/core'
import type { ChatRequest, ChatResponse, LlmMessage, ProviderClient, ProviderType, StreamEvent } from '@mushin/plugin-providers'

export const DEMO_MODEL = 'demo-chat'

export const ProviderConfig = z.object({
  latency: z.number().int().min(0).max(10_000).default(300).meta(field('Latency (ms)', 'Pretend thinking time before each reply', {
    'zh-CN': { title: '延迟（毫秒）', description: '每次回复前模拟的思考时间' },
  })),
})

export type ProviderConfig = z.infer<typeof ProviderConfig>

const CJK = /[㐀-鿿]/

function textOf(message: LlmMessage | undefined) {
  if (!message || message.role === 'tool') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('')
}

/** Labels from the prompt of the flows `ai.classify` node: "...one of these labels: a, b, c. If none fits...". */
function classifyLabels(system: string) {
  const found = /one of these labels: (.*?)\. If none fits/s.exec(system)
  return found?.[1].split(',').map((label) => label.trim()).filter(Boolean)
}

/** A scripted answer: classification by keyword, "OK" for connection tests, otherwise a reply that quotes the message. */
export function demoReply(messages: LlmMessage[]) {
  const system = messages.filter((message) => message.role === 'system').map(textOf).join('\n')
  const user = textOf([...messages].reverse().find((message) => message.role === 'user')).trim()
  const labels = classifyLabels(system)
  if (labels) {
    const text = user.toLowerCase()
    return labels.find((label) => text.includes(label.toLowerCase())) ?? 'other'
  }
  if (user === 'Reply with OK.') return 'OK'
  if (CJK.test(user)) return `【演示模型】你说的是「${user}」。这是离线演示提供商生成的回复，换成真实模型后这里就是 AI 的回答。`
  return `[Demo model] You said "${user}". This reply comes from the offline demo provider; switch to a real model to get AI answers.`
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (!ms) return resolve()
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(signal.reason)
  }, { once: true })
})

/** Answers without any network, so flows and LLM plugins can be tried before a real provider is set up. */
export class DemoClient implements ProviderClient {
  constructor(private config: ProviderConfig) {}

  private respond(request: ChatRequest): ChatResponse {
    const text = demoReply(request.messages)
    const input = request.messages.reduce((sum, message) => sum + textOf(message).length, 0)
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: Math.ceil(input / 4), outputTokens: Math.ceil(text.length / 4) },
    }
  }

  async chat(request: ChatRequest) {
    await sleep(this.config.latency, request.signal)
    return this.respond(request)
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    await sleep(this.config.latency, request.signal)
    const response = this.respond(request)
    // A few chunks, so streaming views have something to animate.
    for (const chunk of response.text.match(/[\s\S]{1,8}/g) ?? []) {
      yield { type: 'delta', text: chunk }
      await sleep(30, request.signal)
    }
    yield { type: 'done', response }
  }

  async listModels() {
    return [DEMO_MODEL]
  }
}

export const demoProviderType: ProviderType<ProviderConfig> = {
  id: 'demo',
  displayName: { en: 'Demo (offline)', 'zh-CN': '演示（离线）' },
  config: ProviderConfig,
  presets: [{ id: 'demo', label: { en: 'Demo model', 'zh-CN': '演示模型' }, config: { latency: 300 }, models: [DEMO_MODEL] }],
  create: (config) => new DemoClient(ProviderConfig.parse(config ?? {})),
}
