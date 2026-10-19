import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { readZip } from '@/io/zip'
import { exportPixels, type ExportedImage } from './export'
import { figure } from './figure'
import { encodePng } from './png'

const W = 640
const H = 480

const scene = (() => {
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

test.setTimeout(240_000)

/** 等深度、光源分析和融合统计就绪，之后画面不再变化 */
async function settle(page: Page) {
  await page.getByTestId('step-depth').click()
  for (const job of ['depth-job-background', 'depth-job-character']) await expect(page.getByTestId(job)).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-character').click()
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 30_000 })
  // 立绘深度就绪后法线在后台重新生成
  await page.waitForTimeout(1000)
}

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    ;(el as HTMLElement & { value: number }).value = v
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }, value)
}

const xValue = (page: Page) => page.getByTestId('char-x').evaluate((el) => (el as HTMLInputElement).value)

const maxDiff = (a: ExportedImage, b: ExportedImage) => {
  let max = 0
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]))
  return max
}

test('a project survives a reload and round-trips through a .a2r file', async ({ page }, info) => {
  const url = info.project.metadata.renderer === 'webgl' ? '/?renderer=webgl' : '/'
  await page.goto(url)
  // 新的浏览器上下文没有自动保存的工程
  await expect(page.getByTestId('open-project')).toBeVisible()
  await expect(page.getByTestId('resume-project')).toHaveCount(0)
  for (const [testId, name, buffer] of [
    ['drop-background', 'scene.png', scene],
    ['drop-character', 'figure.png', figure(240, 480)],
  ] as const) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId(testId).click()
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
  }
  await page.getByTestId('start').click()
  await settle(page)

  // 改动几类参数：立绘位置与翻转、遮挡区域之外的景深参数、LUT、后期
  const x = page.getByTestId('char-x')
  await x.evaluate((el) => {
    ;(el as HTMLInputElement).value = '260'
    el.dispatchEvent(new Event('change'))
  })
  await expect.poll(() => xValue(page)).toBe('260')
  await page.keyboard.press('h')
  await page.getByTestId('step-adjust').click()
  await page.locator('[data-testid="grade-tab"] mdui-segmented-button[value="style"]').click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('lut-import').click()
  await (await chooser).setFiles({ name: 'swap.cube', mimeType: 'text/plain', buffer: SWAP_CUBE })
  await expect(page.getByTestId('lut-name')).toHaveText('swap.cube')
  await page.getByTestId('step-effects').click()
  await setSlider(page, 'post-lens-vignette', -60)
  // 移动立绘后融合统计会在后台重新计算
  await page.waitForTimeout(1500)
  const before = await exportPixels(page)

  // 保存工程文件：清单、背景和立绘三个文件
  const download = page.waitForEvent('download')
  await page.getByTestId('save-project').click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe('scene.a2r')
  const path = info.outputPath('scene.a2r')
  await saved.saveAs(path)
  const files = await readZip(new Blob([await readFile(path)]))
  expect(files.has('project.json')).toBe(true)
  expect(files.size).toBe(3)

  // 刷新后从首屏继续：参数和画面与刷新前一致
  await page.waitForTimeout(1500)
  await page.reload()
  await expect(page.getByTestId('resume-project')).toContainText('scene.png')
  await page.getByTestId('resume-project').click()
  await expect(page.getByTestId('inspector')).toBeVisible()
  await settle(page)
  expect(await xValue(page)).toBe('260')
  expect(maxDiff(await exportPixels(page), before)).toBeLessThanOrEqual(2)

  // 改动后打开工程文件，确认替换后回到保存时的状态
  await page.getByTestId('step-character').click()
  await page.keyboard.press('h')
  await page.getByTestId('step-export').click()
  const picker = page.waitForEvent('filechooser')
  await page.getByTestId('open-project-editor').click()
  await (await picker).setFiles(path)
  await page.locator('mdui-dialog[open]').getByText('打开', { exact: true }).click()
  await settle(page)
  expect(await page.getByTestId('char-flip').evaluate((el) => (el as HTMLInputElement).checked)).toBe(true)
  expect(maxDiff(await exportPixels(page), before)).toBeLessThanOrEqual(2)
})
