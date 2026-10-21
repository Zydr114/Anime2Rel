import { expect, test, type Page } from '@playwright/test'
import { exportPixels, pixel } from './export'
import { swiftshader } from './gpu'
import { makeImage } from './png'

// 背景 400×300：左半 sRGB 灰 128，右半纯蓝。
const background = makeImage(400, 300, (x) => (x < 200 ? [128, 128, 128, 255] : [0, 0, 255, 255]))
// 立绘 100×50：左半不透明红，右半完全透明。
const character = makeImage(100, 50, (x) => (x < 50 ? [255, 0, 0, 255] : [0, 0, 0, 0]))
// 不透明图片，作为立绘时应提示
const opaque = makeImage(64, 64, () => [0, 255, 0, 255])

// 默认摆放：scale = min(300×0.8/50, 400×0.9/100) = 3.6 → 立绘 360×180，中心 (200, 204)
const CHAR_Y = 204

async function choose(page: Page, testId: string, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(testId).click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
}

/** 立绘像素经过融合（颜色匹配、重光照）后不再是纯红，只检查仍以红色为主 */
function expectRed(px: number[]) {
  expect(px[0] - Math.max(px[1], px[2])).toBeGreaterThan(60)
}

test.slow(swiftshader, '软件渲染')

test.beforeEach(async ({ page }, info) => {
  const renderer = info.project.metadata.renderer as string
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
})

test('landing shows source link and requires a background', async ({ page }) => {
  await expect(page.getByTestId('source-link')).toHaveAttribute('href', /github\.com\/Zydr114\/Anime2Rel/)
  await expect(page.getByTestId('start')).toBeDisabled()
  // 主视觉的金色线条由入场动画逐段画出，最外一环最后画完
  await expect(page.getByTestId('hero-mark').locator('path[fill^="url(#hero-gold"]').last()).toHaveAttribute('d', /Z$/)
})

test('import, place, flip, undo and export', async ({ page }, info) => {
  await choose(page, 'drop-background', 'bg.png', background)
  await choose(page, 'drop-character', 'char.png', character)
  await page.getByTestId('start').click()
  await page.getByTestId('camera-confirm').click()
  await expect(page.getByTestId('inspector')).toBeVisible()

  // 关于对话框中的渲染后端应与项目设置一致
  await page.getByTestId('about-button').click()
  await expect(page.getByTestId('gpu-info')).toContainText(info.project.metadata.renderer === 'webgl' ? 'WebGL2' : 'WebGPU')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('about')).not.toHaveAttribute('open')

  let img = await exportPixels(page)
  expect([img.width, img.height]).toEqual([400, 300])
  expect(pixel(img, 50, 50)).toEqual([128, 128, 128, 255])
  expectRed(pixel(img, 100, CHAR_Y))
  expect(pixel(img, 300, CHAR_Y)).toEqual([0, 0, 255, 255])

  // H 水平翻转：红色移到右侧
  await page.getByTestId('step-place').click()
  await page.keyboard.press('h')
  img = await exportPixels(page)
  expectRed(pixel(img, 300, CHAR_Y))
  expect(pixel(img, 100, CHAR_Y)).toEqual([128, 128, 128, 255])

  // 撤销翻转
  await page.keyboard.press('Control+z')
  img = await exportPixels(page)
  expectRed(pixel(img, 100, CHAR_Y))
})

test('dragging the character is a single undo step', async ({ page }) => {
  await choose(page, 'drop-background', 'bg.png', background)
  await choose(page, 'drop-character', 'char.png', character)
  await page.getByTestId('start').click()
  await page.getByTestId('camera-confirm').click()
  await page.getByTestId('step-place').click()

  const x = page.getByTestId('char-x')
  const xValue = () => x.evaluate((el) => (el as HTMLInputElement).value)
  await expect.poll(xValue).toBe('200')
  const body = page.getByTestId('gizmo-body')
  const box = (await body.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + box.height / 2)
  await page.mouse.up()
  await expect.poll(xValue).not.toBe('200')

  const moved = await xValue()

  // 一次撤销恢复整个拖拽，一次重做回到拖拽结果
  await page.getByTestId('undo').click()
  await expect.poll(xValue).toBe('200')
  await page.getByTestId('redo').click()
  await expect.poll(xValue).toBe(moved)
})

test('an opaque character asks for confirmation', async ({ page }) => {
  await choose(page, 'drop-background', 'bg.png', background)
  await choose(page, 'drop-character', 'opaque.png', opaque)
  const dialog = page.locator('mdui-dialog[open]')
  await expect(dialog).toContainText('立绘没有透明区域')
  await dialog.getByText('取消').click()
  await expect(page.getByTestId('drop-character')).not.toContainText('opaque.png')
})
