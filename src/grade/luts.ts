// LUT 登记表。LUT 数据可能有几 MB，不放进可撤销的文档；文档只保存 id 和名称。
// id 由数据内容的哈希得到，同一个 LUT 重复导入（或随预设导入）时不会重复保存。
import type { CubeLut } from './cube'
import type { LutRef } from './model'

export interface RegisteredLut extends CubeLut {
  id: string
}

const luts = new Map<string, RegisteredLut>()

/** FNV-1a（32 位），对尺寸、定义域和数据的二进制内容计算 */
function hashLut(lut: CubeLut): string {
  const head = new Float32Array([lut.size, ...lut.domainMin, ...lut.domainMax])
  let h = 0x811c9dc5
  for (const array of [head, lut.data]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function registerLut(lut: CubeLut, name: string): LutRef {
  const id = `lut-${hashLut(lut)}`
  if (!luts.has(id)) luts.set(id, { ...lut, id })
  return { id, name }
}

export function getLut(id: string): RegisteredLut | undefined {
  return luts.get(id)
}
