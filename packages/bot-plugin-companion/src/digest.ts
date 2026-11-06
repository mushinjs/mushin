import { randomId } from '@mushin/core'
import type { ChatSummary, MemoryItem, PersonCard } from './store'
import { personId } from './store'

/** New messages in a chat that make the companion write its summary and memories again. */
export const DIGEST_EVERY = 30
/** Facts kept per person, newest last. */
export const MAX_FACTS = 12
/** How far one digest may move how close the bot feels to someone. */
const AFFINITY_STEP = 0.2

/** What the model takes from a stretch of chat. */
export interface Digest {
  summary: string
  memories: { text: string; people: string[]; topic: string }[]
  people: { id: string; name?: string; impression?: string; facts: string[]; affinity: number }[]
}

export const DIGEST_SYSTEM = [
  '你在整理自己在一个聊天里的记忆。读之前的摘要、你对相关的人的印象和新的聊天记录，输出 JSON。',
  '规则：',
  '- summary：把之前的摘要和新内容合成一段新的摘要，300 字以内，写最近在聊什么、发生了什么、还没聊完的事。',
  '- memories：值得以后想起来的事，每条一句话，写清是谁、做了什么或说了什么；people 填相关的人的 QQ 号（聊天记录里名字后面方括号里的数字），topic 填两三个字的话题。闲聊废话不要记，最多 5 条。',
  '- people：对聊天里出现的人的印象。impression 一两句话写他是个怎样的人、和你的关系；facts 是他自己说过的关于自己的事（如“在备考”“养了只猫”）；affinity 是这段聊天让你对他更亲近（正数）还是更疏远（负数），在 -0.2 到 0.2 之间。',
  '- 只记聊天里说出来的内容，不要猜。不要记手机号、住址、身份证号、密码、账号这类信息。你自己（“你”）不要出现在 people 里。',
  '只输出 JSON：{"summary":"...","memories":[{"text":"...","people":["QQ号"],"topic":"..."}],"people":[{"id":"QQ号","impression":"...","facts":["..."],"affinity":0.1}]}',
].join('\n')

/** The digest request: the old summary, what the bot thinks of the people present, and the new messages. */
export function digestPrompt(options: { summary?: string; people: PersonCard[]; transcript: string }) {
  const people = options.people.map((card) => `${card.name}[${card.user}]：${card.impression || '还没有印象'}${card.facts.length ? `；${card.facts.join('；')}` : ''}`)
  return [
    `<summary>\n${options.summary?.trim() || '（还没有摘要）'}\n</summary>`,
    people.length ? `<people>\n${people.join('\n')}\n</people>` : '',
    `<chat>\n${options.transcript}\n</chat>`,
  ].filter(Boolean).join('\n\n')
}

/** Contact details and ids that never go into memory, whatever the model wrote. */
const PRIVATE = /\d{11}|\d{15,18}[\dxX]?|[\w.+-]+@[\w-]+\.[\w.]+|密码|身份证|住址|家住|银行卡/
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Reads the model's answer; anything it cannot read is left out. */
export function parseDigest(answer: string, known: Set<string>): Digest | undefined {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  let data: any
  try {
    data = start >= 0 && end > start ? JSON.parse(answer.slice(start, end + 1)) : undefined
  } catch {}
  if (!data || typeof data !== 'object') return
  const ids = (value: unknown) => (Array.isArray(value) ? value.map(String).filter((id) => known.has(id)) : [])
  const memories = (Array.isArray(data.memories) ? data.memories : []).slice(0, 5)
    .map((item: any) => ({ text: clean(item?.text, 200), people: ids(item?.people), topic: clean(item?.topic, 20) }))
    .filter((item: Digest['memories'][number]) => item.text && !PRIVATE.test(item.text))
  const people = (Array.isArray(data.people) ? data.people : [])
    .filter((item: any) => known.has(String(item?.id)))
    .map((item: any) => ({
      id: String(item.id),
      impression: clean(item.impression, 200),
      facts: (Array.isArray(item.facts) ? item.facts : []).map((fact: unknown) => clean(fact, 60)).filter((fact: string) => fact && !PRIVATE.test(fact)),
      affinity: Math.max(-AFFINITY_STEP, Math.min(AFFINITY_STEP, Number(item.affinity) || 0)),
    }))
  return { summary: clean(data.summary, 600), memories, people }
}

/** The person cards after a digest: new impressions, facts added without repeats, affinity moved a step. */
export function mergePeople(bot: string, existing: PersonCard[], digest: Digest, names: Map<string, string>, now: number): PersonCard[] {
  const byUser = new Map(existing.map((card) => [card.user, card]))
  return digest.people.map((update) => {
    const card = byUser.get(update.id) ?? {
      id: personId(bot, update.id), bot, user: update.id, name: '', impression: '', facts: [], affinity: 0, seen: 0, updatedAt: now,
    }
    const facts = [...card.facts.filter((fact) => !update.facts.includes(fact)), ...update.facts].slice(-MAX_FACTS)
    return {
      ...card,
      name: names.get(update.id) ?? card.name,
      impression: update.impression || card.impression,
      facts,
      affinity: Math.max(-1, Math.min(1, card.affinity + update.affinity)),
      seen: card.seen + 1,
      updatedAt: now,
    }
  })
}

/** New memory rows from a digest. */
export function newMemories(bot: string, chat: string, digest: Digest, now: number, vectors?: number[][]): MemoryItem[] {
  return digest.memories.map((item, index) => ({
    id: randomId(),
    bot,
    chat,
    text: item.text,
    people: item.people,
    topic: item.topic,
    ...(vectors?.[index] ? { vector: vectors[index] } : {}),
    recalls: 0,
    createdAt: now,
    recalledAt: 0,
  }))
}

/** The chat's summary after a digest; the old one stays when the model wrote none. */
export function nextSummary(bot: string, chat: string, previous: ChatSummary | undefined, digest: Digest, until: number, now: number): ChatSummary {
  return { id: `${bot}:${chat}`, bot, chat, summary: digest.summary || previous?.summary || '', until, updatedAt: now }
}
