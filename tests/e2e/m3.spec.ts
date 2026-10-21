import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { docPixels, pagePixels } from './canvas'
import { exportPixels, pixel } from './export'
import { figure } from './figure'
import { swiftshader } from './gpu'
import { encodePng, makeImage } from './png'

// 立绘是程序生成的简笔人物（240×480，蓝色裙子 sRGB (70,110,205)）。默认摆放缩放 0.8，中心 (320, 278)，
// 裙子中心在文档 (320, 293)。
const DRESS: readonly [number, number] = [0.5, 293 / 480]
const DRESS_COLOR = [70, 110, 205]
const W = 640
const H = 480

const sunny = (() => {
  const s = renderScene(W, H, {
    direction: pixelToRay({ x: 0.72 * W, y: 0.12 * H }, { width: W, height: H }, 60),
    color: [0.9, 0.8, 0.65],
    ambient: [0.15, 0.17, 0.2],
    sunInView: true,
  })
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
})()
// 左半亮、右半暗的背景，用于检查立绘移动后颜色跟着周围变化
const split = makeImage(W, H, (x) => (x < W / 2 ? [200, 200, 200, 255] : [50, 50, 50, 255]))

test.setTimeout(120_000)
test.slow(swiftshader, '软件渲染')

async function open(page: Page, renderer: string, background: Buffer) {
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
  for (const [testId, name, buffer] of [
    ['drop-background', 'bg.png', background],
    ['drop-character', 'figure.png', figure(240, 480)],
  ] as const) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId(testId).click()
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
  }
  await page.getByTestId('start').click()
  await page.getByTestId('camera-confirm').click()
}

async function fusionReady(page: Page) {
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('fusion-color')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
}

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    ;(el as HTMLElement & { value: number }).value = v
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }, value)
}

const maxDiff = (a: number[], b: readonly number[]) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])))
const luma = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

test('fusion parameters, before/after compare, normal view and export', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string, sunny)
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await fusionReady(page)
  const dress = async () => (await docPixels(page, [DRESS]))[0]

  // 融合改变了立绘颜色；前后对比显示原图
  await expect.poll(async () => maxDiff(await dress(), DRESS_COLOR)).toBeGreaterThan(12)
  const fused = await dress()
  await page.getByTestId('compare').click()
  await expect.poll(async () => maxDiff(await dress(), DRESS_COLOR)).toBeLessThan(6)
  await page.getByTestId('compare').click()
  await expect.poll(async () => maxDiff(await dress(), fused)).toBeLessThan(4)

  // 所有强度归零时与原图一致，重置后恢复
  for (const id of ['colorMatch-whiteBalance', 'colorMatch-tone', 'colorMatch-chroma', 'colorMatch-saturation', 'relight-strength', 'relight-rim', 'edge-lightWrap', 'edge-noise'])
    await setSlider(page, `fusion-${id}`, 0)
  await expect.poll(async () => maxDiff(await dress(), DRESS_COLOR)).toBeLessThan(6)
  await page.getByTestId('fusion-reset').click()
  await expect.poll(async () => maxDiff(await dress(), fused)).toBeLessThan(4)

  // 法线视图：裙子中间大致朝向相机（偏蓝）
  await page.getByTestId('fusion-show-normals').click()
  await expect.poll(async () => (await dress())[2]).toBeGreaterThan(180)
  const normal = await dress()
  expect(normal[2] - Math.max(normal[0], normal[1])).toBeGreaterThan(40)
  await page.getByTestId('fusion-show-normals').click()

  // 导出使用融合结果，不受前后对比影响
  await page.getByTestId('compare').click()
  const img = await exportPixels(page)
  expect(maxDiff(pixel(img, 320, 293), DRESS_COLOR)).toBeGreaterThan(12)
})

test('moving the character updates its colors from the background around it', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string, split)
  await fusionReady(page)
  await page.getByTestId('step-place').click()
  const body = page.getByTestId('gizmo-body')

  /** 拖动立绘，使其中心移到文档横坐标 x，返回拖动期间的平均帧间隔（毫秒） */
  async function dragTo(x: number) {
    const box = (await body.boundingBox())!
    const zoom = box.width / 192
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const dx = (x - (await page.getByTestId('char-x').evaluate((el) => Number((el as HTMLInputElement).value)))) * zoom
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const start = Date.now()
    const steps = 30
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y)
    await page.mouse.up()
    return (Date.now() - start) / steps
  }
  const dressAt = async () => {
    const box = (await body.boundingBox())!
    return (await pagePixels(page, [{ x: box.x + box.width / 2, y: box.y + box.height * 0.54 }]))[0]
  }

  const interval = await dragTo(160)
  console.log(`[m3] 拖动立绘的平均步进间隔 ${interval.toFixed(1)} ms`)
  await expect.poll(async () => luma(await dressAt())).toBeGreaterThan(luma(DRESS_COLOR) + 5)
  const bright = luma(await dressAt())
  await dragTo(480)
  await expect.poll(async () => luma(await dressAt())).toBeLessThan(bright - 20)
})
