/**
 * 精确欧氏距离变换（Felzenszwalb & Huttenlocher 2012）：先逐列、再逐行做一维平方距离变换（下包络抛物线），
 * 复杂度 O(n)。
 */

/** 一维平方距离变换：d[q] = min_p ((q - p)² + f[p]) */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue
    // 跳过之前的无穷值，使 v 中只保留有限的抛物线
    if (f[v[k]] === Infinity) {
      v[k] = q
      continue
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  if (f[v[0]] === Infinity) {
    d.fill(Infinity, 0, n)
    return
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/**
 * 每个像素到最近的“背景”像素（mask 为 0）的欧氏距离。背景像素自身为 0；
 * 整幅图都是前景时返回 Infinity。
 */
export function distanceTransform(mask: ArrayLike<number>, w: number, h: number): Float32Array {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const grid = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? Infinity : 0
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    dt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    dt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x])
  }
  return out
}
