import { describe, expect, it } from 'vitest'
import { estimateForeground } from './matte'

describe('foreground estimation', () => {
  it('removes a white matte from the semi-transparent rim and ignores the black transparent area', () => {
    // 红色圆盘（半径 20），外圈 4 像素半透明，颜色混入了白色底色；完全透明处为黑色
    const w = 64
    const red = [0.8, 0.1, 0.1]
    const rgb = new Float32Array(w * w * 3)
    const alpha = new Float32Array(w * w)
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const a = Math.min(1, Math.max(0, (24 - Math.hypot(x + 0.5 - 32, y + 0.5 - 32)) / 4))
        alpha[i] = a
        if (a > 0) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = a * red[c] + (1 - a)
      }
    const { foreground, background } = estimateForeground(rgb, alpha, w, w)
    let checked = 0
    for (let i = 0; i < w * w; i++) {
      if (alpha[i] < 0.2 || alpha[i] > 0.8) continue
      expect(foreground[i * 3]).toBeGreaterThan(0.7)
      expect(foreground[i * 3 + 1]).toBeLessThan(0.2)
      expect(background[i * 3 + 1]).toBeGreaterThan(0.8)
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })
})
