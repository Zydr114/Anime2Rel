import { expect, test, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { exportPixels, pixel, type ExportedImage } from './export'
import { figure } from './figure'
import { encodePng, makeImage } from './png'

const W = 640
const H = 480

test.setTimeout(180_000)

const rendererQuery = (renderer: unknown) => (renderer === 'webgl' ? '?renderer=webgl' : '')

async function choose(page: Page, testId: string, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(testId).click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
}

/** 导入素材并开始；confirm 时直接确认默认的相机 */
async function importAndStart(page: Page, files: [testId: string, name: string, buffer: Buffer][], confirm = true) {
  for (const file of files) await choose(page, ...file)
  await page.getByTestId('start').click()
  if (confirm) await page.getByTestId('camera-confirm').click()
}

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    ;(el as HTMLElement & { value: number }).value = v
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }, value)
}

/** 在 step 步骤改参数后等画面更新再导出 */
async function exportAfter(page: Page, change: () => Promise<unknown>, step = 'character'): Promise<ExportedImage> {
  await page.getByTestId(`step-${step}`).click()
  await change()
  await page.waitForTimeout(1500)
  return exportPixels(page)
}

/**
 * 100×160 的红色立绘（圆头和身体），边缘 3 px 半透明，颜色混入了白色底色，透明处为黑色。
 * 放大 2.5 倍、中心 (320, 240) 时，头部中心在文档 (320, 152.5)，左边缘约在 x = 232。
 */
function matted(): Buffer {
  const w = 100
  const h = 160
  const sdf = (x: number, y: number) => Math.min(Math.hypot(x - 50, y - 45) - 35, Math.max(Math.abs(x - 50) - 30, Math.abs(y - 120) - 38))
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = Math.min(1, Math.max(0, -sdf(x + 0.5, y + 0.5) / 3 + 0.5))
      if (a <= 0) continue
      const i = (y * w + x) * 4
      ;[200, 40, 40].forEach((c, ch) => (rgba[i + ch] = Math.round(a * c + (1 - a) * 255)))
      rgba[i + 3] = Math.round(a * 255)
    }
  return encodePng(w, h, rgba)
}

/** 头部左边缘附近一行像素：最白处（最小通道的最大值）与第一个明显发红的位置 */
function edge(img: ExportedImage) {
  let white = 0
  let red = -1
  for (let x = 215; x < 260; x++) {
    const [r, g, b] = pixel(img, x, 152)
    white = Math.max(white, Math.min(r, g, b))
    if (red < 0 && r - g > 60) red = x
  }
  return { white, red }
}

test('the white matte is removed from the edge and shrinking pulls the edge in', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [
    ['drop-background', 'dark.png', makeImage(W, H, (x, y) => [40 + (x / W) * 30, 48 + (y / H) * 20, 58, 255])],
    ['drop-character', 'matted.png', matted()],
  ])
  await page.getByTestId('step-character').click()
  await setSlider(page, 'char-scale', 250)
  await setSlider(page, 'char-x', 320)
  await setSlider(page, 'char-y', 240)
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 60_000 })
  await page.waitForTimeout(1500)

  const on = edge(await exportPixels(page))
  const off = edge(await exportAfter(page, () => page.getByTestId('fusion-edge-decontaminate').click()))
  const shrunk = edge(
    await exportAfter(page, async () => {
      await page.getByTestId('fusion-edge-decontaminate').click()
      await setSlider(page, 'fusion-edge-shrink', 2)
    }),
  )
  // 不处理时边缘是一圈混入白色的亮边
  expect(off.white).toBeGreaterThan(on.white + 25)
  expect(on.red).toBeGreaterThan(0)
  expect(shrunk.red).toBeGreaterThan(on.red)
})

const sunny = (() => {
  const s = renderScene(W, H, {
    direction: pixelToRay({ x: 0.72 * W, y: 0.12 * H }, { width: W, height: H }, 60),
    color: [0.9, 0.8, 0.65],
    ambient: [0.15, 0.17, 0.2],
    sunInView: true,
  })
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
})()

const luma = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

/** 区域内的平均亮度 */
function meanLuma(img: ExportedImage, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += luma(pixel(img, x, y))
  return sum / ((x1 - x0) * (y1 - y0))
}

test('lights are named by kind, the intro stays dismissed, and rim beams spread from a backlit character', async ({ page }, info) => {
  const query = rendererQuery(info.project.metadata.renderer)
  await page.goto(`/${query}`)
  // 简笔人物默认缩放 0.8、中心 (320, 278)，头部中心约在 (320, 151)；太阳在 (461, 58)，人物逆光
  await importAndStart(page, [
    ['drop-background', 'sunny.png', sunny],
    ['drop-character', 'figure.png', figure(240, 480)],
  ])
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  const sun = page.locator('[data-testid^="light-row-"][data-type="directional"]').first()
  await expect(sun).toContainText('太阳 / 天光 1')
  await expect(sun).toContainText(/自动识别 · 置信度[高中低]/)
  await sun.click()
  await expect(page.getByTestId('light-type-hint')).toContainText('只有方向')
  await page.getByTestId('light-intro-dismiss').click()
  await expect(page.getByTestId('light-intro')).toHaveCount(0)

  await page.getByTestId('step-character').click()
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  const plain = await exportPixels(page)
  await page.getByTestId('step-effects').click()
  await setSlider(page, 'post-rays-rim', 100)
  await page.waitForTimeout(1500)
  const beams = await exportPixels(page)
  // 光束从头部向远离太阳的一侧（左下）散开；左上角与太阳之间没有人物，不变
  expect(meanLuma(beams, 230, 170, 280, 205)).toBeGreaterThan(meanLuma(plain, 230, 170, 280, 205) + 2)
  expect(Math.abs(luma(pixel(beams, 12, 12)) - luma(pixel(plain, 12, 12)))).toBeLessThan(1.5)

  // 关闭的说明在重新打开页面后不再出现
  await page.waitForTimeout(1500)
  await page.goto(`/${query}`)
  await page.getByTestId('resume-project').click()
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-list')).toBeVisible()
  await expect(page.getByTestId('light-intro')).toHaveCount(0)
})

/** 夜景，灯在 (470, 140)：光源识别为点光源 */
const night = (() => {
  const s = renderScene(W, H, { direction: null, color: [0, 0, 0], ambient: [0.03, 0.03, 0.04], lamp: { x: 470, y: 140, r: 7 }, night: true })
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
})()

test('a lens flare appears around the lamp, can be edited and saved, and fades when the character covers the lamp', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [
    ['drop-background', 'night.png', night],
    ['drop-character', 'figure.png', figure(240, 480)],
  ])
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-character').click()
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  // 灯右侧的夜空，离灯 45–105 px
  const glow = (img: ExportedImage) => meanLuma(img, 515, 120, 575, 160)
  const plain = await exportPixels(page)

  await page.getByTestId('step-effects').click()
  await page.getByTestId('flare-preset-soft-sun').click()
  await expect(page.getByTestId('flare-preset-soft-sun')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(1500)
  const flared = await exportPixels(page)
  expect(glow(flared)).toBeGreaterThan(glow(plain) + 8)

  // 元素的添加、复制和删除
  await page.getByTestId('step-effects').click()
  const rows = page.getByTestId('flare-elements').locator('button')
  await expect(rows).toHaveCount(5)
  await page.getByTestId('flare-add').click()
  await page.getByTestId('flare-add-ring').click()
  await expect(rows).toHaveCount(6)
  await expect(page.getByTestId('flare-editor')).toHaveAttribute('data-type', 'ring')
  await page.getByTestId('flare-remove').click()
  await page.getByTestId('flare-element-0').click()
  await page.getByTestId('flare-duplicate').click()
  await expect(page.getByTestId('flare-element-1')).toHaveAttribute('data-type', 'glow')
  await page.getByTestId('flare-remove').click()
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('flare-preset-soft-sun')).toHaveAttribute('aria-pressed', 'true')

  // 存为自定义光晕
  await page.getByTestId('flare-save').click()
  await page.locator('mdui-dialog[open] input').fill('夜灯')
  await page.locator('mdui-dialog[open] mdui-button', { hasText: '保存' }).click()
  await expect(page.getByTestId('flare-custom-0')).toContainText('夜灯')

  // 立绘的头部挡住灯：光晕消失
  await page.getByTestId('step-character').click()
  await setSlider(page, 'char-x', 470)
  await setSlider(page, 'char-y', 267)
  await page.waitForTimeout(1500)
  const covered = await exportPixels(page)
  await page.getByTestId('step-effects').click()
  await page.getByTestId('post-flare-enabled').click()
  await page.waitForTimeout(1500)
  const coveredOff = await exportPixels(page)
  expect(Math.abs(glow(covered) - glow(coveredOff))).toBeLessThan(2)
})

/** 120×180 的立绘，左半红、右半蓝，四周 10 px 透明 */
const halves = makeImage(120, 180, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 170 ? [0, 0, 0, 0] : x < 60 ? [220, 30, 30, 255] : [30, 30, 220, 255]))
const isRed = ([r, g]: number[]) => r - g > 60
const isBlue = ([r, , b]: number[]) => b - r > 60

/** 把变形控件的第 index 个控制点拖向第 toward 个控制点，走 k 倍的距离 */
async function dragWarp(page: Page, index: number, toward: number, k: number) {
  const center = async (i: number) => {
    const b = (await page.getByTestId(`warp-handle-${i}`).boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const from = await center(index)
  const to = await center(toward)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, { steps: 8 })
  await page.mouse.up()
}

test('the character warps by its perspective corners and mesh points, undoably and resettably', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [
    ['drop-background', 'dark.png', makeImage(W, H, (x, y) => [40 + (x / W) * 40, 50 + (y / H) * 30, 70, 255])],
    ['drop-character', 'halves.png', halves],
  ])
  // 默认摆放：立绘占文档 x 192–448、y 86.4–470.4。立绘 UV (0.15, 0.1)，左上角附近
  const topLeft = (img: ExportedImage) => pixel(img, 230, 125)
  // 立绘 UV (0.45, 1/3)，左右两半分界线的左侧
  const nearSeam = (img: ExportedImage) => pixel(img, 307, 214)
  const before = await exportAfter(page, async () => {})
  expect(isRed(topLeft(before))).toBe(true)
  expect(isRed(nearSeam(before))).toBe(true)

  // 四角透视：左上角向右上角拖过 40%，原来左上角处露出背景
  await page.getByTestId('step-character').click()
  await page.locator('[data-testid="warp-tool"] mdui-segmented-button[value="perspective"]').click()
  await expect(page.getByTestId('gizmo')).toHaveCount(0)
  const reset = page.getByTestId('warp-reset-perspective')
  await expect(reset).toHaveAttribute('disabled')
  await dragWarp(page, 0, 1, 0.4)
  await expect(reset).not.toHaveAttribute('disabled')
  const tilted = await exportAfter(page, async () => {})
  expect(isRed(topLeft(tilted))).toBe(false)
  expect(isRed(nearSeam(tilted))).toBe(true)
  expect(isRed(topLeft(await exportAfter(page, () => reset.click())))).toBe(true)
  // 撤销重置
  expect(isRed(topLeft(await exportAfter(page, () => page.getByTestId('undo').click())))).toBe(false)
  await page.getByTestId('step-character').click()
  await reset.click()

  // 网格变形：第二行第三个控制点（UV 2/3, 1/3）向左拖，分界线随之左移
  await page.locator('[data-testid="warp-tool"] mdui-segmented-button[value="mesh"]').click()
  await expect(page.getByTestId('warp-handle-15')).toBeVisible()
  await dragWarp(page, 6, 5, 0.9)
  await expect(page.getByTestId('warp-reset-grid')).not.toHaveAttribute('disabled')
  expect(isBlue(nearSeam(await exportAfter(page, async () => {})))).toBe(true)
  // 改变网格密度保持形状
  const finer = await exportAfter(page, async () => {
    await page.locator('[data-testid="warp-grid"] mdui-segmented-button[value="6"]').click()
    await expect(page.getByTestId('warp-handle-35')).toBeVisible()
  })
  expect(isBlue(nearSeam(finer))).toBe(true)
  const undone = await exportAfter(page, async () => {
    await page.getByTestId('undo').click()
    await page.getByTestId('undo').click()
  })
  expect(isRed(nearSeam(undone))).toBe(true)
})

const diff = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

async function setSelect(page: Page, testId: string, value: string) {
  const select = page.getByTestId(testId)
  await select.click()
  await select.locator(`mdui-menu-item[value="${value}"]`).click()
  await expect(select).toHaveJSProperty('value', value)
}

test('a character standing in water is reflected below the waterline, tinted by the water colour, undoably', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [
    ['drop-background', 'dark.png', makeImage(W, H, (x, y) => [40 + (x / W) * 40, 50 + (y / H) * 30, 70, 255])],
    ['drop-character', 'halves.png', halves],
  ])
  // 等深度、光源分析和融合统计都就绪，之后立绘的颜色不再变化，水线以上的像素才能逐一比较
  await page.getByTestId('step-depth').click()
  for (const layer of ['background', 'character'])
    await expect(page.getByTestId(`depth-job-${layer}`)).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await page.getByTestId('step-character').click()
  await expect(page.getByTestId('fusion-color')).toContainText('影调和色调参照', { timeout: 30_000 })
  // 原大摆在 (320, 150)：不透明部分 x 270–370、y 70–230，接地点（水线）在脚底 y ≈ 230
  await page.getByTestId('step-character').click()
  await setSlider(page, 'char-scale', 100)
  await setSlider(page, 'char-y', 150)
  await page.getByTestId('step-focus').click()
  await page.getByTestId('focus-occlusion-enabled').click()
  await setSelect(page, 'focus-occlusion-mode', 'water')
  // 水线以上 30 px 处的左右两半，与它们在水线以下的镜像位置
  const [redAbove, redBelow, blueBelow] = [
    [295, 200],
    [295, 260],
    [345, 260],
  ] as const
  const plain = await exportAfter(page, async () => {}, 'focus')
  expect(isRed(pixel(plain, ...redBelow))).toBe(false)
  expect(isBlue(pixel(plain, ...blueBelow))).toBe(false)

  const blur = page.getByTestId('focus-occlusion-reflectionBlur')
  await expect(blur).toHaveCount(0)
  const reflected = await exportAfter(page, () => setSlider(page, 'focus-occlusion-reflection', 100), 'focus')
  expect(isRed(pixel(reflected, ...redBelow))).toBe(true)
  expect(isBlue(pixel(reflected, ...blueBelow))).toBe(true)
  expect(diff(pixel(reflected, ...redAbove), pixel(plain, ...redAbove))).toBeLessThan(4)

  // 水色为绿色时红色的倒影被滤掉
  const tinted = await exportAfter(
    page,
    async () => {
      await expect(blur).toBeVisible()
      await page.getByTestId('focus-occlusion-waterColor').click()
      await page.getByTestId('focus-occlusion-waterColor-hex').fill('00ff00')
      await page.keyboard.press('Escape')
    },
    'focus',
  )
  expect(pixel(tinted, ...redBelow)[0]).toBeLessThan(pixel(reflected, ...redBelow)[0] - 100)

  const undone = await exportAfter(
    page,
    async () => {
      await page.getByTestId('undo').click()
      await page.getByTestId('undo').click()
    },
    'focus',
  )
  expect(diff(pixel(undone, ...redBelow), pixel(plain, ...redBelow))).toBeLessThan(4)
})

const sliderValue = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => (el as HTMLElement & { value: number }).value)

/** 拖动控件中心 (dx, dy) 屏幕像素 */
async function dragBy(page: Page, testId: string, dx: number, dy: number) {
  const box = (await page.getByTestId(testId).boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

const gradient = makeImage(W, H, (x, y) => [40 + (x / W) * 40, 50 + (y / H) * 30, 70, 255])

test('the camera is calibrated before the other steps, by the horizon or by parallel lines, undoably', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [['drop-background', 'bg.png', gradient]], false)
  // 未确认相机时其他步骤不可进入
  await expect(page.getByTestId('camera-locked')).toBeVisible()
  await page.getByTestId('step-light').click()
  await expect(page.getByTestId('camera-method')).toBeVisible()
  await expect(page.getByTestId('camera-guide')).toHaveAttribute('data-kind', 'ground')

  // 拖动地平线左端向上：相机倾斜；整条线向下：俯仰改变
  await dragBy(page, 'horizon-handle-0', 0, -40)
  expect(Math.abs(await sliderValue(page, 'camera-roll'))).toBeGreaterThan(1)
  const pitch = await sliderValue(page, 'camera-pitch')
  await dragBy(page, 'horizon-line', 0, 60)
  expect(await sliderValue(page, 'camera-pitch')).toBeGreaterThan(pitch + 3)
  // 一次拖动是一次撤销
  await page.getByTestId('undo').click()
  await expect.poll(() => sliderValue(page, 'camera-pitch')).toBeCloseTo(pitch, 3)

  // 平行线：按当前的标定生成线段，求解结果不变；拖动端点后重新求解
  await page.locator('[data-testid="camera-method"] mdui-segmented-button[value="lines"]').click()
  const solution = page.getByTestId('camera-solution')
  await expect(solution).toContainText('60.0°')
  await dragBy(page, 'camera-handle-first-0-0', 0, -60)
  await expect(solution).not.toContainText('60.0°')
  await expect(page.getByTestId('camera-solve-error')).toHaveCount(0)

  await page.getByTestId('camera-confirm').click()
  await expect(page.getByTestId('camera-confirmed')).toBeVisible()
  await page.getByTestId('step-depth').click()
  await expect(page.getByTestId('depth-job-background')).toBeVisible()

  // 更换背景后需要重新标定
  await page.getByTestId('step-assets').click()
  await choose(page, 'replace-background', 'other.png', makeImage(W, H, () => [90, 90, 90, 255]))
  await expect(page.getByTestId('camera-locked')).toBeVisible()
  await expect(solution).toHaveCount(0)
})

test('a character dragged in the calibrated camera keeps its height in the scene and can be put into its perspective', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await importAndStart(page, [['drop-background', 'bg.png', gradient], ['drop-character', 'figure.png', figure(240, 480)]], false)
  await setSlider(page, 'camera-pitch', -15)
  await setSlider(page, 'camera-roll', 4)
  await page.getByTestId('camera-confirm').click()
  await page.getByTestId('step-character').click()

  // 向地平线拖动：缩小，身高读数不变
  const height = page.getByTestId('char-height')
  await expect(height).toContainText(' m')
  const meters = await height.innerText()
  const scale = await sliderValue(page, 'char-scale')
  await dragBy(page, 'gizmo-body', 0, -40)
  expect(await sliderValue(page, 'char-scale')).toBeLessThan(scale - 3)
  await expect(height).toHaveText(meters)
  // 关闭后拖动不缩放，身高随之改变
  await page.getByTestId('char-perspective-move').click()
  const kept = await sliderValue(page, 'char-scale')
  await dragBy(page, 'gizmo-body', 0, -40)
  expect(await sliderValue(page, 'char-scale')).toBeCloseTo(kept, 3)
  await expect(height).not.toHaveText(meters)

  await page.getByTestId('char-show-guide').click()
  await expect(page.getByTestId('character-guide')).toHaveCount(1)

  // 按相机透视写入四角透视，可撤销
  await page.locator('[data-testid="warp-tool"] mdui-segmented-button[value="perspective"]').click()
  const reset = page.getByTestId('warp-reset-perspective')
  await expect(reset).toHaveAttribute('disabled')
  await page.getByTestId('char-camera-perspective').click()
  await expect(reset).not.toHaveAttribute('disabled')
  await page.getByTestId('undo').click()
  await expect(reset).toHaveAttribute('disabled')

  // 水线沿地平线方向倾斜
  await page.getByTestId('step-focus').click()
  await page.getByTestId('focus-occlusion-enabled').click()
  await setSelect(page, 'focus-occlusion-mode', 'water')
  const line = page.getByTestId('waterline').locator('line').first()
  const [y1, y2] = await Promise.all([line.getAttribute('y1'), line.getAttribute('y2')])
  expect(Math.abs(Number(y1) - Number(y2))).toBeGreaterThan(10)
})
