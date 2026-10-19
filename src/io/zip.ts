// 极简 ZIP 读写，用于 .a2r 工程文件。写入时不压缩（图片本身已经压缩过），文件内容以 Blob 拼接，不复制进内存；
// 读取时支持不压缩和 Deflate 两种方式，用户解压后重新打包的工程也能打开。不支持 ZIP64（单个工程不超过 4 GB）。

export interface ZipEntry {
  name: string
  data: Blob
}

export class ZipError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
/** 通用标志位 11：文件名为 UTF-8 */
const UTF8 = 0x0800

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return [time, date]
}

/** 把若干文件打包为不压缩的 ZIP */
export async function writeZip(entries: ZipEntry[], type = 'application/zip'): Promise<Blob> {
  const encoder = new TextEncoder()
  const [time, date] = dosTime(new Date())
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(new Uint8Array(await entry.data.arrayBuffer()))
    const size = entry.data.size
    if (offset + size > 0xffffffff) throw new ZipError('工程文件超过 4 GB')

    const local = new Uint8Array(30 + name.length)
    const l = new DataView(local.buffer)
    l.setUint32(0, LOCAL, true)
    l.setUint16(4, 20, true)
    l.setUint16(6, UTF8, true)
    l.setUint16(10, time, true)
    l.setUint16(12, date, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, size, true)
    l.setUint32(22, size, true)
    l.setUint16(26, name.length, true)
    local.set(name, 30)

    const head = new Uint8Array(46 + name.length)
    const c = new DataView(head.buffer)
    c.setUint32(0, CENTRAL, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, UTF8, true)
    c.setUint16(12, time, true)
    c.setUint16(14, date, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, size, true)
    c.setUint32(24, size, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    head.set(name, 46)

    parts.push(local, entry.data)
    central.push(head)
    offset += local.length + size
  }
  const centralSize = central.reduce((n, h) => n + h.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, END, true)
  e.setUint16(8, entries.length, true)
  e.setUint16(10, entries.length, true)
  e.setUint32(12, centralSize, true)
  e.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type })
}

async function view(blob: Blob, start: number, length: number): Promise<DataView> {
  const buffer = await blob.slice(start, start + length).arrayBuffer()
  if (buffer.byteLength < length) throw new ZipError('ZIP 文件不完整')
  return new DataView(buffer)
}

/** 读取 ZIP 的文件列表；文件内容按需从原 Blob 中切出（Deflate 压缩的条目会被解压） */
export async function readZip(blob: Blob): Promise<Map<string, () => Promise<Blob>>> {
  // 目录结尾记录在文件末尾，后面可能跟着最长 65535 字节的注释
  const tailLength = Math.min(blob.size, 22 + 0xffff)
  const tail = await view(blob, blob.size - tailLength, tailLength)
  let endAt = -1
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END) {
      endAt = i
      break
    }
  }
  if (endAt < 0) throw new ZipError('不是 ZIP 文件')
  const count = tail.getUint16(endAt + 10, true)
  const centralSize = tail.getUint32(endAt + 12, true)
  const centralOffset = tail.getUint32(endAt + 16, true)
  const dir = await view(blob, centralOffset, centralSize)
  const decoder = new TextDecoder()
  const files = new Map<string, () => Promise<Blob>>()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new ZipError('ZIP 目录损坏')
    const method = dir.getUint16(p + 10, true)
    const compressed = dir.getUint32(p + 20, true)
    const nameLength = dir.getUint16(p + 28, true)
    const extraLength = dir.getUint16(p + 30, true)
    const commentLength = dir.getUint16(p + 32, true)
    const localOffset = dir.getUint32(p + 42, true)
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength))
    p += 46 + nameLength + extraLength + commentLength
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方式：${name}`)
    files.set(name, async () => {
      const local = await view(blob, localOffset, 30)
      if (local.getUint32(0, true) !== LOCAL) throw new ZipError('ZIP 文件头损坏')
      const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true)
      const data = blob.slice(start, start + compressed)
      if (method === 0) return data
      return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
    })
  }
  return files
}
