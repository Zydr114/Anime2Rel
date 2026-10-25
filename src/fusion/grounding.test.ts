import { describe, expect, it } from 'vitest'
import type { Vec3 } from '@/algo/sh'
import { groundColor, groundOcclusion, type GroundImage, type GroundSampling } from './grounding'

// 相机在原点、地面在 1.5 米下方：下半幅是绿色地面，上半幅是 8 米外的红墙；接地点（5 米外）旁边立着一个蓝色箱子
const size = { width: 640, height: 480 }
const focal = 500
const width = 64
const height = 48
const box = (x: number, y: number) => x >= 28 && x < 36 && y >= 37 && y < 42

function scene(skyBand = false): GroundImage {
  const linear = new Float32Array(width * height * 3)
  const depth = new Float32Array(width * height)
  const sky = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const ry = (size.height / 2 - ((y + 0.5) / height) * size.height) / focal
      let color: Vec3 = [0.6, 0.1, 0.1]
      let z = 8
      if (box(x, y)) {
        color = [0.1, 0.1, 0.6]
        z = 3.5
      } else if (ry < 0 && -1.5 / ry < 8) {
        color = [0.1, 0.5, 0.1]
        z = -1.5 / ry
      }
      linear.set(color, i * 3)
      // 深度校准 a = 1、b = 0：归一化逆深度就是 1 / 距离
      depth[i] = 1 / z
      if (skyBand && y >= 30) sky[i] = 1
    }
  return { width, height, linear, depth, sky }
}

const sampling = (radius: number): GroundSampling => ({ point: [0, -1.5, -5], up: [0, 1, 0], radius, focal, size, depthScale: { a: 1, b: 0, far: 1000 } })

describe('grounding', () => {
  it('averages only ground pixels around the contact point', () => {
    const color = groundColor(scene(), sampling(2.5))!
    expect(color[0]).toBeCloseTo(0.1, 5)
    expect(color[1]).toBeCloseTo(0.5, 5)
    expect(color[2]).toBeCloseTo(0.1, 5)
  })

  it('gives up with too few ground pixels or without depth', () => {
    expect(groundColor(scene(), sampling(0.2))).toBeNull()
    expect(groundColor(scene(true), sampling(2.5))).toBeNull()
    expect(groundColor({ ...scene(), depth: null }, sampling(2.5))).toBeNull()
  })

  it('occludes most at the ground and on downward faces', () => {
    expect(groundOcclusion(0.8, 0.4, 0, -1)).toBeCloseTo(0.2)
    expect(groundOcclusion(0.8, 0.4, 0.5, -1)).toBe(1)
    expect(groundOcclusion(0.8, 0.4, 0.1, -1)).toBeLessThan(groundOcclusion(0.8, 0.4, 0.1, 1))
    expect(groundOcclusion(0.8, 0.4, 0.1, -1)).toBeLessThan(groundOcclusion(0.8, 0.4, 0.3, -1))
  })
})
