// 按条写入的 PNG 编码器，用于导出原分辨率的大图：8 位 RGB，逐行 Paeth 滤波，用浏览器的 CompressionStream 压缩。
// 像素一条一条地写入并立即压缩，不需要整幅图像同时在内存中。
import { crc32 } from './crc32'

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
/** 压缩后的数据攒到这个大小再写成一个 IDAT 块 */
const IDAT_SIZE = 1 << 20
const PAETH = 4

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export class PngWriter {
  readonly width: number
  readonly height: number
  private readonly parts: Uint8Array<ArrayBuffer>[] = []
  private readonly writer: WritableStreamDefaultWriter<BufferSource>
  private readonly collected: Promise<void>
  /** 上一行与当前行的 RGB，第一行之前视为全 0 */
  private prev: Uint8Array
  private cur: Uint8Array
  private rows = 0

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    // 8 位、RGB、Deflate、逐行滤波、不隔行
    ihdr.set([8, 2, 0, 0, 0], 8)
    this.parts.push(new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])))
    const stream = new CompressionStream('deflate')
    this.writer = stream.writable.getWriter()
    this.collected = this.collect(stream.readable.getReader())
    this.prev = new Uint8Array(width * 3)
    this.cur = new Uint8Array(width * 3)
  }

  private async collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    let pending: Uint8Array[] = []
    let size = 0
    const flush = () => {
      if (size) this.parts.push(chunk('IDAT', concat(pending, size)))
      pending = []
      size = 0
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending.push(value)
      size += value.length
      if (size >= IDAT_SIZE) flush()
    }
    flush()
  }

  /** 写入接下来的 rows 行：紧密排列、首行在上的 RGBA8，忽略 alpha */
  async write(rgba: Uint8Array, rows: number): Promise<void> {
    if (this.rows + rows > this.height) throw new Error('PNG 写入的行数超过图像高度')
    const n = this.width * 3
    const out = new Uint8Array(rows * (n + 1))
    for (let y = 0; y < rows; y++) {
      const cur = this.cur
      const prev = this.prev
      for (let x = 0, s = y * this.width * 4; x < n; x += 3, s += 4) {
        cur[x] = rgba[s]
        cur[x + 1] = rgba[s + 1]
        cur[x + 2] = rgba[s + 2]
      }
      const o = y * (n + 1) + 1
      out[o - 1] = PAETH
      for (let i = 0; i < n; i++) {
        const a = i >= 3 ? cur[i - 3] : 0
        const b = prev[i]
        const c = i >= 3 ? prev[i - 3] : 0
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        out[o + i] = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      this.prev = cur
      this.cur = prev
    }
    this.rows += rows
    await this.writer.ready
    await this.writer.write(out)
  }

  async finish(): Promise<Blob> {
    if (this.rows !== this.height) throw new Error('PNG 写入的行数与图像高度不一致')
    await this.writer.close()
    await this.collected
    this.parts.push(chunk('IEND', new Uint8Array(0)))
    return new Blob(this.parts, { type: 'image/png' })
  }
}
