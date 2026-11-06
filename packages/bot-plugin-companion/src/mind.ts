import type { MessageRecord, Provenance } from '@mushin/core'
import { type Config, DEBOUNCE } from './config'
import { cleanReply, reactionDelay, splitReply, typingDelay } from './express'
import { type Interest, interestOf, Willingness } from './interest'
import { parsePlan, type Plan, plannerPrompt, plannerSystem } from './planner'
import { type Recollection, recollectionText } from './memory'
import { asleep, CALM, Mood, SLEEPY } from './mood'
import { replierPrompt, replierSystem } from './replier'
import { buildTranscript, type Transcript } from './transcript'

/** Messages of the chat the planner and replier read. */
export const TRANSCRIPT_SIZE = 40

export interface PersonaInfo {
  name?: string
  prompt: string
  examples?: { user: string; assistant: string }[]
  provider?: string
  model?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** What a chat mind needs from the bot; tests pass fakes. */
export interface MindDeps {
  config: Config
  selfId?: string
  name: string
  /** The chat's recent messages, oldest first, the bot's own included. */
  history(limit: number): Promise<MessageRecord[]>
  persona(record: MessageRecord): PersonaInfo | undefined
  chat(role: 'planner' | 'reply', messages: ChatMessage[], persona?: PersonaInfo): Promise<{ text: string; source?: Provenance }>
  /** Sends one message, quoting a message id when given. */
  send(text: string, options: { quote?: string; source?: Provenance }): Promise<void>
  /** What the bot remembers that fits the recent chat; left out when memory is off. */
  recall?(records: MessageRecord[]): Promise<Recollection | undefined>
  onDecision?(decision: Decision): void
  now?(): number
  random?(): number
}

/** One look the companion took at a chat, for the decision log. */
export interface Decision {
  at: number
  /** `skipped`: interest too low to ask the planner. */
  action: Plan['action'] | 'skipped' | 'limited' | 'failed'
  interest: Interest
  willingness: number
  plan?: Plan
  sent?: string[]
  error?: string
}

/** What a look asks for next: look again right away, or after a wait. */
interface Next {
  replan?: boolean
  retryIn?: number
}

/** Most times a chat asks the planner again because people kept talking while it wrote. */
const MAX_REPLANS = 1

/**
 * One chat as the companion sees it. Messages queue up until the sender pauses; then the batch is
 * scored, and when the bot wants to speak, the planner decides and the replier writes. One look at
 * a time: messages arriving meanwhile wait for the next one.
 */
export class ChatMind {
  readonly willingness = new Willingness(1)
  readonly mood = new Mood()
  private pending: MessageRecord[] = []
  private timer?: ReturnType<typeof setTimeout>
  private firstPendingAt = 0
  private busy = false
  private disposed = false
  private repliesToday = { day: '', count: 0 }

  constructor(private deps: MindDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private random() {
    return this.deps.random?.() ?? Math.random()
  }

  /** A message from a person arrived in this chat. */
  push(record: MessageRecord) {
    if (this.disposed) return
    if (!this.pending.length) this.firstPendingAt = this.now()
    this.pending.push(record)
    this.schedule()
  }

  /** Waits for a pause: the quiet time after the last message, but no longer than the cap after the first. */
  private schedule(delay?: number) {
    if (this.busy || this.disposed) return
    clearTimeout(this.timer)
    const { quiet, max } = DEBOUNCE[this.deps.config.debounce]
    const direct = this.pending.some((record) => record.channel.type === 'private')
    const wait = delay ?? Math.min(direct ? quiet / 2 : quiet, Math.max(0, this.firstPendingAt + max - this.now()))
    this.timer = setTimeout(() => void this.think(), wait)
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.pending = []
  }

  /** Resolves once the current look, if any, is done; for tests. */
  get idle() {
    return !this.busy && !this.pending.length
  }

  private log(decision: Omit<Decision, 'at' | 'willingness'>) {
    this.deps.onDecision?.({ at: this.now(), willingness: this.willingness.value, ...decision })
  }

  private countReply() {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (this.repliesToday.day !== day) this.repliesToday = { day, count: 0 }
    this.repliesToday.count++
  }

  private limited() {
    const limit = this.deps.config.dailyReplies
    const day = new Date(this.now()).toISOString().slice(0, 10)
    return limit > 0 && this.repliesToday.day === day && this.repliesToday.count >= limit
  }

  private async think(replans = 0): Promise<void> {
    if (this.busy || this.disposed || !this.pending.length) return
    this.busy = true
    const batch = this.pending
    this.pending = []
    let next: Next | void = undefined
    try {
      next = await this.look(batch, replans)
    } catch (error) {
      this.log({ action: 'failed', interest: { addressed: false, score: 0, reasons: [] }, error: String((error as Error)?.message ?? error) })
    } finally {
      this.busy = false
    }
    if (this.disposed) return
    if (next?.replan) return this.think(replans + 1)
    if (next?.retryIn !== undefined) return this.schedule(next.retryIn)
    if (this.pending.length) {
      this.firstPendingAt = this.now()
      this.schedule()
    }
  }

  private async look(batch: MessageRecord[], replans: number): Promise<Next | void> {
    const { config } = this.deps
    const latest = batch.at(-1)!
    const isPrivate = latest.channel.type === 'private'
    const history = await this.deps.history(TRANSCRIPT_SIZE + batch.length)
    const batchIds = new Set(batch.map((record) => record.id))
    const before = history.filter((record) => !batchIds.has(record.id))
    const interest = interestOf(batch, { selfId: this.deps.selfId, aliases: config.aliases, interests: config.interests, talkValue: config.talkValue, before, now: this.now() })
    const sleeping = asleep(config.quietHours, this.now())
    if (sleeping && !interest.addressed) return this.log({ action: 'skipped', interest: { ...interest, reasons: [...interest.reasons, 'asleep'] } })
    if (!this.willingness.add(interest, this.now())) return this.log({ action: 'skipped', interest })
    if (this.limited()) return this.log({ action: 'limited', interest })

    const transcript = buildTranscript(history.slice(-TRANSCRIPT_SIZE), { selfId: this.deps.selfId, selfName: this.deps.name })
    const fresh = transcript.lines.filter((line) => batchIds.has(line.record.id)).map((line) => line.ref)
    const persona = this.deps.persona(latest)
    const memory = recollectionText(await this.deps.recall?.(history).catch(() => undefined))
    const mood = this.moodNow(sleeping)
    let plan: Plan
    try {
      plan = isPrivate
        ? { action: 'reply', target: fresh.at(-1), reason: 'private chat' }
        : await this.plan(transcript, fresh, interest.addressed, persona, memory, mood)
    } catch (error) {
      return this.log({ action: 'failed', interest, error: String((error as Error)?.message ?? error) })
    }
    if (!sleeping) this.mood.set(plan.mood, this.now())

    if (plan.action === 'wait') {
      // Put the batch back in front and look again after the wait, with whatever came meanwhile.
      this.pending = [...batch, ...this.pending]
      this.log({ action: 'wait', interest, plan })
      return { retryIn: plan.seconds! * 1000 }
    }
    if (plan.action === 'no_reply') {
      this.willingness.stayedQuiet(this.now())
      return this.log({ action: 'no_reply', interest, plan })
    }

    let reply: { text: string; source?: Provenance }
    try {
      reply = await this.deps.chat('reply', [
        { role: 'system', content: replierSystem({ name: this.deps.name, persona, maxParts: config.maxParts, isPrivate }) },
        { role: 'user', content: replierPrompt({ transcript, plan, name: this.deps.name, persona, maxParts: config.maxParts, isPrivate, memory, mood: this.moodNow(sleeping) }) },
      ], persona)
    } catch (error) {
      return this.log({ action: 'failed', interest, plan, error: String((error as Error)?.message ?? error) })
    }
    // People kept talking while the reply was written: look again with everything, once.
    if (this.pending.length && replans < MAX_REPLANS && !isPrivate) {
      this.pending = [...batch, ...this.pending]
      this.log({ action: 'wait', interest, plan: { ...plan, action: 'wait', reason: 'new messages while writing' } })
      return { replan: true }
    }
    const parts = splitReply(cleanReply(reply.text, this.deps.name), config.maxParts)
    if (!parts.length) return this.log({ action: 'no_reply', interest, plan: { ...plan, reason: `${plan.reason} (empty reply)` } })

    const target = plan.target ? transcript.find(plan.target) : undefined
    // Quote only when the message answered is not the latest one from a person.
    const lastPerson = [...transcript.lines].reverse().find((line) => !line.self)
    const quote = target && target !== lastPerson ? target.record.messageId : undefined
    await this.sleep(reactionDelay(() => this.random()))
    for (const [index, part] of parts.entries()) {
      if (this.disposed) break
      await this.sleep(typingDelay(part, config.typingSpeed, () => this.random()))
      await this.deps.send(part, { quote: index === 0 ? quote : undefined, source: reply.source })
    }
    this.countReply()
    this.willingness.spoke(this.now())
    this.log({ action: 'reply', interest, plan, sent: parts })
  }

  private async plan(transcript: Transcript, fresh: string[], addressed: boolean, persona?: PersonaInfo, memory?: string, mood?: string) {
    const request = { transcript, fresh, addressed, name: this.deps.name, persona: persona?.prompt, isPrivate: false, memory, mood }
    const answer = await this.deps.chat('planner', [
      { role: 'system', content: plannerSystem(request) },
      { role: 'user', content: plannerPrompt(request) },
    ])
    return parsePlan(answer.text, request)
  }

  /** The mood worth telling the models; calm goes without saying. */
  private moodNow(sleeping: boolean) {
    const mood = sleeping ? SLEEPY : this.mood.current(this.now())
    return mood === CALM ? undefined : mood
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
}
