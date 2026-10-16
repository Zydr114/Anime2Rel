import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// 需要 dist 中带有自托管模型（pnpm test:e2e 会先下载）。
// 使用 docs/example.png：上部是天空，画面中下部是离镜头很近的人物。
const SKY = [0.12, 0.08] as const
const FACE = [0.42, 0.68] as const

test.setTimeout(120_000)

async function start(page: Page, renderer: string) {
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('drop-background').click()
  await (await chooser).setFiles({ name: 'example.png', mimeType: 'image/png', buffer: await readFile('docs/example.png') })
  await page.getByTestId('start').click()
  await page.getByTestId('step-depth').click()
}

async function waitDone(page: Page) {
  await expect(page.getByTestId('depth-job-background')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
}

/** 截取页面，按文档归一化坐标读取画布像素。文档区域通过与视口底色 #1a1a1a 的差异定位。 */
async function docPixels(page: Page, points: readonly (readonly [number, number])[]) {
  const shot = (await page.screenshot()).toString('base64')
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

test('depth, normal and sky debug views', async ({ page }, info) => {
  await start(page, info.project.metadata.renderer as string)
  await waitDone(page)
  await expect(page.getByTestId('depth-model-ready')).toContainText(/WebGPU|WASM/)

  const [skyRgb, faceRgb] = await docPixels(page, [SKY, FACE])
  // 取样点落在肤色上
  expect(faceRgb[0]).toBeGreaterThan(faceRgb[2] + 40)

  // 深度：天空最远（inferno 低端接近黑色），人物最近（高端偏黄白）
  await page.keyboard.press('v')
  const [skyDepth, faceDepth] = await docPixels(page, [SKY, FACE])
  expect(skyDepth[0] + skyDepth[1] + skyDepth[2]).toBeLessThan(60)
  expect(faceDepth[0]).toBeGreaterThan(200)

  // 法线：天空置信度为 0，显示压暗的朝向相机法线（蓝色分量最大）
  await page.keyboard.press('v')
  const [skyNormal, faceNormal] = await docPixels(page, [SKY, FACE])
  expect(skyNormal[2]).toBeGreaterThan(skyNormal[0] + 40)
  expect(faceNormal).not.toEqual(faceRgb)

  // 天空：天空区域染成蓝色，人物不染色
  await page.keyboard.press('v')
  const [skySky, faceSky] = await docPixels(page, [SKY, FACE])
  expect(skySky[2]).toBeGreaterThan(skySky[0] + 80)
  expect(faceSky[2]).toBeLessThan(faceSky[0])

  // 回到合成视图后与之前一致
  await page.keyboard.press('v')
  expect(await docPixels(page, [SKY])).toEqual([skyRgb])
})

test('falls back when a model variant is unavailable', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '推理与渲染后端无关，只在一个项目中运行')
  await page.route(/model_q4f16\.onnx/, (r) => r.fulfill({ status: 404, body: '' }))
  await start(page, 'webgpu')
  await waitDone(page)
  await expect(page.getByTestId('depth-model-ready')).toContainText('fp16')
  await expect(page.getByTestId('depth-failures')).toContainText('q4f16')
})

test('switching to WASM reloads the model', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '推理与渲染后端无关，只在一个项目中运行')
  await start(page, 'webgpu')
  await waitDone(page)
  await page.getByTestId('depth-device').click()
  await page.getByTestId('depth-device').getByText('WASM（CPU）').click()
  await expect(page.getByTestId('depth-model-ready')).toContainText('WASM · q4', { timeout: 90_000 })
  await waitDone(page)
})
