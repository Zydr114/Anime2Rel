/**
 * 单调三次 Hermite 曲线（Fritsch & Carlson 1980）：经过给定控制点且不产生过冲，
 * 控制点之外按端点切线线性延伸。用于影调匹配的分位点映射。
 */
export interface MonotoneCurve {
  xs: number[]
  ys: number[]
  /** 各控制点处的切线斜率 */
  ms: number[]
}

/** xs 需严格递增，ys 需单调不减。 */
export function monotoneCurve(xs: readonly number[], ys: readonly number[]): MonotoneCurve {
  const n = xs.length
  const d = Array.from({ length: n - 1 }, (_, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const ms = Array.from({ length: n }, (_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2))
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      ms[i] = 0
      ms[i + 1] = 0
      continue
    }
    const a = ms[i] / d[i]
    const b = ms[i + 1] / d[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      ms[i] = t * a * d[i]
      ms[i + 1] = t * b * d[i]
    }
  }
  return { xs: [...xs], ys: [...ys], ms }
}

export function evalCurve(c: MonotoneCurve, x: number): number {
  const { xs, ys, ms } = c
  const n = xs.length
  if (x <= xs[0]) return ys[0] + ms[0] * (x - xs[0])
  if (x >= xs[n - 1]) return ys[n - 1] + ms[n - 1] * (x - xs[n - 1])
  let i = 0
  while (x > xs[i + 1]) i++
  const h = xs[i + 1] - xs[i]
  const t = (x - xs[i]) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * ms[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * ms[i + 1]
}
