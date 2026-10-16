/** 把 sRGB RGBA8 像素编码为 PNG。 */
export async function encodePng(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 2D 画布')
  const data = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength)
  ctx.putImageData(new ImageData(data, width, height), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
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
