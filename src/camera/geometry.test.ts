import { describe, expect, it } from 'vitest'
import { project } from '@/fusion/warp'
import { horizonLine, linesFromCamera, mirrorHomography, orientationFromHorizon, solveLines, standingHeight, standingPerspective, standingScale } from './geometry'
import { DEFAULT_CAMERA, type CameraDoc } from './model'

const size = { width: 800, height: 600 }
const deg = Math.PI / 180
const tilted: CameraDoc = { ...DEFAULT_CAMERA, fovDeg: 50, pitch: -15 * deg, roll: 4 * deg }

describe('camera geometry', () => {
  it('round-trips the horizon', () => {
    const h = horizonLine(tilted, size)
    const a = { x: h.point.x - 300 * h.dir.x, y: h.point.y - 300 * h.dir.y }
    const b = { x: h.point.x + 200 * h.dir.x, y: h.point.y + 200 * h.dir.y }
    const o = orientationFromHorizon(b, a, size, tilted)
    expect(o.pitch).toBeCloseTo(tilted.pitch, 6)
    expect(o.roll).toBeCloseTo(tilted.roll, 6)
    // 俯视时地平线在画面中心以上
    expect(h.point.y).toBeLessThan(size.height / 2)
  })

  it('recovers the camera from two pairs of parallel lines', () => {
    for (const axis of ['horizontal', 'vertical'] as const) {
      const solved = solveLines(linesFromCamera(tilted, size, axis), size)
      expect(solved.ok).toBe(true)
      if (!solved.ok) continue
      expect(solved.camera.fovDeg).toBeCloseTo(50, 4)
      expect(solved.camera.pitch).toBeCloseTo(tilted.pitch, 4)
      expect(solved.camera.roll).toBeCloseTo(tilted.roll, 4)
    }
    // 参考方向：红轴沿第一组线
    const turned = solveLines(linesFromCamera({ ...tilted, yaw: 30 * deg }, size), size)
    expect(turned.ok && turned.camera.yaw).toBeCloseTo(30 * deg, 4)
    // 相机水平时竖直线在画面上平行，求不出消失点
    expect(solveLines(linesFromCamera(DEFAULT_CAMERA, size, 'vertical'), size)).toEqual({ ok: false, error: 'parallel-second' })
  })

  it('mirrors about the water plane', () => {
    const foot = { x: 420, y: 450 }
    // 相机水平：关于过接地点的水平线上下翻转
    const level = mirrorHomography(DEFAULT_CAMERA, size, foot)
    const q = project(level, { x: 300, y: 380 })
    expect(q.x).toBeCloseTo(300, 6)
    expect(q.y).toBeCloseTo(520, 6)
    // 俯视：接地点不动，镜像两次回到原处，倒影比人物短
    const h = mirrorHomography(tilted, size, foot)
    const f = project(h, foot)
    expect(f.x).toBeCloseTo(foot.x, 6)
    expect(f.y).toBeCloseTo(foot.y, 6)
    const head = { x: 420, y: 250 }
    const back = project(h, project(h, head))
    expect(back.x).toBeCloseTo(head.x, 4)
    expect(back.y).toBeCloseTo(head.y, 4)
    const image = project(h, head)
    expect(Math.hypot(image.x - foot.x, image.y - foot.y)).toBeLessThan(foot.y - head.y)
  })

  it('keeps the size of a standing figure in the scene', () => {
    const c = { ...DEFAULT_CAMERA, height: 1.6 }
    // 相机水平时，头顶在地平线上的人与相机一样高
    expect(standingHeight(c, size, { x: 400, y: 500 }, 200)).toBeCloseTo(1.6, 6)
    // 向地平线移动一半的距离，画面中的大小减半
    expect(standingScale(c, size, { x: 400, y: 500 }, { x: 300, y: 400 }, 200)).toBeCloseTo(0.5, 6)
    expect(standingScale(c, size, { x: 400, y: 500 }, { x: 400, y: 250 }, 200)).toBeNull()
  })

  it('stands the character up in perspective', () => {
    const foot = { x: 400, y: 520 }
    const level = standingPerspective(DEFAULT_CAMERA, size, foot, 300)!
    const p = project(level, { x: 330, y: 260 })
    expect(p.x).toBeCloseTo(330, 6)
    expect(p.y).toBeCloseTo(260, 6)
    // 俯视：上宽下窄，脚下不动，头顶高度不变
    const h = standingPerspective({ ...DEFAULT_CAMERA, pitch: -20 * deg }, size, foot, 300)!
    const width = (y: number) => project(h, { x: 450, y }).x - project(h, { x: 350, y }).x
    expect(width(foot.y - 300)).toBeGreaterThan(width(foot.y) + 1)
    expect(project(h, foot).y).toBeCloseTo(foot.y, 6)
    expect(project(h, { x: foot.x, y: foot.y - 300 }).y).toBeCloseTo(foot.y - 300, 6)
  })
})
