import { describe, expect, it } from 'vitest'
import type { Point } from '@/algo/geometry'
import { dragOrigin, grabOffset, guideGeometry, yawToward } from './guides'
import { DEFAULT_CAMERA } from './model'

const size = { width: 800, height: 600 }
const camera = { ...DEFAULT_CAMERA, pitch: -0.25, roll: 0.05, yaw: 0.4 }
const box = (origin: Point) => guideGeometry(camera, size, 'box', origin)!
const length = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

describe('reference guides', () => {
  it('keeps the grabbed point under the pointer and its size on screen', () => {
    const origin = { x: 400, y: 480 }
    // 按住地面上红轴的末端、立方体中绿轴的末端拖到别处：按下的那一点始终在光标下
    for (const [kind, axis] of [
      ['ground', 'x'],
      ['box', 'y'],
    ] as const) {
      const offset = grabOffset(camera, size, kind, origin, box(origin).axes[axis]!)
      const target = { x: 560, y: 330 }
      const tip = box(dragOrigin(camera, size, offset, target)!).axes[axis]!
      expect(tip.x).toBeCloseTo(target.x, 6)
      expect(tip.y).toBeCloseTo(target.y, 6)
    }
    // 拖远之后在画面上大小基本不变
    const far = { x: 300, y: 300 }
    const ratio = length(box(far).axes.origin, box(far).axes.y!) / length(box(origin).axes.origin, box(origin).axes.y!)
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(1.15)
    // 红轴的末端拖到哪里，红轴就指向哪里
    const geo = box(origin)
    expect(yawToward(camera, size, origin, geo.axes.x!, 'x')).toBeCloseTo(camera.yaw, 6)
    expect(yawToward(camera, size, origin, geo.axes.z!, 'z')).toBeCloseTo(camera.yaw, 6)
  })
})
