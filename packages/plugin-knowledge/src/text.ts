import { MushinError } from '@mushin/core'

/** Document formats a knowledge base reads. PDF and DOCX need optional packages. */
export const FORMATS = ['md', 'txt', 'html', 'pdf', 'docx'] as const
export type DocFormat = typeof FORMATS[number]

/** The format of a file by its name, or nothing for one the knowledge base cannot read. */
export function formatOf(name: string): DocFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  switch (ext) {
    case 'md': case 'markdown': case 'mdx': return 'md'
    case 'txt': case 'text': case 'log': case 'csv': case 'json': case 'yaml': case 'yml': return 'txt'
    case 'html': case 'htm': return 'html'
    case 'pdf': return 'pdf'
    case 'docx': return 'docx'
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Readable text of an HTML page, with headings kept as Markdown headings so chunks know their section. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|pre|h[1-6])>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { ...(title ? { title: decodeEntities(title).trim() } : {}), text }
}

/** Imports a package the knowledge base only needs for some formats. */
async function optional<T>(name: string, format: string): Promise<T> {
  try {
    return await import(name) as T
  } catch {
    throw new MushinError('unavailable', `Reading ${format} files needs the "${name}" package. Install it in the Mushin.js folder with: pnpm add -w ${name}`)
  }
}

/** Text of a PDF's pages; scanned PDFs (images only) have none. */
async function pdfText(data: Uint8Array) {
  const pdfjs = await optional<any>('pdfjs-dist/legacy/build/pdf.mjs', 'PDF')
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
  const pages: string[] = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number)
    const content = await page.getTextContent()
    let line = ''
    const lines: string[] = []
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      line += item.str ?? ''
      if (item.hasEOL) {
        lines.push(line)
        line = ''
      }
    }
    if (line) lines.push(line)
    pages.push(lines.join('\n'))
  }
  await pdf.destroy?.()
  const text = pages.join('\n\n').trim()
  if (!text) throw new MushinError('invalid_input', 'This PDF has no text to read; scanned PDFs need OCR, which is not supported')
  return text
}

async function docxText(data: Uint8Array) {
  const mammoth = await optional<any>('mammoth', 'DOCX')
  const lib = mammoth.default ?? mammoth
  // Converting to HTML keeps headings, which chunks use as their titles.
  const result = await lib.convertToHtml({ buffer: Buffer.from(data) })
  return htmlToText(result.value).text
}

/** The text of a document. */
export async function extractText(format: DocFormat, data: Uint8Array): Promise<{ title?: string; text: string }> {
  switch (format) {
    case 'md':
    case 'txt':
      return { text: new TextDecoder().decode(data).replace(/^﻿/, '').replace(/\r\n?/g, '\n') }
    case 'html':
      return htmlToText(new TextDecoder().decode(data))
    case 'pdf':
      return { text: await pdfText(data) }
    case 'docx':
      return { text: await docxText(data) }
  }
}

export interface ChunkOptions {
  /** Most characters in a chunk. */
  size: number
  /** Characters a chunk repeats from the end of the one before it, within a section. */
  overlap: number
}

export interface TextChunk {
  /** The headings the chunk sits under, such as `群规 > 广告`. */
  title: string
  text: string
}

/** Pieces of at most `size` characters, cut after sentence ends where possible. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const sentences = text.match(/[^。！？!?；;\n.]+[。！？!?；;\n.]*|[。！？!?；;\n.]+/g) ?? [text]
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > size) {
      pieces.push(current)
      current = ''
    }
    if (sentence.length > size) {
      for (let index = 0; index < sentence.length; index += size) pieces.push(sentence.slice(index, index + size))
      continue
    }
    current += sentence
  }
  if (current) pieces.push(current)
  return pieces.map((piece) => piece.trim()).filter(Boolean)
}

/**
 * Splits a document into chunks: by Markdown headings first (each chunk keeps its heading path
 * as its title), then by blank lines, then long paragraphs by sentence. Paragraphs are joined
 * while they fit in `size`; the next chunk of a section starts with the last `overlap` characters.
 */
export function chunkText(text: string, options: ChunkOptions, docTitle = ''): TextChunk[] {
  const size = Math.max(50, options.size)
  const overlap = Math.min(Math.max(0, options.overlap), Math.floor(size / 2))
  const sections: { path: string[]; lines: string[] }[] = []
  const path: string[] = []
  let current = { path: [] as string[], lines: [] as string[] }
  let fence = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      sections.push(current)
      const level = heading[1].length
      path.length = level - 1
      path[level - 1] = heading[2].trim()
      current = { path: path.filter(Boolean), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)

  const chunks: TextChunk[] = []
  for (const section of sections) {
    const title = section.path.length ? section.path.join(' > ') : docTitle
    const paragraphs = section.lines.join('\n').split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
    const pieces = paragraphs.flatMap((paragraph) => splitLong(paragraph, size - overlap))
    let buffer = ''
    let tail = ''
    const flush = () => {
      if (!buffer.trim()) return
      chunks.push({ title, text: buffer.trim() })
      tail = overlap ? buffer.trim().slice(-overlap) : ''
      buffer = ''
    }
    for (const piece of pieces) {
      if (buffer && buffer.length + piece.length + 2 > size) flush()
      if (!buffer && tail) buffer = `${tail}…`
      buffer += (buffer && !buffer.endsWith('…') ? '\n\n' : '') + piece
    }
    flush()
  }
  return chunks
}
