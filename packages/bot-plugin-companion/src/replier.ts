import type { Plan } from './planner'
import type { Transcript } from './transcript'

export interface ReplyRequest {
  transcript: Transcript
  plan: Plan
  name: string
  persona?: { prompt: string; examples?: { user: string; assistant: string }[] }
  maxParts: number
  isPrivate: boolean
}

const DEFAULT_PERSONA = '你是一个普通的年轻群友，说话随意，有自己的想法。'

/** The replier's system prompt: the persona, then how people talk in a chat. */
export function replierSystem(request: Pick<ReplyRequest, 'name' | 'persona' | 'maxParts' | 'isPrivate'>) {
  const examples = request.persona?.examples?.filter((example) => example.user.trim() && example.assistant.trim()) ?? []
  return [
    request.persona?.prompt.trim() || DEFAULT_PERSONA,
    examples.length ? `你平时这样说话：\n${examples.map((example) => `对方：${example.user}\n你：${example.assistant}`).join('\n')}` : '',
    [
      `你在${request.isPrivate ? '和朋友私聊' : ' QQ 群里聊天'}，名字是「${request.name}」。`,
      '像真人发消息一样说话：口语、简短，一般一两句；不要用 Markdown、列表或标题；不要自称 AI 或助手；不要说“有什么可以帮你”这类客服话。',
      `想分几条发时，用 | 隔开，最多 ${request.maxParts} 条。只写你要发的内容，不要写名字或编号。`,
      '需要认真解答的问题可以说得长一点，这时不要分条。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n')
}

/** The replier's user message: the chat, the message to answer and what the planner had in mind. */
export function replierPrompt(request: ReplyRequest) {
  const target = request.plan.target ? request.transcript.find(request.plan.target) : undefined
  const who = target ? target.record.user.name || target.record.user.id : undefined
  return [
    `<chat>\n${request.transcript.text}\n</chat>`,
    target ? `你要回复 ${target.ref}（${who}：${target.text}）。` : '你要接着大家的话说一句。',
    request.plan.intent ? `你的想法：${request.plan.intent}` : '',
    '直接写出你要发的消息：',
  ].filter(Boolean).join('\n')
}
