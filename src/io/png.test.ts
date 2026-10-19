import { describe, expect, it } from 'vitest'
import { PngWriter } from './png'

/** 解析 PNG 的块并还原 Paeth 滤波，得到 RGB */
async function decode(bytes: Uint8Array<ArrayBuffer>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  let width = 0
  let height = 0
  const idat: Uint8Array<ArrayBuffer>[] = []
  for (let o = 8; o < bytes.length; ) {
    const length = view.getUint32(o)
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8))
    const data = bytes.subarray(o + 8, o + 8 + length)
    if (type === 'IHDR') [width, height] = [view.getUint32(o + 8), view.getUint32(o + 12)]
    if (type === 'IDAT') idat.push(data)
    o += 12 + length
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
  const n = width * 3
  const rgb = new Uint8Array(height * n)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (n + 1)]).toBe(4)
    for (let i = 0; i < n; i++) {
      const a = i >= 3 ? rgb[y * n + i - 3] : 0
      const b = y > 0 ? rgb[(y - 1) * n + i] : 0
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * n + i - 3] : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      rgb[y * n + i] = raw[y * (n + 1) + 1 + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
    }
  }
  return { width, height, rgb }
}

describe('PngWriter', () => {
  it('writes bands that decode back to the original pixels', async () => {
    const [w, h] = [37, 23]
    const rgba = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 131 + ((i / 97) | 0) * 7) & 0xff))
    const png = new PngWriter(w, h)
    await png.write(rgba.subarray(0, w * 10 * 4), 10)
    await png.write(rgba.subarray(w * 10 * 4), h - 10)
    const out = await decode(new Uint8Array(await (await png.finish()).arrayBuffer()))
    expect([out.width, out.height]).toEqual([w, h])
    expect(out.rgb).toEqual(rgba.filter((_, i) => i % 4 !== 3))
  })
})
