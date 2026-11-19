import type OpenAI from 'openai'
import type { ChatRequest, ChatResponse, FinishReason, LlmMessage, StreamEvent, ToolCall } from '@mushinjs/plugin-providers'

/** The `raw` type of an assistant turn from the Responses API: its output items, replayed as they came. */
export const RESPONSES_RAW = 'openai-responses'

type Input = OpenAI.Responses.ResponseInputItem
type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming

function toInput(messages: LlmMessage[]): { instructions?: string; input: Input[] } {
  const system: string[] = []
  const input: Input[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push(message.content)
        break
      case 'user':
        input.push({
          role: 'user',
          content: typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.type === 'text'
              ? { type: 'input_text' as const, text: part.text }
              : { type: 'input_image' as const, image_url: part.url, detail: 'auto' as const }),
        })
        break
      case 'assistant':
        // Output items carry the encrypted reasoning, which the model needs again within a tool loop.
        if (message.raw?.type === RESPONSES_RAW && Array.isArray(message.raw.content)) {
          input.push(...message.raw.content as Input[])
          break
        }
        if (message.content) input.push({ role: 'assistant', content: message.content })
        for (const call of message.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
        }
        break
      case 'tool':
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.isError ? `Error: ${message.content}` : message.content })
        break
    }
  }
  return { ...(system.length ? { instructions: system.join('\n\n') } : {}), input }
}

/** Responses API request body without `stream`. */
export function responsesParams(request: ChatRequest): Params {
  return {
    model: request.model,
    ...toInput(request.messages),
    // Nothing is kept on OpenAI's side; the reasoning comes back encrypted so the next request can carry it.
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown>, strict: false })),
    } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.effort ? { reasoning: { effort: (request.effort === 'max' ? 'xhigh' : request.effort) as 'high' } } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
  }
}

export function fromResponse(response: OpenAI.Responses.Response): ChatResponse {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) if (part.type === 'output_text') text += part.text
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments || '{}' })
    }
  }
  const reason = response.incomplete_details?.reason
  const finishReason: FinishReason = response.status === 'incomplete'
    ? reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'refusal' : 'other'
    : toolCalls.length ? 'tool_calls' : 'stop'
  return {
    text,
    toolCalls,
    finishReason,
    usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } : undefined,
    raw: { type: RESPONSES_RAW, content: response.output },
  }
}

export async function responsesChat(sdk: OpenAI, request: ChatRequest): Promise<ChatResponse> {
  return fromResponse(await sdk.responses.create(responsesParams(request), { signal: request.signal }))
}

export async function* responsesStream(sdk: OpenAI, request: ChatRequest): AsyncIterable<StreamEvent> {
  const stream = await sdk.responses.create({ ...responsesParams(request), stream: true }, { signal: request.signal })
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') yield { type: 'delta', text: event.delta }
    else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      yield { type: 'done', response: fromResponse(event.response) }
      return
    } else if (event.type === 'response.failed') {
      throw new Error(event.response.error?.message ?? 'The response failed')
    } else if (event.type === 'error') {
      throw new Error(event.message)
    }
  }
  throw new Error('The response stream ended without a result')
}
