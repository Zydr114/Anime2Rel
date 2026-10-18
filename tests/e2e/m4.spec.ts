import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { docPixels } from './canvas'
import { exportPixels, pixel, type ExportedImage } from './export'
import { figure } from './figure'
import { encodePng } from './png'

// 立绘是程序生成的简笔人物（240×480），默认摆放缩放 0.8、中心 (320, 278)。
// 文档 y = 293 处裙子左边缘约在 x = 272；左腿中部在 (301, 420)。太阳圆盘中心 (461, 58)，半径约 17 px。
const W = 640
const H = 480
const DRESS_ROW = { y: 293, x0: 260, x1: 286 }
const SUN_ROW = { y: 58, x0: 428, x1: 462 }
const LEG: readonly [number, number] = [301 / W, 420 / H]
const SKY = { x: 80, y: 40 }

const sunny = (() => {
  const s = renderScene(W, H, {
    direction: pixelToRay({ x: 0.72 * W, y: 0.12 * H }, { width: W, height: H }, 60),
    color: [0.9, 0.8, 0.65],
    ambient: [0.15, 0.17, 0.2],
    sunInView: true,
  })
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
})()

test.setTimeout(150_000)

async function open(page: Page, renderer: string) {
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
  for (const [testId, name, buffer] of [
    ['drop-background', 'bg.png', sunny],
    ['drop-character', 'figure.png', figure(240, 480)],
  ] as const) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId(testId).click()
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
  }
  await page.getByTestId('start').click()
  // 等深度、光源分析和融合统计都就绪，之后立绘的颜色不再变化；自动对焦也需要立绘的不透明包围盒
  await page.getByTestId('step-depth').click()
  for (const layer of ['background', 'character'])
    await expect(page.getByTestId(`depth-job-${layer}`)).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-character').click()
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 30_000 })
  await page.getByTestId('step-focus').click()
}

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    ;(el as HTMLElement & { value: number }).value = v
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }, value)
}

/** 在景深步骤的画布上点击文档坐标 (x, y) */
async function clickDoc(page: Page, p: { x: number; y: number }) {
  const box = (await page.getByTestId('focus-overlay').boundingBox())!
  await page.mouse.click(box.x + (p.x / W) * box.width, box.y + (p.y / H) * box.height)
}

const diff = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

/** 一行像素中相邻像素颜色差的最大值，用来衡量边缘的清晰程度 */
const edgeStep = (row: number[][]) => Math.max(...row.slice(1).map((p, i) => diff(p, row[i])))

function exportedRow(img: ExportedImage, { y, x0, x1 }: { y: number; x0: number; x1: number }) {
  return Array.from({ length: x1 - x0 + 1 }, (_, i) => pixel(img, x0 + i, y))
}

async function exportFromFocus(page: Page) {
  const img = await exportPixels(page)
  await page.getByTestId('step-focus').click()
  return img
}

test('depth of field keeps the focused character sharp, follows the clicked focus point and applies to export', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  await expect(page.getByTestId('focus-target-kind')).toHaveAttribute('data-kind', 'auto')
  await expect(page.getByTestId('focus-marker')).toBeVisible()

  // 景深默认开启并对焦在立绘上：与关闭景深相比，远处的太阳边缘变模糊，立绘边缘和边缘内侧不变
  await page.getByTestId('focus-dof-enabled').click()
  const sharp = await exportFromFocus(page)
  await page.getByTestId('focus-dof-enabled').click()
  const focused = await exportFromFocus(page)
  const sunSharp = edgeStep(exportedRow(sharp, SUN_ROW))
  expect(edgeStep(exportedRow(focused, SUN_ROW))).toBeLessThan(sunSharp * 0.7)
  const dressSharp = edgeStep(exportedRow(sharp, DRESS_ROW))
  expect(edgeStep(exportedRow(focused, DRESS_ROW))).toBeGreaterThan(dressSharp * 0.85)
  expect(diff(pixel(focused, 278, DRESS_ROW.y), pixel(sharp, 278, DRESS_ROW.y))).toBeLessThan(8)

  // 点击远处的天空对焦：立绘离焦变模糊
  await setSlider(page, 'focus-dof-aperture', 3)
  await clickDoc(page, SKY)
  await expect(page.getByTestId('focus-target-kind')).toHaveAttribute('data-kind', 'background')
  const far = await exportFromFocus(page)
  expect(edgeStep(exportedRow(far, DRESS_ROW))).toBeLessThan(dressSharp * 0.5)

  // 前后对比显示直接贴上去的结果：立绘边缘恢复清晰
  const previewRow = () => docPixels(page, Array.from({ length: DRESS_ROW.x1 - DRESS_ROW.x0 + 1 }, (_, i) => [(DRESS_ROW.x0 + i) / W, DRESS_ROW.y / H] as const))
  const blurred = edgeStep(await previewRow())
  await page.getByTestId('compare').click()
  await expect.poll(async () => edgeStep(await previewRow())).toBeGreaterThan(blurred * 2)
  await page.getByTestId('compare').click()

  // 点在立绘上对焦到立绘的该处；“对焦到立绘”恢复自动
  await clickDoc(page, { x: 320, y: 293 })
  await expect(page.getByTestId('focus-target-kind')).toHaveAttribute('data-kind', 'character')
  await page.getByTestId('focus-auto').click()
  await expect(page.getByTestId('focus-target-kind')).toHaveAttribute('data-kind', 'auto')
})

test('depth occlusion hides the character behind nearer ground, shows a mask and is skipped by compare', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  const leg = async () => (await docPixels(page, [LEG]))[0]
  const skin = await leg()
  expect(skin[0]).toBeGreaterThan(170)

  // 立绘放到远处（深度 30%），脚下的地面比立绘近，开启遮挡后挡住双腿
  await setSlider(page, 'fusion-depth', 30)
  await page.getByTestId('focus-occlusion-enabled').click()
  await expect.poll(async () => diff(await leg(), skin)).toBeGreaterThan(120)
  const occluded = await leg()

  await page.getByTestId('focus-show-mask').click()
  await expect
    .poll(async () => {
      const p = await leg()
      return p[0] - p[1]
    })
    .toBeGreaterThan(40)
  await page.getByTestId('focus-show-mask').click()

  await page.getByTestId('compare').click()
  await expect.poll(async () => (await leg())[0]).toBeGreaterThan(170)
  await page.getByTestId('compare').click()

  await page.getByTestId('focus-occlusion-enabled').click()
  await expect.poll(async () => diff(await leg(), occluded)).toBeGreaterThan(120)
})
