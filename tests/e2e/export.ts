import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'

export interface ExportedImage {
  width: number
  height: number
  data: number[]
}

/** 在导出步骤导出 PNG，并解码为 RGBA 像素。 */
export async function exportPixels(page: Page): Promise<ExportedImage> {
  await page.getByTestId('step-export').click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-png').click()
  const file = await (await download).path()
  const b64 = (await readFile(file)).toString('base64')
  return page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob()
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) }
  }, b64)
}

export function pixel(img: ExportedImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4
  return img.data.slice(i, i + 4)
}
