import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { docPixels, type DocPoint } from './canvas'
import { exportPixels, pixel, type ExportedImage } from './export'
import { figure } from './figure'
import { swiftshader } from './gpu'
import { encodePng } from './png'

// M8.8a 镜头与滤镜、M8.8b 局部调整蒙版（docs/Plan.md §3.7 M8.8）。场景与 m5.spec.ts 相同：太阳在右上方的画面内，立绘为蓝色裙子的简笔人物。
const W = 640
const H = 480
const DRESS: DocPoint = [320 / W, 293 / H]
const SUN: DocPoint = [461 / W, 58 / H]
const GROUND: DocPoint = [60 / W, 440 / H]
const SKY: DocPoint = [120 / W, 110 / H]

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
test.slow(swiftshader, '软件渲染')

const rendererQuery = (renderer: unknown) => (renderer === 'webgl' ? 'renderer=webgl&' : '')

/** 导入场景并等深度、光源分析和融合统计就绪（之后画面不再变化），停在镜头步骤 */
async function open(page: Page, renderer: unknown) {
  await page.goto(`/?${rendererQuery(renderer)}`)
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
  await settle(page)
}

async function settle(page: Page) {
  await page.getByTestId('step-scene').click()
  for (const job of ['depth-job-background', 'depth-job-character']) await expect(page.getByTestId(job)).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await expect(page.getByTestId('fusion-color')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await page.getByTestId('step-lens').click()
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

const maxDiff = (a: number[], b: number[]) => Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i])))
const luma = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)

/** 导出图像各通道差值的最大值 */
function maxImageDiff(a: ExportedImage, b: ExportedImage): number {
  let max = 0
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]))
  return max
}

/** 导出图像相邻像素差值（绿通道）平方的平均值，衡量锐度（差值的绝对值之和在单调的边缘上不随模糊变化） */
function sharpness(img: ExportedImage): number {
  let sum = 0
  for (let y = 0; y < img.height; y++)
    for (let x = 1; x < img.width; x++) sum += (img.data[(y * img.width + x) * 4 + 1] - img.data[(y * img.width + x - 1) * 4 + 1]) ** 2
  return sum / (img.height * (img.width - 1))
}

/** 各通道都接近 0 或 255 的像素所占的比例 */
function binaryShare(img: ExportedImage): number {
  let n = 0
  for (let i = 0; i < img.data.length; i += 4) if ([0, 1, 2].every((c) => img.data[i + c] < 30 || img.data[i + c] > 225)) n++
  return n / (img.width * img.height)
}

/** 导出图像的平均亮度（编码值） */
function meanLuma(img: ExportedImage): number {
  let sum = 0
  for (let i = 0; i < img.data.length; i += 4) sum += luma(img.data.slice(i, i + 3))
  return sum / (img.width * img.height)
}

/** 导出图像的平均线性亮度 */
function meanLinearLuma(img: ExportedImage): number {
  let sum = 0
  for (let i = 0; i < img.data.length; i += 4) sum += 0.2126 * linear(img.data[i]) + 0.7152 * linear(img.data[i + 1]) + 0.0722 * linear(img.data[i + 2])
  return sum / (img.width * img.height)
}

test('optical diffusion softens highlights without brightening the image, and the export matches the preview', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  const before = await exportPixels(page)
  await page.getByTestId('step-lens').click()
  const [sun, ground] = await docPixels(page, [SUN, GROUND])

  await setSlider(page, 'post-diffusion-intensity', 100)
  await setSlider(page, 'post-diffusion-radius', 100)
  // 阈值为 0（白柔）：亮处的光移到暗处，暗部蒙上一层薄雾，亮部不会变亮，平均亮度基本不变
  await expect.poll(async () => luma((await docPixels(page, [GROUND]))[0])).toBeGreaterThan(luma(ground) + 10)
  const preview = await docPixels(page, [DRESS, SUN, GROUND])
  expect(luma(preview[1])).toBeLessThan(luma(sun) + 2)
  const after = await exportPixels(page)
  const [m0, m1] = [meanLinearLuma(before), meanLinearLuma(after)]
  console.log(`mean linear luma ${m0.toFixed(4)} → ${m1.toFixed(4)}`)
  expect(Math.abs(m1 - m0) / m0).toBeLessThan(0.05)
  ;[DRESS, SUN, GROUND].forEach(([u, v], i) => expect(maxDiff(pixel(after, Math.round(u * W), Math.round(v * H)), preview[i])).toBeLessThan(8))
})

test('soft focus brightens the shadows next to highlights, soften lowers the sharpness', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  const before = await exportPixels(page)
  await page.getByTestId('step-lens').click()
  const [dress] = await docPixels(page, [DRESS])

  // 柔焦按“变亮”叠加：深色的裙子被周围的亮部提亮，不会变暗
  await setSlider(page, 'post-softFocus-intensity', 100)
  await expect.poll(async () => luma((await docPixels(page, [DRESS]))[0])).toBeGreaterThan(luma(dress) + 10)
  await setSlider(page, 'post-softFocus-intensity', 0)
  await expect.poll(async () => maxDiff((await docPixels(page, [DRESS]))[0], dress)).toBeLessThan(3)

  await setSlider(page, 'post-soften-intensity', 100)
  await setSlider(page, 'post-soften-radius', 100)
  const preview = await docPixels(page, [DRESS, SUN, GROUND])
  const soft = await exportPixels(page)
  console.log(`sharpness ${sharpness(before).toFixed(2)} → ${sharpness(soft).toFixed(2)}`)
  expect(sharpness(soft)).toBeLessThan(sharpness(before) * 0.6)
  ;[DRESS, SUN, GROUND].forEach(([u, v], i) => expect(maxDiff(pixel(soft, Math.round(u * W), Math.round(v * H)), preview[i])).toBeLessThan(8))
})

test('lens distortion shows only in the lens and export steps, focus picking follows it, and the export matches the preview', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  // 立绘头顶上方的天空：桶形失真满格时画面中间放大约 1.25 倍，这里显示的是头发
  const ABOVE_HEAD: DocPoint = [320 / W, 105 / H]
  const [sky] = await docPixels(page, [ABOVE_HEAD])
  await setSlider(page, 'post-lens-distortion', 100)
  await expect.poll(async () => maxDiff((await docPixels(page, [ABOVE_HEAD]))[0], sky)).toBeGreaterThan(60)
  // 导出带失真，与镜头步骤的预览一致（焦点标记在立绘中间，避开它取预览）
  const points = [ABOVE_HEAD, SUN, GROUND, [0.25, 0.7] as DocPoint]
  const preview = await docPixels(page, points)
  const img = await exportPixels(page)
  points.forEach(([u, v], i) => expect(maxDiff(pixel(img, Math.round(u * W), Math.round(v * H)), preview[i])).toBeLessThan(8))

  // 点击画面上的头发：按失真换算后对焦到立绘，焦点标记留在点击处
  await page.getByTestId('step-lens').click()
  const box = (await page.getByTestId('focus-overlay').boundingBox())!
  const click = { x: box.x + ABOVE_HEAD[0] * box.width, y: box.y + ABOVE_HEAD[1] * box.height }
  await page.mouse.click(click.x, click.y)
  await expect(page.getByTestId('focus-target-kind')).toHaveAttribute('data-kind', 'character')
  const marker = (await page.getByTestId('focus-marker').boundingBox())!
  expect(Math.abs(marker.x + marker.width / 2 - click.x)).toBeLessThan(2)
  expect(Math.abs(marker.y + marker.height / 2 - click.y)).toBeLessThan(2)

  // 调色步骤中不显示失真，画布控件与原画面对位
  await page.getByTestId('step-adjust').click()
  await expect.poll(async () => maxDiff((await docPixels(page, [ABOVE_HEAD]))[0], sky)).toBeLessThan(4)
})

test('halftone turns the image into ink dots whose area follows the tone', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  const before = await exportPixels(page)
  await page.getByTestId('step-lens').click()
  await setSlider(page, 'post-halftone-intensity', 100)
  await setSlider(page, 'post-halftone-size', 100)
  const mono = await exportPixels(page)
  // 黑白：几乎所有像素都是纸白或墨黑，平均亮度（编码值）与原图接近
  expect(binaryShare(mono)).toBeGreaterThan(0.75)
  let tint = 0
  for (let i = 0; i < mono.data.length; i += 4) tint = Math.max(tint, Math.abs(mono.data[i] - mono.data[i + 2]))
  expect(tint).toBeLessThan(3)
  console.log(`mean luma ${meanLuma(before).toFixed(1)} → ${meanLuma(mono).toFixed(1)}`)
  expect(Math.abs(meanLuma(mono) - meanLuma(before))).toBeLessThan(10)

  await page.getByTestId('step-lens').click()
  await page.locator('[data-testid="post-halftone-mode"] mdui-segmented-button[value="color"]').click()
  const color = await exportPixels(page)
  expect(binaryShare(color)).toBeGreaterThan(0.75)
  expect(maxImageDiff(color, mono)).toBeGreaterThan(100)
})

test('a tiled export with the M8.8a effects matches the whole-image render', async ({ page }, info) => {
  const query = rendererQuery(info.project.metadata.renderer)
  await open(page, info.project.metadata.renderer)
  for (const [testId, value] of [
    ['post-diffusion-intensity', 50],
    ['post-diffusion-threshold', 40],
    ['post-softFocus-intensity', 60],
    ['post-soften-intensity', 100],
    ['post-soften-radius', 100],
    ['post-lens-distortion', -100],
    ['post-lens-aberration', 60],
    ['post-halftone-intensity', 70],
  ] as const)
    await setSlider(page, testId, value)
  await page.locator('[data-testid="post-halftone-mode"] mdui-segmented-button[value="color"]').click()
  await page.waitForTimeout(1500)
  const whole = await exportPixels(page)

  // 同一个工程按 128 像素分块导出
  await page.waitForTimeout(1500)
  await page.goto(`/?${query}exportTile=128`)
  await page.getByTestId('resume-project').click()
  await settle(page)
  const tiled = await exportPixels(page)
  expect([tiled.width, tiled.height]).toEqual([W, H])
  expect(maxImageDiff(whole, tiled)).toBeLessThanOrEqual(4)
})

const segment = (page: Page, testId: string, value: string) => page.locator(`[data-testid="${testId}"] mdui-segmented-button[value="${value}"]`).click()

type Pixels = Pick<ExportedImage, 'width' | 'height' | 'data'>

/** 页面中一张图片的像素 */
function imagePixels(page: Page, testId: string): Promise<Pixels> {
  return page.getByTestId(testId).evaluate(async (el) => {
    const img = el as HTMLImageElement
    await img.decode()
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) }
  })
}

/** 图像分成 cols × rows 格，各格各通道的平均值 */
function blockMeans(img: Pixels, cols: number, rows: number): number[] {
  const sums = new Array<number>(cols * rows * 3).fill(0)
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const b = (Math.floor((y * rows) / img.height) * cols + Math.floor((x * cols) / img.width)) * 3
      for (let c = 0; c < 3; c++) sums[b + c] += img.data[(y * img.width + x) * 4 + c]
    }
  return sums.map((s) => (s * cols * rows) / (img.width * img.height))
}

test('preset thumbnails render the current picture with each preset and match the applied result', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  await page.getByTestId('step-adjust').click()
  const preview = await docPixels(page, [DRESS, SUN, GROUND])
  await segment(page, 'grade-tab', 'presets')

  // 黑白胶片的缩略图没有颜色
  const mono = await imagePixels(page, 'preset-mono-film-thumbnail')
  expect([mono.width, mono.height]).toEqual([240, 180])
  let tint = 0
  for (let i = 0; i < mono.data.length; i += 4) tint = Math.max(tint, Math.max(...mono.data.slice(i, i + 3)) - Math.min(...mono.data.slice(i, i + 3)))
  expect(tint).toBeLessThan(4)
  // 生成缩略图后恢复当前参数，预览不变
  const after = await docPixels(page, [DRESS, SUN, GROUND])
  preview.forEach((p, i) => expect(maxDiff(after[i], p)).toBeLessThan(3))

  for (const id of ['dreamy', 'teal-orange']) {
    const thumbnail = page.getByTestId(`preset-${id}-thumbnail`)
    const src = await thumbnail.getAttribute('src')
    const thumb = await imagePixels(page, `preset-${id}-thumbnail`)
    await page.getByTestId(`preset-${id}`).click()
    // 调色和后期的变化不会重新生成缩略图
    await page.waitForTimeout(1000)
    expect(await thumbnail.getAttribute('src')).toBe(src)
    const applied = await exportPixels(page)
    const [a, b] = [blockMeans(thumb, 8, 6), blockMeans(applied, 8, 6)]
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(4)
    await page.getByTestId('step-adjust').click()
  }
})

/** 拖动画布控件的控点 dx、dy 个屏幕像素 */
async function drag(page: Page, testId: string, dx: number, dy: number) {
  const box = (await page.getByTestId(testId).boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

/** 用局部调整的画笔在画布上沿文档坐标的折线涂一笔 */
async function paintMask(page: Page, points: [number, number][]) {
  const box = (await page.getByTestId('mask-canvas').boundingBox())!
  const at = ([x, y]: [number, number]) => [box.x + (x / W) * box.width, box.y + (y / H) * box.height] as const
  await page.mouse.move(...at(points[0]))
  await page.mouse.down()
  for (const p of points.slice(1)) await page.mouse.move(...at(p), { steps: 8 })
  await page.mouse.up()
}

async function setSelect(page: Page, testId: string, value: string) {
  const select = page.getByTestId(testId)
  await select.click()
  await select.locator(`mdui-menu-item[value="${value}"]`).click()
  await expect(select).toHaveJSProperty('value', value)
}

/** 打开调色步骤的“局部”页，添加一项局部调整 */
async function addMask(page: Page) {
  await page.getByTestId('step-adjust').click()
  await segment(page, 'grade-tab', 'local')
  await page.getByTestId('mask-add').click()
}

const gain = (after: number[], before: number[]) => luma(after) - luma(before)

test('an elliptical local adjustment brightens the middle, follows its canvas handles, shows its mask and is undoable', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer)
  await page.getByTestId('step-adjust').click()
  const base = await docPixels(page, [DRESS, GROUND])

  // 默认的椭圆在画面中央：裙子提亮，角落的地面不变
  await addMask(page)
  await expect(page.getByTestId('mask-gizmo')).toHaveAttribute('data-shape', 'ellipse')
  await setSlider(page, 'mask-exposure', 1.5)
  await expect.poll(async () => gain((await docPixels(page, [DRESS]))[0], base[0])).toBeGreaterThan(30)
  expect(maxDiff((await docPixels(page, [GROUND]))[0], base[1])).toBeLessThan(3)
  const bright = (await docPixels(page, [DRESS]))[0]

  // 显示蒙版：作用处叠上红色
  await page.getByTestId('mask-show').click()
  await expect.poll(async () => {
    const [p] = await docPixels(page, [DRESS])
    return p[0] - p[2] - (bright[0] - bright[2])
  }).toBeGreaterThan(40)
  await page.getByTestId('mask-show').click()
  await expect.poll(async () => maxDiff((await docPixels(page, [DRESS]))[0], bright)).toBeLessThan(3)

  // 把椭圆拖到右边，裙子不再提亮；撤销一次回到原处
  await drag(page, 'mask-center', 260, 0)
  await expect.poll(async () => maxDiff((await docPixels(page, [DRESS]))[0], base[0])).toBeLessThan(3)
  await page.getByTestId('undo').click()
  await expect.poll(async () => maxDiff((await docPixels(page, [DRESS]))[0], bright)).toBeLessThan(3)

  // 停用后不起作用
  await page.getByTestId('mask-0-enabled').click()
  await expect.poll(async () => maxDiff((await docPixels(page, [DRESS]))[0], base[0])).toBeLessThan(3)
})

test('ranges, a linear gradient and a brush limit local adjustments, and the export and a tiled export match the preview', async ({ page }, info) => {
  const query = rendererQuery(info.project.metadata.renderer)
  await open(page, info.project.metadata.renderer)
  await page.getByTestId('step-adjust').click()
  const points = [DRESS, GROUND, SKY]
  const base = await docPixels(page, points)
  const gains = async () => (await docPixels(page, points)).map((p, i) => gain(p, base[i]))

  // 全画面 + 只在立绘：裙子提亮，背景不变；只在背景则相反
  await addMask(page)
  await segment(page, 'mask-shape', 'full')
  await setSlider(page, 'mask-exposure', 1.5)
  await setSelect(page, 'mask-range', 'character')
  await expect.poll(async () => (await gains())[0]).toBeGreaterThan(30)
  const [, g0, s0] = await gains()
  expect(Math.abs(g0)).toBeLessThan(3)
  expect(Math.abs(s0)).toBeLessThan(3)
  await setSelect(page, 'mask-range', 'background')
  await expect.poll(async () => Math.abs((await gains())[0])).toBeLessThan(3)
  const [, ground] = await gains()
  expect(ground).toBeGreaterThan(20)
  // 按深度只调远处：天空提亮，近处的地面不变
  await setSelect(page, 'mask-range', 'depth')
  await expect.poll(async () => (await gains())[2]).toBeGreaterThan(20)
  expect(Math.abs((await gains())[1])).toBeLessThan(3)
  const sky = (await gains())[2]

  // 线性渐变：默认从底边到画面中部，压暗底部的地面，不影响上方
  await page.getByTestId('mask-add').click()
  await segment(page, 'mask-shape', 'linear')
  await expect(page.getByTestId('mask-gizmo')).toHaveAttribute('data-shape', 'linear')
  await setSlider(page, 'mask-exposure', -2)
  await expect.poll(async () => (await gains())[1]).toBeLessThan(-20)
  const [, darkened, sky2] = await gains()
  expect(Math.abs(sky2 - sky)).toBeLessThan(3)

  // 画笔：涂过的天空叠上默认的橙色
  await page.getByTestId('mask-add').click()
  await segment(page, 'mask-shape', 'brush')
  await setSelect(page, 'mask-mode', 'normal')
  await setSlider(page, 'mask-opacity', 100)
  await paintMask(page, [
    [100, 110],
    [140, 110],
  ])
  await expect(page.getByTestId('mask-overlay')).toBeVisible()
  // 离开“局部”页后画布上不再叠加画笔的着色，取到的是渲染结果：涂过处完全换成叠色，其他地方不变
  await segment(page, 'grade-tab', 'basic')
  await expect(page.getByTestId('mask-overlay')).toHaveCount(0)
  await expect.poll(async () => maxDiff((await docPixels(page, [SKY]))[0], [255, 157, 77])).toBeLessThan(4)
  expect(Math.abs((await gains())[1] - darkened)).toBeLessThan(3)

  // 导出与预览一致
  await page.waitForTimeout(1000)
  const preview = await docPixels(page, points)
  const whole = await exportPixels(page)
  points.forEach(([u, v], i) => expect(maxDiff(pixel(whole, Math.round(u * W), Math.round(v * H)), preview[i])).toBeLessThan(8))

  // 同一个工程按 128 像素分块导出，没有接缝
  await page.waitForTimeout(1500)
  await page.goto(`/?${query}exportTile=128`)
  await page.getByTestId('resume-project').click()
  await settle(page)
  const tiled = await exportPixels(page)
  expect(maxImageDiff(whole, tiled)).toBeLessThanOrEqual(4)
})
