import { analyzeAlpha } from '@/algo/alpha'
import { fitWithin } from '@/algo/geometry'

export type DecodeErrorKind = 'not-image' | 'heic' | 'decode'

export class DecodeError extends Error {
  readonly kind: DecodeErrorKind
  readonly fileName: string

  constructor(kind: DecodeErrorKind, fileName: string) {
    super(`${kind}: ${fileName}`)
    this.kind = kind
    this.fileName = fileName
  }
}

export interface DecodedImage {
  name: string
  bitmap: ImageBitmap
  sourceWidth: number
  sourceHeight: number
  downscaled: boolean
  transparentRatio: number
  hasTransparency: boolean
}

const ALPHA_SAMPLE_EDGE = 512
/** 按 EXIF 方向摆正，转换到 sRGB，保留直通 alpha */
const BITMAP_OPTIONS: ImageBitmapOptions = { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' }

function isHeic(file: File): boolean {
  return /hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

/**
 * 解码图片：按 EXIF 方向摆正，转换到 sRGB，保留直通 alpha。
 * 超过 maxEdge 的图片会等比缩小到 GPU 纹理上限以内。
 */
export async function decodeImage(file: File, maxEdge: number): Promise<DecodedImage> {
  if (file.type && !file.type.startsWith('image/')) throw new DecodeError('not-image', file.name)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, BITMAP_OPTIONS)
  } catch {
    throw new DecodeError(isHeic(file) ? 'heic' : 'decode', file.name)
  }

  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  const target = fitWithin({ width: sourceWidth, height: sourceHeight }, maxEdge)
  const downscaled = target.width !== sourceWidth || target.height !== sourceHeight
  if (downscaled) {
    const resized = await createImageBitmap(bitmap, { ...BITMAP_OPTIONS, resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' })
    bitmap.close()
    bitmap = resized
  }

  const sample = fitWithin({ width: bitmap.width, height: bitmap.height }, ALPHA_SAMPLE_EDGE)
  const canvas = new OffscreenCanvas(sample.width, sample.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new DecodeError('decode', file.name)
  ctx.drawImage(bitmap, 0, 0, sample.width, sample.height)
  const { transparentRatio, hasTransparency } = analyzeAlpha(ctx.getImageData(0, 0, sample.width, sample.height).data)

  return { name: file.name, bitmap, sourceWidth, sourceHeight, downscaled, transparentRatio, hasTransparency }
}

/** 按原分辨率解码，与 decodeImage 的处理一致（导出时从原图裁剪超出纹理上限的背景） */
export function decodeOriginal(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, BITMAP_OPTIONS)
}
