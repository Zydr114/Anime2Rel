/** float32 → IEEE 754 半精度（四舍五入到最近偶数），用于上传 RGBA16F 纹理。 */
const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

export function toHalf(value: number): number {
  f32[0] = value
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0) // Inf / NaN
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00 // 溢出为 Inf
  if (e <= 0) {
    // 次正规数或下溢为 0
    if (e < -10) return sign
    mant |= 0x800000
    const shift = 14 - e
    const half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const mid = 1 << (shift - 1)
    return sign | (half + (rem > mid || (rem === mid && half & 1) ? 1 : 0))
  }
  const half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // 进位可能溢出到指数位，结果仍然正确（最大变为 Inf）
  return sign | (half + (rem > 0x1000 || (rem === 0x1000 && half & 1) ? 1 : 0))
}

export function toHalfArray(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = toHalf(src[i])
  return out
}

/** 半精度 → float32，仅用于测试和调试。 */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024)
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * 2 ** (exp - 15) * (1 + mant / 1024)
}
