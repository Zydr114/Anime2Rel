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

const rendererQuery = (renderer: unknown) => (renderer === 'webgl' ? 'renderer=webgl&' : '')

async function importAndStart(page: Page, files: [testId: string, name: string, buffer: Buffer][]) {
  for (const [testId, name, buffer] of files) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId(testId).click()
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
  }
  await page.getByTestId('start').click()
}

/** 各通道差值的最大值、平均值，以及超过 tolerance 的比例 */
function diffStats(a: ExportedImage, b: ExportedImage, tolerance: number) {
  let max = 0
  let sum = 0
  let over = 0
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i])
    max = Math.max(max, d)
    sum += d
    if (d > tolerance) over++
  }
  return { max, mean: sum / a.data.length, over: over / a.data.length }
}

test('a tiled export matches the whole-image render', async ({ page }, info) => {
  const query = rendererQuery(info.project.metadata.renderer)
  await page.goto(`/?${query}`)
  await importAndStart(page, [
    ['drop-background', 'scene.png', scene],
    ['drop-character', 'figure.png', figure(240, 480)],
  ])
  await settle(page)
  // 景深、局部调整、色差读取邻近的像素，Bloom、轮廓光束、暗角和颗粒按整幅图像计算
  await page.getByTestId('step-focus').click()
  await setSlider(page, 'focus-dof-aperture', 3)
  await page.getByTestId('step-adjust').click()
  for (const [testId, value] of [
    ['adjust-clarity', 60],
    ['adjust-sharpen', 80],
    ['adjust-shadows', 50],
  ] as const)
    await setSlider(page, testId, value)
  await page.getByTestId('step-effects').click()
  for (const [testId, value] of [
    ['post-bloom-intensity', 60],
    ['post-rays-rim', 100],
    ['post-lens-aberration', 60],
    ['post-lens-vignette', -40],
    ['post-grain-amount', 40],
  ] as const)
    await setSlider(page, testId, value)
  await page.waitForTimeout(1500)
  const whole = await exportPixels(page)

  // 同一个工程按 128 像素分块导出
  await page.waitForTimeout(1500)
  await page.goto(`/?${query}exportTile=128`)
  await page.getByTestId('resume-project').click()
  await settle(page)
  const tiled = await exportPixels(page)
  expect([tiled.width, tiled.height]).toEqual([W, H])
  // 去掉块的扩展边距时接缝处相差 50 以上
  expect(diffStats(whole, tiled, 4).max).toBeLessThanOrEqual(4)
})

test('a background beyond the texture limit is exported at its original resolution', async ({ page }, info) => {
  const [BW, BH] = [1500, 300]
  const wide = renderScene(BW, BH, {
    direction: pixelToRay({ x: 0.7 * BW, y: 0.1 * BH }, { width: BW, height: BH }, 60),
    color: [0.9, 0.8, 0.65],
    ambient: [0.15, 0.17, 0.2],
    sunInView: true,
  })
  const source = new Uint8Array(wide.rgba.buffer)
  await page.goto(`/?${rendererQuery(info.project.metadata.renderer)}textureLimit=1024`)
  await importAndStart(page, [['drop-background', 'wide.png', encodePng(BW, BH, source)]])
  // 关闭景深后没有任何处理，导出的结果就是原图
  await page.getByTestId('step-focus').click()
  await page.getByTestId('focus-dof-enabled').click()
  await expect.poll(() => page.getByTestId('focus-dof-enabled').evaluate((el) => (el as HTMLInputElement).checked)).toBe(false)
  await page.getByTestId('step-export').click()
  await expect(page.getByTestId('export-resolution')).toContainText('1500 × 300')
  const png = await exportPixels(page)
  expect(png.name).toMatch(/\.png$/)
  expect([png.width, png.height]).toEqual([BW, BH])
  expect(diffStats(png, { ...png, data: Array.from(source) }, 1).max).toBeLessThanOrEqual(1)

  await page.locator('[data-testid="export-format"] mdui-segmented-button[value="jpeg"]').click()
  const jpeg = await exportPixels(page)
  expect(jpeg.name).toMatch(/\.jpg$/)
  expect(jpeg.magic.slice(0, 2)).toEqual([0xff, 0xd8])
  expect([jpeg.width, jpeg.height]).toEqual([BW, BH])
  expect(diffStats(jpeg, png, 8).mean).toBeLessThan(2)
})

test('panels use liquid glass in Chromium and turn opaque with reduced effects', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '与渲染后端无关')
  await page.goto('/')
  await importAndStart(page, [['drop-background', 'scene.png', scene]])
  const html = page.locator('html')
  const nav = page.locator('nav.glass')
  await expect(html).toHaveAttribute('data-glass', 'liquid')
  // 每个面板有自己的滤镜；对话框的滤镜在它的 shadow root 里
  await expect.poll(() => nav.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--glass-filter'))).toMatch(/url\(#a2r-glass-\d+\)/)
  await page.getByTestId('about-button').click()
  await expect(page.getByTestId('glass-mode')).toHaveAttribute('data-mode', 'liquid')
  await expect.poll(() => page.getByTestId('about').evaluate((el) => el.shadowRoot!.querySelectorAll('filter[id^="a2r-glass-"]').length)).toBe(1)

  await page.getByTestId('reduce-effects').click()
  await expect(html).toHaveAttribute('data-glass', 'solid')
  await expect(page.getByTestId('glass-mode')).toHaveAttribute('data-mode', 'solid')
  expect(await nav.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--glass-filter'))).toBe('')
  expect(await nav.evaluate((el) => getComputedStyle(el, '::before').backdropFilter)).toBe('none')
  // 设置保存在浏览器中
  await page.reload()
  await expect(html).toHaveAttribute('data-glass', 'solid')
})
