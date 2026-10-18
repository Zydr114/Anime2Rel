/**
 * .cube LUT 解析（Adobe Cube LUT Specification 1.0，兼容 DaVinci Resolve 的 LUT_3D_INPUT_RANGE）。
 * 一维 LUT 展开为 33³ 的三维 LUT，着色器只处理三维的情况。
 */

export interface CubeLut {
  title: string
  /** 三维网格的边长 */
  size: number
  /** size³ × RGB，R 变化最快，其次 G、B */
  data: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

/** 三维 LUT 边长的上限（129³ 的半精度纹理约 17 MB） */
export const MAX_CUBE_SIZE = 129
/** 一维 LUT 展开后的边长 */
const EXPANDED_SIZE = 33

export class CubeError extends Error {}

const numbers = (parts: string[], count: number, line: number): number[] => {
  const values = parts.slice(0, count).map(Number)
  if (values.length !== count || values.some((v) => !Number.isFinite(v))) throw new CubeError(`第 ${line} 行的数值无法识别`)
  return values
}

export function parseCube(text: string): CubeLut {
  let title = ''
  let size1 = 0
  let size3 = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const key = parts[0].toUpperCase()
    const rest = parts.slice(1)
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '')
    else if (key === 'LUT_1D_SIZE') size1 = numbers(rest, 1, i + 1)[0]
    else if (key === 'LUT_3D_SIZE') size3 = numbers(rest, 1, i + 1)[0]
    else if (key === 'DOMAIN_MIN') domainMin = numbers(rest, 3, i + 1) as [number, number, number]
    else if (key === 'DOMAIN_MAX') domainMax = numbers(rest, 3, i + 1) as [number, number, number]
    else if (key === 'LUT_1D_INPUT_RANGE' || key === 'LUT_3D_INPUT_RANGE') {
      const [lo, hi] = numbers(rest, 2, i + 1)
      domainMin = [lo, lo, lo]
      domainMax = [hi, hi, hi]
    } else if (/^[-+.\d]/.test(key)) values.push(...numbers(parts, 3, i + 1))
    // 其他关键字（如 Resolve 的 LUT_IN_VIDEO_RANGE）忽略
  }
  if (domainMax.some((v, c) => v <= domainMin[c])) throw new CubeError('DOMAIN_MAX 必须大于 DOMAIN_MIN')
  if (size3) {
    if (!Number.isInteger(size3) || size3 < 2 || size3 > MAX_CUBE_SIZE) throw new CubeError(`三维 LUT 的边长 ${size3} 不受支持（2–${MAX_CUBE_SIZE}）`)
    if (values.length !== size3 ** 3 * 3) throw new CubeError(`数据有 ${values.length / 3} 行，应为 ${size3 ** 3} 行`)
    return { title, size: size3, data: new Float32Array(values), domainMin, domainMax }
  }
  if (size1) {
    if (!Number.isInteger(size1) || size1 < 2 || size1 > 65536) throw new CubeError(`一维 LUT 的长度 ${size1} 不受支持`)
    if (values.length !== size1 * 3) throw new CubeError(`数据有 ${values.length / 3} 行，应为 ${size1} 行`)
    return { title, size: EXPANDED_SIZE, data: expand1d(values, size1), domainMin, domainMax }
  }
  throw new CubeError('缺少 LUT_3D_SIZE 或 LUT_1D_SIZE')
}

/** 一维 LUT（各通道独立）→ 三维网格。网格点与一维表都均匀分布在定义域上 */
function expand1d(values: number[], n: number): Float32Array {
  const lookup = (x: number, c: number) => {
    const p = x * (n - 1)
    const i = Math.min(n - 2, Math.floor(p))
    const t = p - i
    return values[i * 3 + c] * (1 - t) + values[(i + 1) * 3 + c] * t
  }
  const s = EXPANDED_SIZE
  const data = new Float32Array(s ** 3 * 3)
  for (let b = 0; b < s; b++)
    for (let g = 0; g < s; g++)
      for (let r = 0; r < s; r++) {
        const k = ((b * s + g) * s + r) * 3
        data[k] = lookup(r / (s - 1), 0)
        data[k + 1] = lookup(g / (s - 1), 1)
        data[k + 2] = lookup(b / (s - 1), 2)
      }
  return data
}
