import { describe, expect, it } from 'vitest'
import {
  conformWarp,
  gridPoint,
  gridPoints,
  IDENTITY_WARP,
  isIdentityWarp,
  isValidWarp,
  moveCorner,
  moveGridPoint,
  rasterizeWarp,
  resampleGrid,
  resetCorner,
  unwarpPoint,
  warpMesh,
  warpPoint,
  type CharWarp,
} from './warp'

const perspective: CharWarp = {
  ...IDENTITY_WARP,
  corners: [
    { x: 0.2, y: 0 },
    { x: 0.8, y: 0 },
    { x: 1.1, y: 1 },
    { x: -0.1, y: 1 },
  ],
}

/** 4×4 网格中第 (1,1) 个控制点移到 (0.4, 0.3) */
const bent: CharWarp = { ...IDENTITY_WARP, points: IDENTITY_WARP.points.map((p, i) => (i === 5 ? { x: 0.4, y: 0.3 } : p)) }
const both: CharWarp = { ...bent, corners: perspective.corners }

const close = (a: { x: number; y: number }, b: { x: number; y: number }, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
}

describe('character warp', () => {
  it('leaves the default warp as the identity', () => {
    expect(isIdentityWarp(IDENTITY_WARP)).toBe(true)
    expect(isIdentityWarp({ ...IDENTITY_WARP, points: gridPoints(4) })).toBe(true)
    // 默认网格经过样条插值（含边界外延伸的一圈）仍是恒等变换
    for (const p of [
      { x: 0.37, y: 0.81 },
      { x: 0, y: 1 },
      { x: 0.99, y: 0.02 },
    ])
      close(gridPoint(IDENTITY_WARP, p), p)
  })

  it('moves control points exactly and maps the corners by the perspective', () => {
    close(warpPoint(bent, { x: 1 / 3, y: 1 / 3 }), { x: 0.4, y: 0.3 })
    close(warpPoint(bent, { x: 2 / 3, y: 2 / 3 }), { x: 2 / 3, y: 2 / 3 })
    perspective.corners.forEach((c, i) => close(warpPoint(perspective, IDENTITY_WARP.corners[i]), c))
    // 单应变换把正方形中心映射到四边形对角线的交点
    close(warpPoint(perspective, { x: 0.5, y: 0.5 }), { x: 0.5, y: 1 / 3 })
    // 网格变形之后再透视
    close(warpPoint(both, { x: 1 / 3, y: 1 / 3 }), warpPoint(perspective, { x: 0.4, y: 0.3 }))
  })

  it('inverts the warp through the mesh and clamps outside points to the outline', () => {
    for (const p of [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.93, y: 0.71 },
    ]) {
      const r = unwarpPoint(both, warpPoint(both, p))
      expect(r.inside).toBe(true)
      close(r.point, p, 3)
    }
    const outside = unwarpPoint(perspective, { x: 0.5, y: 1.3 })
    expect(outside.inside).toBe(false)
    close(outside.point, { x: 0.5, y: 1 }, 3)
  })

  it('resamples the grid without changing the shape', () => {
    const fine = resampleGrid(bent, 6)
    expect(fine.points).toHaveLength(36)
    for (const p of [
      { x: 0.25, y: 0.3 },
      { x: 0.6, y: 0.45 },
    ]) {
      const a = warpPoint(bent, p)
      const b = warpPoint(fine, p)
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.01)
    }
    expect(isIdentityWarp(resampleGrid(IDENTITY_WARP, 5))).toBe(true)
  })

  it('rasterizes the mesh over its bounds', () => {
    const seen: number[] = []
    rasterizeWarp(warpMesh(IDENTITY_WARP, 4), { x0: 0, y0: 0, x1: 1, y1: 1 }, 8, 8, (i, u, v) => {
      seen.push(i)
      expect(u).toBeCloseTo(((i % 8) + 0.5) / 8, 6)
      expect(v).toBeCloseTo((Math.floor(i / 8) + 0.5) / 8, 6)
    })
    expect(new Set(seen).size).toBe(64)
  })

  it('moves corners and control points to where they are dragged', () => {
    const target = { x: 0.15, y: -0.1 }
    const cornered = moveCorner(both, 0, target)!
    close(warpPoint(cornered, { x: 0, y: 0 }), target)
    // 其余三个角不动，网格变形不变
    close(warpPoint(cornered, { x: 1, y: 1 }), warpPoint(both, { x: 1, y: 1 }))
    expect(cornered.points).toBe(both.points)
    // 拖过对角线时四角交叉，不接受
    expect(moveCorner(both, 0, { x: 1.3, y: 1.2 })).toBeNull()
    // 透视之后的控制点落在拖到的位置
    const node = { x: 2 / 3, y: 1 / 3 }
    const moved = moveGridPoint(both, 6, { x: 0.7, y: 0.2 })!
    close(warpPoint(moved, node), { x: 0.7, y: 0.2 })
    // 四个角逐一去掉透视后回到只有网格变形
    const flat = [0, 1, 2, 3].reduce<CharWarp>((w, i) => resetCorner(w, i)!, both)
    for (const p of [node, { x: 0.2, y: 0.9 }]) close(warpPoint(flat, p), warpPoint(bent, p))
  })

  it('conforms warps read from files', () => {
    expect(conformWarp(undefined)).toBe(IDENTITY_WARP)
    expect(conformWarp({ grid: 7, points: 'x' })).toBe(IDENTITY_WARP)
    expect(conformWarp(JSON.parse(JSON.stringify(both)))).toEqual(both)
    // 四角交叉（不是凸四边形）时不变形
    const crossed = { ...perspective, corners: [perspective.corners[1], perspective.corners[0], perspective.corners[2], perspective.corners[3]] }
    expect(isValidWarp(crossed)).toBe(false)
    expect(conformWarp(crossed)).toBe(IDENTITY_WARP)
    expect(conformWarp({ ...bent, points: bent.points.map((p, i) => (i === 0 ? { x: -9, y: 0 } : p)) }).points[0]).toEqual({ x: -1, y: 0 })
  })
})
