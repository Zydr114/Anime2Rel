// 导入文件（预设、工程）的字段检查。导入的内容不可信：逐字段检查类型并限制在界面允许的范围内，缺少或无效的字段取默认值。

export type Json = Record<string, unknown>

export const record = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback)
export const hue = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? ((v % 360) + 360) % 360 : fallback)
export const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const HEX = /^#[0-9a-f]{6}$/i
export const hex = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback)
export const oneOf = <T extends string | number>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback)
export const text = (v: unknown, fallback: string, maxLength: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, maxLength) : fallback)

type Primitive = number | boolean | string

/**
 * 按默认值逐个检查扁平对象的字段：数值限制在 ranges 给出的范围内（未列出的为 [0,1]），
 * 字符串只能取 options 列出的值，布尔值检查类型。
 */
export function fields<T extends { [K in keyof T]: Primitive }>(
  v: unknown,
  defaults: T,
  ranges: { [K in keyof T]?: readonly [number, number] } = {},
  options: { [K in keyof T]?: readonly T[K][] } = {},
): T {
  const src = record(v)
  const range = ranges as Record<string, readonly [number, number] | undefined>
  const choices = options as Record<string, readonly string[] | undefined>
  const out: Record<string, Primitive> = {}
  for (const [key, fallback] of Object.entries(defaults as Record<string, Primitive>)) {
    if (typeof fallback === 'number') {
      const [lo, hi] = range[key] ?? [0, 1]
      out[key] = num(src[key], fallback, lo, hi)
    } else if (typeof fallback === 'boolean') out[key] = bool(src[key], fallback)
    else out[key] = oneOf(src[key], choices[key] ?? [fallback], fallback)
  }
  return out as T
}
