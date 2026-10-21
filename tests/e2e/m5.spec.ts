import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { docPixels, type DocPoint } from './canvas'
import { exportPixels, pixel } from './export'
import { figure } from './figure'
import { swiftshader } from './gpu'
import { encodePng } from './png'

// 立绘是程序生成的简笔人物（240×480，蓝色裙子），默认摆放缩放 0.8、中心 (320, 278)，裙子中心在文档 (320, 293)。
// 太阳圆盘中心约在 (461, 58)；NEAR_SUN 在太阳下方地平线附近的地面上，会被天空的光晕提亮。
const W = 640
const H = 480
const DRESS: DocPoint = [320 / W, 293 / H]
const GROUND: DocPoint = [60 / W, 440 / H]
const NEAR_SUN: DocPoint = [460 / W, 215 / H]
const CORNER: DocPoint = [12 / W, 12 / H]

const sunny = (() => {
  const s = renderScene(W, H, {
    direction: pixelToRay({ x: 0.72 * W, y: 0.12 * H }, { width: W, height: H }, 60),
    color: [0.9, 0.8, 0.65],
    ambient: [0.15, 0.17, 0.2],
    sunInView: true,
  })
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
})()

/** 交换红、蓝通道的 2³ LUT */
const SWAP_CUBE = (() => {
  const lines = ['TITLE "swap"', 'LUT_3D_SIZE 2']
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${b} ${g} ${r}`)
  return Buffer.from(lines.join('\n'))
})()

test.setTimeout(150_000)
test.slow(swiftshader, '软件渲染')

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
  await page.getByTestId('camera-confirm').click()
  // 等光源分析和融合统计就绪，之后立绘的颜色不再变化
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await expect(page.getByTestId('fusion-color')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await page.getByTestId('step-adjust').click()
}

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    ;(el as HTMLElement & { value: number }).value = v
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }, value)
}

const segment = (page: Page, testId: string, value: string) => page.locator(`[data-testid="${testId}"] mdui-segmented-button[value="${value}"]`).click()

async function importLut(page: Page) {
  await segment(page, 'grade-tab', 'style')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('lut-import').click()
  await (await chooser).setFiles({ name: 'swap.cube', mimeType: 'text/plain', buffer: SWAP_CUBE })
  await expect(page.getByTestId('lut-name')).toHaveText('swap.cube')
}

const maxDiff = (a: number[], b: number[]) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])))
const luma = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

test('background adjustments leave the character alone, global ones apply to both, compare shows the ungraded image', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  const [dress, ground] = await docPixels(page, [DRESS, GROUND])

  await segment(page, 'adjust-level', 'background')
  await setSlider(page, 'adjust-exposure', -1)
  await expect.poll(async () => luma((await docPixels(page, [GROUND]))[0])).toBeLessThan(luma(ground) - 15)
  expect(maxDiff((await docPixels(page, [DRESS]))[0], dress)).toBeLessThan(4)

  await segment(page, 'adjust-level', 'global')
  await setSlider(page, 'adjust-exposure', 1)
  await expect.poll(async () => luma((await docPixels(page, [DRESS]))[0])).toBeGreaterThan(luma(dress) + 15)

  // 调色步骤中的前后对比去掉全部调色，保留融合
  await page.getByTestId('compare').click()
  await expect.poll(async () => maxDiff((await docPixels(page, [GROUND]))[0], ground)).toBeLessThan(4)
  expect(maxDiff((await docPixels(page, [DRESS]))[0], dress)).toBeLessThan(4)
  await page.getByTestId('compare').click()
  await expect.poll(async () => luma((await docPixels(page, [DRESS]))[0])).toBeGreaterThan(luma(dress) + 15)
})

test('LUT, bloom and vignette take effect and the export matches the preview', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  const [dress, nearSun, corner] = await docPixels(page, [DRESS, NEAR_SUN, CORNER])
  expect(dress[2]).toBeGreaterThan(dress[0] + 30)

  // 交换红蓝通道的 LUT 让蓝色裙子变红
  await importLut(page)
  await expect.poll(async () => (await docPixels(page, [DRESS]))[0][0]).toBeGreaterThan(dress[2] - 10)

  await page.getByTestId('step-lens').click()
  await setSlider(page, 'post-lens-vignette', -100)
  await expect.poll(async () => luma((await docPixels(page, [CORNER]))[0])).toBeLessThan(luma(corner) * 0.7)
  await setSlider(page, 'post-bloom-intensity', 100)
  await setSlider(page, 'post-bloom-threshold', 50)
  await expect.poll(async () => luma((await docPixels(page, [NEAR_SUN]))[0])).toBeGreaterThan(luma(nearSun) + 8)

  // 镜头步骤的画布上有焦点标记，回到调色步骤取预览
  await page.getByTestId('step-adjust').click()
  const preview = await docPixels(page, [DRESS, NEAR_SUN, CORNER])
  const img = await exportPixels(page)
  ;[DRESS, NEAR_SUN, CORNER].forEach(([u, v], i) => expect(maxDiff(pixel(img, Math.round(u * W), Math.round(v * H)), preview[i])).toBeLessThan(8))
})

test('presets apply as one undo step and round-trip through a file with the LUT embedded', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  const [ground] = await docPixels(page, [GROUND])
  await segment(page, 'grade-tab', 'presets')
  await page.getByTestId('preset-overcast-film').click()
  await expect(page.getByTestId('preset-overcast-film')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => maxDiff((await docPixels(page, [GROUND]))[0], ground)).toBeGreaterThan(10)
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('preset-overcast-film')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => maxDiff((await docPixels(page, [GROUND]))[0], ground)).toBeLessThan(4)

  // 导出带 LUT 的参数，清除后再导入
  await importLut(page)
  await segment(page, 'grade-tab', 'presets')
  const download = page.waitForEvent('download')
  await page.getByTestId('preset-export').click()
  await page.locator('mdui-dialog[open] input').fill('交换红蓝')
  await page.locator('mdui-dialog[open] mdui-button', { hasText: '导出' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('交换红蓝.json')
  const path = info.outputPath('preset.json')
  await file.saveAs(path)
  const text = await readFile(path, 'utf8')
  // 把 LUT 的 id 改掉：导入时必须使用内嵌的数据，而不是本次会话中已经登记的 LUT
  await writeFile(path, text.replaceAll(/"lut-[0-9a-f]{8}"/g, '"lut-00000000"'))

  await page.getByTestId('preset-clear').click()
  await segment(page, 'grade-tab', 'style')
  await expect(page.getByTestId('lut-name')).toHaveCount(0)
  await segment(page, 'grade-tab', 'presets')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('preset-import').click()
  await (await chooser).setFiles(path)
  await expect(page.getByTestId('preset-imported-0')).toHaveAttribute('aria-pressed', 'true')
  await segment(page, 'grade-tab', 'style')
  await expect(page.getByTestId('lut-name')).toHaveText('swap.cube')
  const [dress] = await docPixels(page, [DRESS])
  expect(dress[0]).toBeGreaterThan(dress[2])
})
