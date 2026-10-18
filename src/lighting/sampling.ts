/** 主线程上的取样：深度/天空（光源落点）、背景颜色（吸管）、立绘 alpha（对焦点）。 */
import type { Point, Size } from '@/algo/geometry'
import { normalizeColor, srgbToLinear } from '@/algo/color'
import type { Vec3 } from '@/algo/sh'
import type { DepthResult } from '@/depth/protocol'
import { getAsset } from '@/state/assets'

/** 文档坐标处的逆深度和天空遮罩（最近邻）；没有深度结果时返回中间值。 */
export function sampleDepth(result: DepthResult | undefined, p: Point, doc: Size): { depth: number; sky: number } {
  if (!result) return { depth: 0.5, sky: 0 }
  const { width: gw, height: gh } = result.guideSize
  const x = Math.min(gw - 1, Math.max(0, Math.floor((p.x / doc.width) * gw)))
  const y = Math.min(gh - 1, Math.max(0, Math.floor((p.y / doc.height) * gh)))
  const i = y * gw + x
  return { depth: result.depth[i], sky: result.sky?.[i] ?? 0 }
}

const PICK_MAX_EDGE = 1024
const pickCache = new Map<string, { data: Uint8ClampedArray; width: number; height: number }>()

function pickImage(assetId: string) {
  let img = pickCache.get(assetId)
  if (img) return img
  const asset = getAsset(assetId)
  if (!asset) return null
  const k = Math.min(1, PICK_MAX_EDGE / Math.max(asset.width, asset.height))
  const width = Math.max(1, Math.round(asset.width * k))
  const height = Math.max(1, Math.round(asset.height * k))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(asset.bitmap, 0, 0, width, height)
  img = { data: ctx.getImageData(0, 0, width, height).data, width, height }
  pickCache.set(assetId, img)
  return img
}

/** 吸管：背景在文档坐标 p 附近 5×5 像素的平均颜色（线性，最大分量为 1）。 */
export function pickColor(assetId: string, p: Point, doc: Size): Vec3 | null {
  const img = pickImage(assetId)
  if (!img) return null
  const cx = Math.floor((p.x / doc.width) * img.width)
  const cy = Math.floor((p.y / doc.height) * img.height)
  const sum = [0, 0, 0]
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) {
      const i = (Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4
      for (let c = 0; c < 3; c++) sum[c] += srgbToLinear(img.data[i + c] / 255)
    }
  return normalizeColor(sum)
}

/** 立绘 UV 处的 alpha（[0,1]，最近邻）；UV 在立绘外时为 0。 */
export function pickAlpha(assetId: string, uv: Point): number {
  if (uv.x < 0 || uv.x >= 1 || uv.y < 0 || uv.y >= 1) return 0
  const img = pickImage(assetId)
  if (!img) return 0
  const x = Math.floor(uv.x * img.width)
  const y = Math.floor(uv.y * img.height)
  return img.data[(y * img.width + x) * 4 + 3] / 255
}
