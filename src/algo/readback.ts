type PixelArray = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array

/** WebGPU 读回纹理时，每行字节数会对齐到 256。 */
export const WEBGPU_ROW_ALIGNMENT = 256

/** 计算读回数据的行跨度（以元素计）。alignment 为字节对齐，WebGL 传 1。 */
export function rowStride(width: number, channels: number, bytesPerElement: number, alignment: number): number {
  const rowBytes = width * channels * bytesPerElement
  return Math.ceil(rowBytes / alignment) * alignment / bytesPerElement
}

/**
 * 把 GPU 读回的像素整理为紧密排列、首行在上的数组。
 * WebGPU 的每行会补齐对齐（最后一行可能不补），WebGL 的行序是自下而上，两种情况都在这里处理。
 */
export function unpackRows<T extends PixelArray>(src: T, width: number, height: number, channels: number, stride: number, flipY: boolean): T {
  const rowLen = width * channels
  if (stride < rowLen) throw new Error(`invalid stride ${stride} < row ${rowLen}`)
  if (src.length < stride * (height - 1) + rowLen) throw new Error(`readback too small: ${src.length}`)
  if (stride === rowLen && !flipY && src.length === rowLen * height) return src
  const Ctor = src.constructor as new (n: number) => T
  const out = new Ctor(rowLen * height)
  for (let y = 0; y < height; y++) {
    const srcRow = flipY ? height - 1 - y : y
    out.set(src.subarray(srcRow * stride, srcRow * stride + rowLen), y * rowLen)
  }
  return out
}
