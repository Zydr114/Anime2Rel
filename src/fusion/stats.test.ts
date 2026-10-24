import { describe, expect, it } from 'vitest'
import { sampleGroundColor } from './stats'

// 文档 640×480，统计网格 64×48（每格 10 像素）：深度处处是 z = 3
const width = 64
const height = 48
const docSize = { width: 640, height: 480 }
const focal = 554
const z = 3
const depth = new Float32Array(width * height).fill(1 / z)
const sky = new Float32Array(width * height)
const linear = new Float32Array(width * height * 3)
// 地面平面过接地点 (320, 400)（相机空间），法线朝上
const groundY = ((240 - 400) / focal) * z
const plane: [number, number, number] = [0, groundY, -z]
const up: [number, number, number] = [0, 1, 0]

for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const py = (y + 0.5) * 10
    // 离地面平面 ±0.085 米的像素是草地绿，其余是墙面红
    const Y = ((240 - py) / focal) * z
    const near = Math.abs(Y - groundY) <= 0.085
    const c = near ? [0.1, 0.6, 0.1] : [0.7, 0.1, 0.1]
    linear.set(c, (y * width + x) * 3)
  }

const request = {
  linear,
  depth,
  sky,
  width,
  height,
  size: docSize,
  point: { x: 320, y: 400 },
  plane,
  up,
  radius: 120,
  tolerance: 0.085,
  depthScale: { a: 1, b: 0, far: 300 },
  focal,
}

describe('ground colour', () => {
  it('averages only the pixels lying on the ground plane', () => {
    const color = sampleGroundColor(request)!
    expect(color).not.toBeNull()
    expect(color[1]).toBeGreaterThan(0.5)
    expect(color[0]).toBeLessThan(0.2)
  })

  it('skips sky and invalid depth', () => {
    const noisy = { ...request, sky: Float32Array.from(sky, (_, i) => (i % width < 32 ? 1 : 0)) }
    // 左半边标记成天空后，颜色仍来自右边的地面
    const color = sampleGroundColor(noisy)!
    expect(color[1]).toBeGreaterThan(0.5)
    const broken = { ...request, depth: Float32Array.from(depth, (_, i) => (i % 2 ? -1 : depth[i])) }
    expect(sampleGroundColor(broken)).not.toBeNull()
    expect(sampleGroundColor({ ...request, depth: new Float32Array(width * height).fill(0) })).toBeNull()
    expect(sampleGroundColor({ ...request, depth: null })).toBeNull()
  })

  it('returns null when too few pixels are on the ground', () => {
    // 半径太小，取样区域里凑不够 40 个像素
    expect(sampleGroundColor({ ...request, radius: 20 })).toBeNull()
    // 容差太小，接地点附近没有像素落在平面上
    expect(sampleGroundColor({ ...request, tolerance: 0.001 })).toBeNull()
  })
})
