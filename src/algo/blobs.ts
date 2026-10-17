/** 二值区域：8 邻接连通域标记、局部膨胀。 */

export interface Region {
  label: number
  /** 区域内像素的索引 */
  pixels: Int32Array
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** 质心（像素中心坐标） */
  cx: number
  cy: number
}

/** 8 邻接连通域，返回每个区域的像素和包围盒。 */
export function labelRegions(mask: Uint8Array, w: number, h: number): { labels: Int32Array; regions: Region[] } {
  const labels = new Int32Array(w * h)
  const regions: Region[] = []
  const stack = new Int32Array(w * h)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const label = regions.length + 1
    const pixels: number[] = []
    let minX = w
    let minY = h
    let maxX = 0
    let maxY = 0
    let sx = 0
    let sy = 0
    let sp = 0
    labels[start] = label
    stack[sp++] = start
    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      pixels.push(i)
      sx += x + 0.5
      sy += y + 0.5
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const j = yy * w + xx
          if (mask[j] && !labels[j]) {
            labels[j] = label
            stack[sp++] = j
          }
        }
      }
    }
    regions.push({ label, pixels: Int32Array.from(pixels), minX, minY, maxX, maxY, cx: sx / pixels.length, cy: sy / pixels.length })
  }
  return { labels, regions }
}

/**
 * 区域外侧宽度为 r 的环带（切比雪夫距离），返回像素索引。
 * 只在区域包围盒附近计算，适合对少量小区域逐个处理。
 */
export function outerRing(region: Region, labels: Int32Array, w: number, h: number, r: number): Int32Array {
  const x0 = Math.max(0, region.minX - r)
  const y0 = Math.max(0, region.minY - r)
  const x1 = Math.min(w - 1, region.maxX + r)
  const y1 = Math.min(h - 1, region.maxY + r)
  const cw = x1 - x0 + 1
  const ch = y1 - y0 + 1
  // 行方向、列方向各做一次滑动最大值（二值膨胀）
  const inside = new Uint8Array(cw * ch)
  for (const i of region.pixels) inside[(Math.floor(i / w) - y0) * cw + ((i % w) - x0)] = 1
  const rows = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let v = 0
      for (let k = Math.max(0, x - r); k <= Math.min(cw - 1, x + r) && !v; k++) v = inside[y * cw + k]
      rows[y * cw + x] = v
    }
  const out: number[] = []
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      if (inside[y * cw + x]) continue
      let v = 0
      for (let k = Math.max(0, y - r); k <= Math.min(ch - 1, y + r) && !v; k++) v = rows[k * cw + x]
      const i = (y + y0) * w + (x + x0)
      if (v && labels[i] !== region.label) out.push(i)
    }
  return Int32Array.from(out)
}
