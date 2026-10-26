import type { PersonaInput } from './types'

/** What `personas.export` writes; `personas.import` reads it back. */
export interface PersonaExport {
  format: 'mushin-personas'
  version: 1
  personas: PersonaInput[]
}

/**
 * A character card as SillyTavern and similar apps save it: version 1 has the fields at the top,
 * versions 2 and 3 put them under `data`.
 */
interface CardFields {
  name?: string
  description?: string
  personality?: string
  scenario?: string
  first_mes?: string
  mes_example?: string
  system_prompt?: string
  post_history_instructions?: string
  creator_notes?: string
  tags?: string[]
}

/** Is this a character card (any version) rather than a persona? */
export function isCharacterCard(value: any) {
  if (!value || typeof value !== 'object') return false
  if (value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3') return true
  return typeof value.name === 'string' && ('first_mes' in value || 'mes_example' in value || 'personality' in value)
}

/** Splits a card's `mes_example` into exchanges: blocks start with `<START>`, lines with `{{user}}:` or `{{char}}:`. */
export function parseExamples(text: string, name: string) {
  const examples: { user: string; assistant: string }[] = []
  for (const block of text.split(/<START>/i)) {
    let user = ''
    let assistant = ''
    let speaker: 'user' | 'char' | undefined
    const flush = () => {
      if (user.trim() && assistant.trim()) examples.push({ user: user.trim(), assistant: assistant.trim() })
      user = ''
      assistant = ''
    }
    for (const line of block.split(/\r?\n/)) {
      const match = /^\s*(\{\{user\}\}|<user>|\{\{char\}\}|<bot>|<char>)\s*:\s*(.*)$/i.exec(line)
      if (match) {
        const next = /user/i.test(match[1]) ? 'user' : 'char'
        if (next === 'user' && assistant) flush()
        speaker = next
        if (next === 'user') user += (user ? '\n' : '') + match[2]
        else assistant += (assistant ? '\n' : '') + match[2]
      } else if (speaker && line.trim()) {
        if (speaker === 'user') user += `\n${line}`
        else assistant += `\n${line}`
      }
    }
    flush()
  }
  return examples.map((example) => ({ user: fillCardNames(example.user, name), assistant: fillCardNames(example.assistant, name) }))
}

/** Card placeholders in our variables: `{{char}}` is the persona's name, `{{user}}` the sender. */
function fillCardNames(text: string, name: string) {
  return text.replace(/\{\{char\}\}|<bot>|<char>/gi, name).replace(/\{\{user\}\}|<user>/gi, '{user.name}').trim()
}

/** A persona from a character card. Greetings are left out: a bot answers, it does not open chats. */
export function fromCharacterCard(card: any): PersonaInput {
  const data: CardFields = card.data && typeof card.data === 'object' ? card.data : card
  const name = String(data.name ?? '').trim() || 'Character'
  const sections = [
    data.system_prompt,
    data.description && `${name}: ${data.description}`,
    data.personality && `Personality: ${data.personality}`,
    data.scenario && `Scenario: ${data.scenario}`,
    data.post_history_instructions,
  ].map((part) => fillCardNames(String(part ?? ''), name)).filter(Boolean)
  return {
    name,
    description: String(data.creator_notes ?? '').trim().slice(0, 500),
    prompt: sections.length ? `You are ${name}.\n\n${sections.join('\n\n')}` : `You are ${name}.`,
    examples: parseExamples(String(data.mes_example ?? ''), name),
    tags: Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean).slice(0, 20) : [],
  }
}

/** Personas from what `personas.import` was given: our export, one persona, a list, or character cards. */
export function personasFrom(data: unknown): PersonaInput[] {
  const items = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as any).personas) ? (data as any).personas : [data]
  return items.map((item: any) => (isCharacterCard(item) ? fromCharacterCard(item) : item))
}
