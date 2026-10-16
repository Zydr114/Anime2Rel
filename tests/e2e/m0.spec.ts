import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
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

async function exportPixels(page: Page) {
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

function pixel(img: { width: number; data: number[] }, x: number, y: number) {
  const i = (y * img.width + x) * 4
  return img.data.slice(i, i + 4)
}

test.beforeEach(async ({ page }, info) => {
  const renderer = info.project.metadata.renderer as string
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
})

test('landing shows source link and requires a background', async ({ page }) => {
  await expect(page.getByTestId('source-link')).toHaveAttribute('href', /github\.com\/Zydr114\/Anime2Rel/)
  await expect(page.getByTestId('start')).toBeDisabled()
})

test('import, place, flip, undo and export', async ({ page }, info) => {
  await choose(page, 'drop-background', 'bg.png', background)
  await choose(page, 'drop-character', 'char.png', character)
  await page.getByTestId('start').click()
  await expect(page.getByTestId('inspector')).toBeVisible()

  // 关于对话框中的渲染后端应与项目设置一致
  await page.getByTestId('about-button').click()
  await expect(page.getByTestId('gpu-info')).toContainText(info.project.metadata.renderer === 'webgl' ? 'WebGL2' : 'WebGPU')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('about')).not.toHaveAttribute('open')

  let img = await exportPixels(page)
  expect([img.width, img.height]).toEqual([400, 300])
  expect(pixel(img, 50, 50)).toEqual([128, 128, 128, 255])
  expect(pixel(img, 100, CHAR_Y)).toEqual([255, 0, 0, 255])
  expect(pixel(img, 300, CHAR_Y)).toEqual([0, 0, 255, 255])

  // H 水平翻转：红色移到右侧
  await page.getByTestId('step-character').click()
  await page.keyboard.press('h')
  img = await exportPixels(page)
  expect(pixel(img, 300, CHAR_Y)).toEqual([255, 0, 0, 255])
  expect(pixel(img, 100, CHAR_Y)).toEqual([128, 128, 128, 255])

  // 撤销翻转
  await page.keyboard.press('Control+z')
  img = await exportPixels(page)
  expect(pixel(img, 100, CHAR_Y)).toEqual([255, 0, 0, 255])
})

test('dragging the character is a single undo step', async ({ page }) => {
  await choose(page, 'drop-background', 'bg.png', background)
  await choose(page, 'drop-character', 'char.png', character)
  await page.getByTestId('start').click()
  await page.getByTestId('step-character').click()

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
