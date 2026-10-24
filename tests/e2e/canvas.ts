import type { Page } from '@playwright/test'

export type DocPoint = readonly [number, number]

/** 截取页面，定位画布上的文档区域（与视口底色 #1a1a1a 的差异）。文档边缘不能接近底色。 */
async function docShot(page: Page): Promise<string> {
  return (await page.screenshot()).toString('base64')
}

/** 截取页面，按文档归一化坐标读取像素。 */
export async function docPixels(page: Page, points: readonly DocPoint[]): Promise<number[][]> {
  const shot = await docShot(page)
  return page.evaluate(
    async ({ data, points }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
      const isDoc = (x: number, y: number) => px(x, y).some((v) => Math.abs(v - 26) > 3)
      // 画布可见区域在左侧导航与右侧检查器之间
      const midY = Math.round(bmp.height / 2)
      let left = 130
      while (!isDoc(left, midY)) left++
      let right = 1080
      while (!isDoc(right, midY)) right--
      const midX = Math.round((left + right) / 2)
      let top = 0
      while (!isDoc(midX, top)) top++
      let bottom = bmp.height - 100
      while (!isDoc(midX, bottom)) bottom--
      return points.map(([u, v]) => px(Math.round(left + u * (right - left)), Math.round(top + v * (bottom - top))))
    },
    { data: shot, points },
  )
}

/** 截取页面，按文档归一化坐标读取一块矩形（x0、y0、x1、y1）的平均颜色。 */
export async function docRegion(page: Page, rect: readonly [number, number, number, number]): Promise<number[]> {
  const shot = await docShot(page)
  return page.evaluate(
    async ({ data, rect }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
      const isDoc = (x: number, y: number) => px(x, y).some((v) => Math.abs(v - 26) > 3)
      const midY = Math.round(bmp.height / 2)
      let left = 130
      while (!isDoc(left, midY)) left++
      let right = 1080
      while (!isDoc(right, midY)) right--
      const midX = Math.round((left + right) / 2)
      let top = 0
      while (!isDoc(midX, top)) top++
      let bottom = bmp.height - 100
      while (!isDoc(midX, bottom)) bottom--
      const x0 = Math.round(left + rect[0] * (right - left))
      const x1 = Math.round(left + rect[2] * (right - left))
      const y0 = Math.round(top + rect[1] * (bottom - top))
      const y1 = Math.round(top + rect[3] * (bottom - top))
      const data8 = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
      const sum = [0, 0, 0]
      let n = 0
      for (let i = 0; i < data8.length; i += 4) {
        for (let ch = 0; ch < 3; ch++) sum[ch] += data8[i + ch]
        n++
      }
      return sum.map((s) => s / Math.max(n, 1))
    },
    { data: shot, rect },
  )
}

/** 截取页面并读取若干页面坐标处的像素（RGB）。 */
export async function pagePixels(page: Page, points: readonly { x: number; y: number }[]): Promise<number[][]> {
  const shot = (await page.screenshot()).toString('base64')
  return page.evaluate(
    async ({ data, points }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      return points.map((p) => Array.from(ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data.slice(0, 3)))
    },
    { data: shot, points },
  )
}
