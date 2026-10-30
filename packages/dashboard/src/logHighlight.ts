import { AnsiUp } from 'ansi_up'
import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'
import type { LogRef } from './logRefs'
import { splitRefs } from './logRefs'

/**
 * Log line coloring: ANSI escapes (from plugins that color their own output) go through ansi_up,
 * everything else through a small highlight.js grammar for log text. Both emit classes only;
 * the colors are CSS variables in LogViewer.vue, set per theme.
 */

const log: LanguageFn = () => ({
  name: 'log',
  case_insensitive: true,
  contains: [
    // Stack frames read as noise next to the message.
    { scope: 'frame', begin: /^\s+at\s/, end: /$/ },
    { scope: 'string', begin: /"/, end: /"/, illegal: /\n/, contains: [{ begin: /\\./ }] },
    // Quotes only open after a space or bracket, so "bot's" stays plain text.
    { scope: 'string', begin: /(?<=^|[\s([{=:,])'(?=[^'\n]*')/, end: /'/ },
    { scope: 'link', match: /\b(?:https?|wss?|file):\/\/[^\s"'<>)\]]+/ },
    { scope: 'date', match: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/ },
    { scope: 'date', match: /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/ },
    { scope: 'address', match: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\blocalhost(?::\d{1,5})?\b/ },
    { scope: 'number', match: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b0x[0-9a-f]+\b/ },
    { scope: 'path', match: /(?<![\w:/.])(?:[a-z]:[\\/]|\.{1,2}\/|\/)[\w.@-]+(?:[\\/][\w.@-]+)*\/?/ },
    { scope: 'attr', match: /\b[a-z_][\w.-]*(?==)/ },
    { scope: 'literal', match: /\b(?:true|false|null|undefined|NaN)\b/ },
    { scope: 'bad', match: /\b(?:errors?|failed|failure|fails?|fatal|exception|rejected|refused|denied|timed out|timeout|crash(?:ed)?|unable|cannot|invalid|not found|unauthorized|forbidden)\b/ },
    { scope: 'caution', match: /\b(?:warn(?:ing)?s?|deprecated|retry(?:ing)?|falling back|fallback|skipp(?:ed|ing)|disconnected|offline|stopped|disabled|removed|used up)\b/ },
    { scope: 'good', match: /\b(?:ok|success(?:ful(?:ly)?)?|succeeded|ready|online|connected|active|started|enabled|passed|loaded|done|created|available)\b/ },
    { scope: 'number', match: /(?<![\w.])-?\d+(?:\.\d+)?(?:\s?(?:ms|s|kb|mb|gb|%)(?![\w]))?/ },
  ],
})

hljs.registerLanguage('log', log)

const ansi = new AnsiUp()
ansi.use_classes = true
const hasAnsi = /\x1b\[/

function escape(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function highlight(text: string) {
  return hljs.highlight(text, { language: 'log', ignoreIllegals: true }).value
}

export type RefTitle = (ref: LogRef) => string

/** The line's text as HTML: colored, with the ids it mentions as links to their pages. */
export function renderLog(text: string, refs: Map<string, LogRef>, tag: string | undefined, title: RefTitle) {
  if (hasAnsi.test(text)) return ansi.ansi_to_html(text)
  return splitRefs(text, refs, tag).map((segment) => typeof segment === 'string'
    ? highlight(segment)
    : `<a class="log-ref log-ref-${segment.kind}" href="${escape(segment.to)}" data-to="${escape(segment.to)}" title="${escape(title(segment))}">${escape(segment.id)}</a>`,
  ).join('')
}
