/** Turning a stretch of chat into candidate knowledge: the prompt, and reading the model's answer. */

export interface ChatLineLike {
  direction: 'in' | 'out'
  user: { id: string; name?: string }
  text: string
}

export interface Candidate {
  question: string
  answer: string
}

export const LEARN_PROMPT = [
  'You read a stretch of a group or private chat and pick out knowledge worth keeping in the chat\'s knowledge base:',
  'facts, rules, how-tos, answers to questions, decisions and recurring information that will help answer later questions.',
  'Leave out small talk, jokes, opinions, guesses, anything still unsettled or contradicted later, and personal or private details about people.',
  'Write each item as a question someone might ask and a short self-contained answer, in the language of the chat.',
  'Answer with a JSON array only, like [{"question": "...", "answer": "..."}]; answer [] when there is nothing worth keeping.',
].join(' ')

/** The chat as the model reads it: one `name: text` line per message. */
export function transcript(lines: ChatLineLike[], botName = 'bot') {
  return lines
    .filter((line) => line.text.trim())
    .map((line) => `${line.direction === 'out' ? botName : line.user.name || line.user.id}: ${line.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

/** Items from the model's answer: a JSON array, possibly in a code fence or with text around it. */
export function parseCandidates(answer: string): Candidate[] {
  const start = answer.indexOf('[')
  const end = answer.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let items: unknown
  try {
    items = JSON.parse(answer.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const question = typeof item?.question === 'string' ? item.question.trim() : ''
    const text = typeof item?.answer === 'string' ? item.answer.trim() : ''
    if (!question || !text || seen.has(question)) return []
    seen.add(question)
    return [{ question: question.slice(0, 300), answer: text.slice(0, 2000) }]
  })
}

/** A candidate as a knowledge chunk. */
export function candidateText(candidate: Candidate) {
  return `问：${candidate.question}\n答：${candidate.answer}`
}
