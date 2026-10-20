import { describe, expect, it } from 'vitest'
import { sceneDepth } from '@/algo/camera'
import type { DepthResult } from '@/depth/protocol'
import { calibrateDepth } from './depthScale'
import { groundPoint } from './geometry'
import { DEFAULT_CAMERA, type CameraDoc } from './model'

const size = { width: 640, height: 480 }
const guide = { width: 160, height: 120 }

/** 地面按 1/z = a·d + b 生成深度，左下角有一个比地面近的物体，视平线以上是天空 */
function scene(camera: CameraDoc, a: number, b: number): DepthResult {
  const depth = new Float32Array(guide.width * guide.height)
  const sky = new Float32Array(guide.width * guide.height)
  for (let y = 0; y < guide.height; y++)
    for (let x = 0; x < guide.width; x++) {
      const i = y * guide.width + x
      const g = groundPoint(camera, size, { x: ((x + 0.5) * size.width) / guide.width, y: ((y + 0.5) * size.height) / guide.height })
      if (!g) {
        sky[i] = 1
        continue
      }
      // 深度模型的误差：±3% 的起伏
      const d = (-1 / g[2] - b) / a
      depth[i] = d * (1 + 0.03 * Math.sin(x * 0.7 + y * 1.3)) + (x < 50 && y > 70 ? 0.3 : 0)
    }
  return { depth, sky, guideSize: guide } as unknown as DepthResult
}

describe('depth calibration', () => {
  it('fits the inverse depth to the calibrated ground and ignores objects standing on it', () => {
    const camera = { ...DEFAULT_CAMERA, pitch: -0.2, height: 1.6 }
    const scale = calibrateDepth(camera, size, scene(camera, 0.6, 0.005))
    expect(scale.state).toBe('ground')
    // 1/z = a·d + b 的两个系数都接近真实值，远处限制在照片中最远的景物
    expect(scale.a).toBeCloseTo(0.6, 1)
    expect(sceneDepth(0.5, scale)).toBeCloseTo(1 / (0.6 * 0.5 + 0.005), 0)
    expect(scale.far).toBeLessThan(300 * camera.height)
  })

  it('falls back to the scaled pseudo depth without visible ground', () => {
    const camera = { ...DEFAULT_CAMERA, pitch: 0.7, height: 2 }
    const scale = calibrateDepth(camera, size, scene(camera, 0.6, 0.005))
    expect(scale.state).toBe('noGround')
    // 最近处在相机高度的距离上
    expect(sceneDepth(1, scale)).toBeCloseTo(2, 6)
    expect(calibrateDepth(camera, size, undefined).state).toBe('noDepth')
  })
})
