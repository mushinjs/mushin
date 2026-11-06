import type { Transcript } from './transcript'

export type PlanAction = 'reply' | 'wait' | 'no_reply'

/** What the planner decided for a chat. */
export interface Plan {
  action: PlanAction
  /** The message to answer, as a transcript ref such as `#12`. */
  target?: string
  /** One line on what to say and in what tone, for the replier. */
  intent?: string
  /** For `wait`: seconds to wait for more messages. */
  seconds?: number
  reason: string
  /** True when the model's answer could not be read and this plan is the fallback. */
  fallback?: boolean
}

export interface PlanRequest {
  transcript: Transcript
  /** Refs of the messages that arrived since the planner last looked. */
  fresh: string[]
  addressed: boolean
  name: string
  /** The persona's prompt, or a short description of the bot. */
  persona?: string
  isPrivate: boolean
}

const PERSONA_CHARS = 600

/** The planner's system prompt: who it is and how to decide. Fixed per bot, so it caches well. */
export function plannerSystem(request: Pick<PlanRequest, 'name' | 'persona'>) {
  const persona = request.persona?.trim()
  return [
    `你是 QQ 群里的「${request.name}」，像普通群友一样聊天。你现在不是在回复，而是在决定要不要开口。`,
    persona ? `你的人设（节选）：\n${persona.length > PERSONA_CHARS ? `${persona.slice(0, PERSONA_CHARS)}…` : persona}` : '',
    [
      '判断方法：',
      '- 真人不会每条都回。和你无关、你插不上话、别人聊得正热闹时，选 no_reply。',
      '- 有人 @ 你、回复你的消息、叫你的名字，或在接你刚才的话，一般要回。',
      '- 对方像是话还没说完（只发了半句、正在连发），选 wait，等几秒再看。',
      '- 话题你感兴趣、有梗可接、有人提问没人答时，可以回。',
      '- 只回最值得回的一条，target 填它的编号。',
    ].join('\n'),
    [
      '只输出一个 JSON 对象，不要别的文字：',
      '{"action":"reply|wait|no_reply","target":"#编号","intent":"想说什么、什么语气，一句话","seconds":等待秒数,"reason":"为什么，一句话"}',
      'no_reply 时 target 和 intent 可以省略；wait 时给 seconds（3 到 20）。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n')
}

/** The planner's user message: the chat and what is new in it. */
export function plannerPrompt(request: PlanRequest) {
  return [
    `<chat>\n${request.transcript.text}\n</chat>`,
    `新消息：${request.fresh.join('、') || '无'}${request.addressed ? '（其中有人在找你）' : ''}`,
    request.isPrivate ? '这是私聊，对方说话一般都要回。' : '',
    '现在你要怎么做？',
  ].filter(Boolean).join('\n')
}

/** The newest fresh message that speaks to the bot, else the newest fresh message from a person. */
function fallbackTarget(request: PlanRequest) {
  const fresh = request.fresh.map((ref) => request.transcript.find(ref)).filter((line) => line && !line.self)
  return fresh.at(-1)?.ref
}

/** Reads the planner's answer; when it cannot, replies if the bot was addressed and stays quiet otherwise. */
export function parsePlan(answer: string, request: PlanRequest): Plan {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  let data: any
  try {
    data = start >= 0 && end > start ? JSON.parse(answer.slice(start, end + 1)) : undefined
  } catch {}
  const action = typeof data?.action === 'string' ? data.action.trim().toLowerCase() : ''
  if (!['reply', 'wait', 'no_reply'].includes(action)) {
    return request.addressed
      ? { action: 'reply', target: fallbackTarget(request), reason: 'addressed; planner answer unreadable', fallback: true }
      : { action: 'no_reply', reason: 'planner answer unreadable', fallback: true }
  }
  const reason = typeof data.reason === 'string' ? data.reason.slice(0, 200) : ''
  if (action === 'wait') {
    const seconds = Math.min(20, Math.max(3, Number(data.seconds) || 5))
    return { action, seconds, reason }
  }
  if (action === 'no_reply') return { action, reason }
  const rawTarget = typeof data.target === 'string' || typeof data.target === 'number' ? String(data.target) : ''
  const line = rawTarget ? request.transcript.find(rawTarget) : undefined
  return {
    action,
    target: line && !line.self ? line.ref : fallbackTarget(request),
    ...(typeof data.intent === 'string' && data.intent.trim() ? { intent: data.intent.trim().slice(0, 200) } : {}),
    reason,
  }
}
