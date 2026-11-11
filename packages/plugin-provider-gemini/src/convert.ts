import type { ChatResponse, FinishReason, LlmMessage, ToolCall, ToolDefinition } from '@mushinjs/plugin-providers'

/** `RawTurn.type` of assistant turns from this provider; their parts are replayed verbatim. */
export const TYPE = 'gemini'

/** Prefix of tool call ids made up locally, for models that return function calls without an id. */
const LOCAL_ID = 'gemini-call-'

export interface GeminiPart {
  text?: string
  /** True for a thought summary; it is not part of the reply text. */
  thought?: boolean
  /** Opaque reasoning state; it must go back with its part on the next request. */
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType?: string; fileUri: string }
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiPart[] }
  tools?: { functionDeclarations: { name: string; description: string; parametersJsonSchema: unknown }[] }[]
  generationConfig?: { maxOutputTokens?: number; temperature?: number }
}

export interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

/** Turns an image URL into a part; `http(s)` URLs are handed to `download`, which returns inline data. */
export type ImageLoader = (url: string) => Promise<{ mimeType: string; data: string }>

async function toImagePart(url: string, download?: ImageLoader): Promise<GeminiPart> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (match) return { inlineData: { mimeType: match[1], data: match[2] } }
  if (/^https?:/i.test(url) && download) return { inlineData: await download(url) }
  // Files API URIs (and anything else) are passed as references.
  return { fileData: { fileUri: url } }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  } catch {
    return {}
  }
}

/**
 * Converts neutral messages to a Gemini request. Leading system text becomes `systemInstruction`;
 * turns from this provider are replayed verbatim so thought signatures stay valid; consecutive
 * user-side parts (tool results, then user text) share one `user` content.
 */
export async function toGeminiRequest(messages: LlmMessage[], options: {
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  download?: ImageLoader
} = {}): Promise<GeminiRequest> {
  const system: string[] = []
  const contents: GeminiContent[] = []
  // functionResponse needs the function name, which a tool message does not carry.
  const callNames = new Map<string, string>()
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (!contents.length) system.push(message.content)
        else push('user', [{ text: message.content }])
        break
      case 'user':
        push('user', typeof message.content === 'string'
          ? [{ text: message.content }]
          : await Promise.all(message.content.map((part) => part.type === 'text'
            ? { text: part.text }
            : toImagePart(part.url, options.download))))
        break
      case 'assistant': {
        for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name)
        if (message.raw?.type === TYPE) {
          push('model', structuredClone(message.raw.content as GeminiPart[]))
          break
        }
        const parts: GeminiPart[] = []
        if (message.content) parts.push({ text: message.content })
        for (const call of message.toolCalls ?? []) {
          parts.push({ functionCall: { ...(call.id.startsWith(LOCAL_ID) ? {} : { id: call.id }), name: call.name, args: safeParse(call.arguments) } })
        }
        push('model', parts)
        break
      }
      case 'tool':
        push('user', [{
          functionResponse: {
            ...(message.toolCallId.startsWith(LOCAL_ID) ? {} : { id: message.toolCallId }),
            name: callNames.get(message.toolCallId) ?? message.toolCallId,
            response: message.isError ? { error: message.content } : { result: message.content },
          },
        }])
        break
    }
  }

  const generationConfig = {
    ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  }
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
    ...(options.tools?.length ? {
      tools: [{
        functionDeclarations: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: { type: 'object', ...tool.parameters },
        })),
      }],
    } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  }
}

export function toFinishReason(reason: string | undefined, hasCalls: boolean): FinishReason | undefined {
  switch (reason) {
    case undefined:
      return
    case 'STOP':
      return hasCalls ? 'tool_calls' : 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
      return 'refusal'
    default:
      return 'other'
  }
}

/**
 * Appends streamed parts to `parts`. Plain text continues the previous text part of the same kind,
 * so a streamed turn replays as a few parts rather than one per chunk; a signature stays with its text.
 */
export function mergeParts(parts: GeminiPart[], incoming: GeminiPart[]) {
  for (const part of incoming) {
    const last = parts.at(-1)
    const isText = (item?: GeminiPart) => item?.text !== undefined && Object.keys(item).every((key) => key === 'text' || key === 'thought' || key === 'thoughtSignature')
    if (isText(part) && isText(last) && !last!.thoughtSignature && !!last!.thought === !!part.thought) {
      last!.text += part.text!
      if (part.thoughtSignature) last!.thoughtSignature = part.thoughtSignature
    } else {
      parts.push({ ...part })
    }
  }
  return parts
}

/** Builds the neutral response from a whole turn's parts and the last chunk's metadata. */
export function fromParts(parts: GeminiPart[], meta: { finishReason?: string; blockReason?: string; usage?: GeminiResponse['usageMetadata'] }): ChatResponse {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const part of parts) {
    if (part.text !== undefined && !part.thought) text += part.text
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `${LOCAL_ID}${toolCalls.length + 1}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      })
    }
  }
  const usage = meta.usage
  return {
    text,
    toolCalls,
    finishReason: meta.blockReason && !parts.length ? 'refusal' : toFinishReason(meta.finishReason, toolCalls.length > 0),
    ...(usage ? {
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    } : {}),
    ...(parts.length ? { raw: { type: TYPE, content: parts } } : {}),
  }
}

export function fromResponse(response: GeminiResponse): ChatResponse {
  const candidate = response.candidates?.[0]
  return fromParts(candidate?.content?.parts ?? [], {
    finishReason: candidate?.finishReason,
    blockReason: response.promptFeedback?.blockReason,
    usage: response.usageMetadata,
  })
}
