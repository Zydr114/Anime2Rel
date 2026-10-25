import { describe, expect, it } from 'vitest'
import { lampPosition } from './model'

const doc = { width: 1000, height: 800 }
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

describe('lampPosition', () => {
  it('puts the lamp beside the head, on the roomier side of the picture', () => {
    // 人物在左半：灯在右侧，包围盒之外、靠近顶边
    const left = lampPosition(rect(100, 200, 300, 700), doc)
    expect(left.x).toBeCloseTo(320)
    expect(left.y).toBeCloseTo(250)
    // 人物在右半：灯在左侧
    const right = lampPosition(rect(700, 200, 900, 700), doc)
    expect(right.x).toBeCloseTo(680)
  })

  it('stays inside the picture and falls back to the upper middle without a character', () => {
    const p = lampPosition(rect(-200, -300, 400, 900), doc)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.y).toBeGreaterThanOrEqual(0)
    expect(p.x).toBeLessThanOrEqual(doc.width)
    expect(lampPosition([], doc)).toEqual({ x: 500, y: 240 })
  })
})
