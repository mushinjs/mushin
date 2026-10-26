/** Reads the character card a PNG carries in its `chara` (v2) or `ccv3` (v3) text chunk, base64 JSON. */
export function cardFromPng(buffer: ArrayBuffer): unknown {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const latin1 = new TextDecoder('latin1')
  const found: Record<string, string> = {}
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'tEXt') {
      const split = data.indexOf(0)
      const keyword = latin1.decode(data.subarray(0, split)).toLowerCase()
      if (keyword === 'chara' || keyword === 'ccv3') found[keyword] = latin1.decode(data.subarray(split + 1))
    }
    if (type === 'IEND') break
    offset += 12 + length
  }
  const encoded = found.ccv3 ?? found.chara
  if (!encoded) throw new Error('No character card in this PNG')
  const binary = atob(encoded.trim())
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))))
}

/** The JSON in an imported file: a persona export, a character card, or a PNG character card. */
export async function readPersonaFile(file: File): Promise<unknown> {
  if (file.type === 'image/png' || /\.png$/i.test(file.name)) return cardFromPng(await file.arrayBuffer())
  return JSON.parse(await file.text())
}

/** An image file as a data: URL, for avatars. */
export function imageAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
