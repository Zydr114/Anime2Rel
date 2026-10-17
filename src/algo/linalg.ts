/** 小规模稠密线性代数：求解线性方程组、带 Huber 权重的迭代重加权最小二乘（IRLS）。 */

/**
 * 高斯消元（部分选主元）求解 n×n 方程组 A·x = b。A 按行优先存放，不会被修改。
 * 奇异或接近奇异时返回 null。
 */
export function solveLinear(a: ArrayLike<number>, b: ArrayLike<number>, n: number): Float64Array | null {
  const m = Float64Array.from(a)
  const x = Float64Array.from(b)
  let scale = 0
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(m[i]))
  const tiny = Math.max(scale, 1e-300) * 1e-12
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * n + col]) > Math.abs(m[pivot * n + col])) pivot = r
    if (Math.abs(m[pivot * n + col]) <= tiny) return null
    if (pivot !== col) {
      for (let c = 0; c < n; c++) [m[col * n + c], m[pivot * n + c]] = [m[pivot * n + c], m[col * n + c]]
      ;[x[col], x[pivot]] = [x[pivot], x[col]]
    }
    const p = m[col * n + col]
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col] / p
      if (f === 0) continue
      for (let c = col; c < n; c++) m[r * n + c] -= f * m[col * n + c]
      x[r] -= f * x[col]
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]
    for (let c = r + 1; c < n; c++) s -= m[r * n + c] * x[c]
    x[r] = s / m[r * n + r]
  }
  return x
}

export interface LeastSquaresOptions {
  /** 每个参数的岭回归系数，按 AᵀWA 对角线均值的倍数计 */
  ridge?: ArrayLike<number>
  /** IRLS 迭代次数，0 表示普通加权最小二乘 */
  iterations?: number
  /** Huber 阈值，以残差的稳健标准差（1.4826·MAD）为单位 */
  huber?: number
}

export interface LeastSquaresFit {
  beta: Float64Array
  /** 最终权重（先验权重 × 稳健权重） */
  weights: Float64Array
  /** 按最终权重计算的决定系数 */
  r2: number
}

function median(values: Float64Array): number {
  const s = values.slice().sort()
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 加权正规方程 (AᵀWA + Λ)·β = AᵀWy。rows 为 n×p 行优先的设计矩阵。 */
function weightedSolve(rows: Float64Array, ys: Float64Array[], w: Float64Array, p: number, ridge?: ArrayLike<number>): Float64Array[] | null {
  const n = w.length
  const ata = new Float64Array(p * p)
  const aty = ys.map(() => new Float64Array(p))
  for (let i = 0; i < n; i++) {
    const wi = w[i]
    if (wi <= 0) continue
    const o = i * p
    for (let r = 0; r < p; r++) {
      const ar = rows[o + r] * wi
      for (let c = r; c < p; c++) ata[r * p + c] += ar * rows[o + c]
      for (let k = 0; k < ys.length; k++) aty[k][r] += ar * ys[k][i]
    }
  }
  for (let r = 0; r < p; r++) for (let c = 0; c < r; c++) ata[r * p + c] = ata[c * p + r]
  if (ridge) {
    let diag = 0
    for (let r = 0; r < p; r++) diag += ata[r * p + r]
    diag /= p
    for (let r = 0; r < p; r++) ata[r * p + r] += (ridge[r] ?? 0) * diag
  }
  const out: Float64Array[] = []
  for (const rhs of aty) {
    const x = solveLinear(ata, rhs, p)
    if (!x) return null
    out.push(x)
  }
  return out
}

function weightedR2(rows: Float64Array, y: Float64Array, w: Float64Array, beta: Float64Array, p: number): number {
  let sw = 0
  let sy = 0
  for (let i = 0; i < w.length; i++) {
    sw += w[i]
    sy += w[i] * y[i]
  }
  if (sw <= 0) return 0
  const mean = sy / sw
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < w.length; i++) {
    let pred = 0
    for (let c = 0; c < p; c++) pred += rows[i * p + c] * beta[c]
    ssRes += w[i] * (y[i] - pred) ** 2
    ssTot += w[i] * (y[i] - mean) ** 2
  }
  return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0
}

/**
 * 带先验权重的稳健线性回归：IRLS + Huber 权重，压低离群点（如反照率突变、投影阴影）的影响。
 * @param rows n×p 设计矩阵（行优先）
 */
export function robustLeastSquares(rows: Float64Array, y: Float64Array, prior: Float64Array, p: number, options: LeastSquaresOptions = {}): LeastSquaresFit | null {
  const { ridge, iterations = 6, huber = 1.345 } = options
  const n = prior.length
  const w = prior.slice()
  let beta = weightedSolve(rows, [y], w, p, ridge)?.[0]
  if (!beta) return null
  const res = new Float64Array(n)
  for (let it = 0; it < iterations; it++) {
    let count = 0
    for (let i = 0; i < n; i++) {
      let pred = 0
      for (let c = 0; c < p; c++) pred += rows[i * p + c] * beta[c]
      res[i] = Math.abs(y[i] - pred)
      if (prior[i] > 0) count++
    }
    if (count === 0) break
    const active = new Float64Array(count)
    for (let i = 0, k = 0; i < n; i++) if (prior[i] > 0) active[k++] = res[i]
    const sigma = 1.4826 * median(active)
    if (sigma <= 1e-12) break
    const delta = huber * sigma
    for (let i = 0; i < n; i++) w[i] = prior[i] * (res[i] <= delta ? 1 : delta / res[i])
    const next = weightedSolve(rows, [y], w, p, ridge)?.[0]
    if (!next) break
    beta = next
  }
  return { beta, weights: w, r2: weightedR2(rows, y, w, beta, p) }
}

/** 用给定权重对多组目标值做加权最小二乘（共用同一设计矩阵）。 */
export function weightedLeastSquares(rows: Float64Array, ys: Float64Array[], w: Float64Array, p: number, ridge?: ArrayLike<number>): Float64Array[] | null {
  return weightedSolve(rows, ys, w, p, ridge)
}
