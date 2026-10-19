import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'

export interface ExportedImage {
  width: number
  height: number
  data: number[]
  /** 下载的文件名与文件开头的几个字节 */
  name: string
  magic: number[]
}

/** 在导出步骤按当前格式（默认 PNG）导出，并解码为 RGBA 像素。 */
export async function exportPixels(page: Page): Promise<ExportedImage> {
  await page.getByTestId('step-export').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-image').click()
  const saved = await download
  const bytes = await readFile(await saved.path())
  const b64 = bytes.toString('base64')
  const image = await page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob()
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) }
  }, b64)
  return { ...image, name: saved.suggestedFilename(), magic: [...bytes.subarray(0, 4)] }
}

export function pixel(img: ExportedImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4
  return img.data.slice(i, i + 4)
}
