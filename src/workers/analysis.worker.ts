/** 光源分析 Worker（docs/Plan.md §3.2）：在分析分辨率上运行估计器 A–D 并融合候选。 */
import * as Comlink from 'comlink'
import { resizeBilinear } from '@/algo/raster'
import { analyze } from '@/analysis/analyze'
import type { AnalysisRequest, AnalysisResult, AnalysisWorkerApi } from '@/analysis/protocol'

const api: AnalysisWorkerApi = {
  async analyze({ bitmap, depth, sky, depthSize, fovDeg }: AnalysisRequest): Promise<AnalysisResult> {
    const { width, height } = bitmap
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建 2D 画布')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    const rgba = ctx.getImageData(0, 0, width, height).data
    const d = resizeBilinear(depth, depthSize.width, depthSize.height, width, height)
    const s = sky ? resizeBilinear(sky, depthSize.width, depthSize.height, width, height) : null
    return analyze(rgba, width, height, d, s, fovDeg)
  },
}

Comlink.expose(api)
