import { PngWriter } from './png'

export type ImageFormat = 'png' | 'jpeg' | 'webp'
export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp']
const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
export const FORMAT_EXTENSION: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

/** JPEG、WebP 经由画布编码：Chromium 画布的边长与面积上限，以及格式本身的边长上限 */
const CANVAS_EDGE = 32767
const CANVAS_AREA = 268435456
const FORMAT_EDGE: Record<ImageFormat, number> = { png: 2 ** 31 - 1, jpeg: 65535, webp: 16383 }

/** 能否以这种格式编码这个尺寸的图像 */
export function canEncode(format: ImageFormat, width: number, height: number): boolean {
  const edge = Math.max(width, height)
  if (edge > FORMAT_EDGE[format]) return false
  return format === 'png' || (edge <= CANVAS_EDGE && width * height <= CANVAS_AREA)
}

/** 按条写入像素（紧密排列、首行在上的 RGBA8，从上到下），最后得到编码后的文件 */
export interface ImageWriter {
  write(rgba: Uint8Array, y: number, rows: number): Promise<void>
  finish(): Promise<Blob>
}

/**
 * PNG 用按条压缩的编码器，内存中只有压缩后的数据；JPEG、WebP 先画到整幅的画布上，再由浏览器编码。
 * quality 为 0–1，只用于 JPEG、WebP。
 */
export function createImageWriter(format: ImageFormat, width: number, height: number, quality: number): ImageWriter {
  if (format === 'png') {
    const png = new PngWriter(width, height)
    return { write: (rgba, _y, rows) => png.write(rgba, rows), finish: () => png.finish() }
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 画布')
  return {
    write: async (rgba, y, rows) => {
      const data = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, width * rows * 4)
      ctx.putImageData(new ImageData(data, width, rows), 0, y)
    },
    finish: async () => {
      const blob = await canvas.convertToBlob({ type: MIME[format], quality })
      // 浏览器不支持某种格式时会退回 PNG
      if (blob.type !== MIME[format]) throw new Error(`浏览器不支持编码 ${MIME[format]}`)
      return blob
    },
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function timestampedName(prefix: string, ext: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
}
