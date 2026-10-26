import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { cardFromPng } from '../src/personaCards'

/** A 1×1 PNG with a tEXt chunk, as character card apps write it. */
function pngWith(keyword: string, text: string) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('PNG character cards', () => {
  it('reads the card from the chara chunk, keeping UTF-8 text', () => {
    const card = { spec: 'chara_card_v2', data: { name: '猫娘', description: 'grumpy' } }
    const png = pngWith('chara', Buffer.from(JSON.stringify(card)).toString('base64'))
    expect(cardFromPng(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))).toEqual(card)
  })

  it('says so when the PNG has no card', () => {
    const png = pngWith('Comment', 'hello')
    expect(() => cardFromPng(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))).toThrow('No character card')
  })
})
