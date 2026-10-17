/** 光源分析的完整流程：准备场景 → 估计器 A–D → 融合（docs/Plan.md §3.2）。可在 Worker 和单测中复用。 */
import { estimateContours } from './contours'
import { fuse } from './fuse'
import type { AnalysisResult } from './protocol'
import { lumaContrast, prepareScene } from './scene'
import { estimateShading } from './shading'
import { estimateSkyGradient, skyStats } from './skyGradient'
import { detectVisibleLights } from './visible'

/**
 * @param rgba 分析分辨率的 sRGB 背景
 * @param depth、sky 已缩放到同一分辨率的深度与天空遮罩
 */
export function analyze(rgba: Uint8ClampedArray, width: number, height: number, depth: Float32Array, sky: Float32Array | null, fovDeg: number): AnalysisResult {
  const t0 = performance.now()
  const scene = prepareScene(rgba, width, height, depth, sky, fovDeg)
  const visible = detectVisibleLights(scene)
  const shading = estimateShading(scene)
  const contour = estimateContours(scene)
  const skyGradient = estimateSkyGradient(scene)
  const stats = skyStats(scene)
  const contrast = lumaContrast(scene)
  const fused = fuse({ scene, visible, shading, contour, skyGradient, sky: stats, contrast })
  return {
    size: { width, height },
    candidates: fused.candidates,
    ambient: Array.from(fused.ambient),
    diffuse: fused.diffuse,
    report: {
      visible: { count: visible.length, sky: visible.filter((v) => v.inSky).length },
      sh: shading ? { direction: shading.direction, confidence: shading.confidence, directionality: shading.directionality, samples: shading.samples } : null,
      contour: contour ? { angle: contour.angle, confidence: contour.confidence, samples: contour.samples } : null,
      skyGradient: skyGradient ? { angle: skyGradient.angle, confidence: skyGradient.confidence } : null,
      skyFraction: stats.fraction,
      skyVariation: stats.variation,
      contrast,
    },
    ms: performance.now() - t0,
  }
}
