/** Turning a model's reply into messages sent the way a person sends them. */

const SPEAKER = /^\s*(?:\[#\d+[^\]]*\]\s*)?(?:你（[^）]*）|你|[^：:\n]{1,16})[：:]\s*/
const AI_TICS = [/作为一个?(?:AI|人工智能|语言模型|助手)[，,]?/gi, /有什么(?:我)?可以帮(?:你|您)的吗[？?]?/g, /希望(?:这|以上)?(?:能|对你)有(?:所)?帮助[！!。]?/g]

/** Removes what a model adds that a person would not: a speaker label, Markdown, assistant phrases. */
export function cleanReply(text: string, name?: string) {
  let result = text.trim()
  if (name && result.startsWith(`${name}：`)) result = result.slice(name.length + 1)
  else if (/^\s*(?:\[#\d+|你（|你[：:])/.test(result)) result = result.replace(SPEAKER, '')
  for (const tic of AI_TICS) result = result.replace(tic, '')
  result = result
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^["“](.*)["”]$/s, '$1')
  return result.trim()
}

/** Longest reply that is still split by sentence; longer ones are answers and go as one message. */
const SPLIT_LIMIT = 120

/** Splits a reply into at most `maxParts` messages: at `|`, else at line breaks or sentence ends of a short reply. */
export function splitReply(text: string, maxParts: number) {
  const clean = (parts: string[]) => parts.map((part) => part.trim().replace(/[。.]$/, '')).filter(Boolean)
  let parts: string[]
  if (text.includes('|')) parts = clean(text.split('|'))
  else if (text.length > SPLIT_LIMIT) return [text.trim()]
  else if (text.includes('\n')) parts = clean(text.split(/\n+/))
  else parts = clean(text.match(/[^。！？!?~～]+[。！？!?~～]*/g) ?? [text])
  if (parts.length <= maxParts) return parts
  // Join the tail into the last allowed message.
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join(' ')]
}

/** How long a person takes to type a message, with some randomness: between 0.6 and 8 seconds. */
export function typingDelay(part: string, charsPerSecond: number, random = Math.random) {
  const ms = (part.length / charsPerSecond) * 1000 * (0.8 + 0.4 * random())
  return Math.round(Math.min(8000, Math.max(600, ms)))
}

/** How long before starting to type at all: one to three seconds. */
export function reactionDelay(random = Math.random) {
  return Math.round(1000 + 2000 * random())
}
