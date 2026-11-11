import type { LocalizedText } from '@mushinjs/core'
import type { NodeType } from './types'

export const english = (text: LocalizedText) => (typeof text === 'string' ? text : text.en ?? Object.values(text)[0] ?? '')

/** `Poke / 戳一戳`: the English title, and the Chinese one when it differs, since users often write Chinese. */
export function titleOf(type: NodeType) {
  const en = english(type.title)
  const zh = typeof type.title === 'string' ? undefined : type.title['zh-CN']
  return zh && zh !== en ? `${en} / ${zh}` : en
}

/** Lowercase words of a type id or title: `onebot.sendPoke` → onebot, send, poke. */
function words(text: string) {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean)
}

function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]
}

/**
 * Node types whose id or title looks like a name that does not exist, best first, so a wrong guess
 * such as `action.poke` points at `onebot.sendPoke` instead of a bare "not found".
 */
export function similarTypes(name: string, types: Iterable<NodeType>, limit = 5) {
  const wanted = words(name)
  // The part after the dot says what the node does; the prefix is often the guessed part.
  const verb = wanted.slice(1).length ? wanted.slice(1) : wanted
  const scored: { type: NodeType; score: number }[] = []
  for (const type of types) {
    const own = new Set([...words(type.type), ...words(english(type.title))])
    let score = 0
    for (const word of verb) {
      if (own.has(word)) score += 3
      else if (word.length > 3 && [...own].some((item) => item.length > 3 && (item.includes(word) || word.includes(item)))) score += 2
    }
    if (wanted[0] && type.type.toLowerCase().startsWith(`${wanted[0]}.`)) score += 1
    if (distance(name.toLowerCase(), type.type.toLowerCase()) <= 3) score += 3
    if (score >= 2) scored.push({ type, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.type.type.localeCompare(b.type.type)).slice(0, limit).map((item) => item.type)
}

/** `No node type "x"`, with the closest real ones when there are any. */
export function unknownTypeMessage(name: string, types: Iterable<NodeType>) {
  return `No node type "${name}".${similarHint(name, types)} flows.nodeTypes lists every type.`
}

/** ` Did you mean a (A), b (B)?`, or nothing when no type is close. */
export function similarHint(name: string, types: Iterable<NodeType>) {
  const similar = similarTypes(name, types)
  return similar.length ? ` Did you mean ${similar.map((type) => `${type.type} (${titleOf(type)})`).join(', ')}?` : ''
}
