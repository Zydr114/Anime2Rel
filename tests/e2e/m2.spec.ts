import { expect, test, type Locator, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene, type SyntheticLight } from '@/analysis/synthetic'
import { docPixels, type DocPoint } from './canvas'
import { encodePng } from './png'

// 需要 dist 中带有自托管模型（pnpm test:e2e 会先下载）。
// 场景由 src/analysis/synthetic.ts 光线追踪生成：地面、几个球体和天空；分析使用深度模型对这张图的估计。
const W = 640
const H = 480
const SUN: DocPoint = [0.72, 0.12]
const LAMP: DocPoint = [0.3, 0.55]

function scene(light: SyntheticLight): Buffer {
  const s = renderScene(W, H, light)
  return encodePng(W, H, new Uint8Array(s.rgba.buffer))
}

const sunny = scene({
  direction: pixelToRay({ x: SUN[0] * W, y: SUN[1] * H }, { width: W, height: H }, 60),
  color: [0.9, 0.8, 0.65],
  ambient: [0.15, 0.17, 0.2],
  sunInView: true,
})
const overcast = scene({ direction: null, color: [0, 0, 0], ambient: [0.1, 0.1, 0.1], skyLight: [0.5, 0.52, 0.55] })
const night = scene({ direction: null, color: [0, 0, 0], ambient: [0.03, 0.03, 0.04], lamp: { x: LAMP[0] * W, y: LAMP[1] * H, r: 7 }, night: true })

test.setTimeout(120_000)

async function open(page: Page, renderer: string, image: Buffer) {
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('drop-background').click()
  await (await chooser).setFiles({ name: 'scene.png', mimeType: 'image/png', buffer: image })
  await page.getByTestId('start').click()
  await page.getByTestId('camera-confirm').click()
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
}

/** 文档归一化坐标 → 页面坐标：添加工具的点击层正好覆盖文档（夜景边缘接近视口底色，不能靠截图定位） */
async function docToPage(page: Page) {
  await page.getByTestId('light-add-canvas').click()
  const b = (await page.getByTestId('light-tool-overlay').boundingBox())!
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('light-tool-overlay')).toHaveCount(0)
  return ([u, v]: DocPoint) => ({ x: b.x + u * b.width, y: b.y + v * b.height })
}

const rows = (page: Page) => page.locator('[data-testid^="light-row-"]')

async function lightId(row: Locator): Promise<string> {
  return (await row.getAttribute('data-testid'))!.replace('light-row-', '')
}

async function center(locator: Locator) {
  const b = (await locator.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

function expectNear(a: { x: number; y: number }, b: { x: number; y: number }, tolerance: number) {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(tolerance)
}

test('visible sun becomes an editable light; lights can be dragged, added, recolored and removed', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string, sunny)

  // 候选：太阳是来自可见光源（A）的方向光，画布上的控件就在太阳处
  const sunRow = rows(page).first()
  await expect(sunRow).toHaveAttribute('data-type', 'directional')
  await expect(sunRow).toHaveAttribute('data-sources', /A/)
  const sunId = await lightId(sunRow)
  const sunHandle = page.getByTestId(`light-handle-${sunId}`)
  await expect(sunHandle).toHaveAttribute('data-kind', 'directional')
  const toPage = await docToPage(page)
  expectNear(await center(sunHandle), toPage(SUN), 12)

  // 灰球：默认不显示，打开后显示在画面中央，切到其他步骤时不显示
  const ballAt: DocPoint = [0.5, 0.5]
  const [withoutBall] = await docPixels(page, [ballAt])
  await page.getByTestId('light-ball').click()
  const [withBall] = await docPixels(page, [ballAt])
  expect(withBall.reduce((s, v, i) => s + Math.abs(v - withoutBall[i]), 0)).toBeGreaterThan(30)
  await page.getByTestId('step-adjust').click()
  expect(await docPixels(page, [ballAt])).toEqual([withoutBall])
  await page.getByTestId('step-fusion').click()

  // 拖动方向光，撤销后回到原处
  const from = await center(sunHandle)
  const to = toPage([0.3, 0.2])
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  expectNear(await center(sunHandle), to, 4)
  await page.keyboard.press('Control+z')
  expectNear(await center(sunHandle), from, 4)

  // 在地面上点击添加点光源
  const count = await rows(page).count()
  await page.getByTestId('light-add-canvas').click()
  const groundAt = toPage([0.25, 0.85])
  await page.mouse.click(groundAt.x, groundAt.y)
  await expect(rows(page)).toHaveCount(count + 1)
  const pointRow = rows(page).last()
  await expect(pointRow).toHaveAttribute('data-type', 'point')
  await expect(pointRow).toContainText('手动')
  const pointId = await lightId(pointRow)
  const pointHandle = page.getByTestId(`light-handle-${pointId}`)
  await expect(pointHandle).toHaveAttribute('data-kind', 'point')
  expectNear(await center(pointHandle), groundAt, 4)
  await expect(page.getByTestId('light-selected')).toContainText('灯')

  // 改色：取色器设置后颜色生效，色温显示为自定义
  await page.getByTestId('light-color').click()
  await page.getByTestId('light-color-hex').fill('3366ff')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('light-color-picker')).toHaveCount(0)
  await expect(pointHandle.locator('circle').last()).toHaveAttribute('fill', '#3366ff')
  await expect(page.getByTestId('light-selected')).toContainText('自定义')
  // 色温滑块改回自然光
  await page.getByTestId('light-kelvin').click()
  await expect(page.getByTestId('light-selected')).toContainText(' K')
  await expect(pointHandle.locator('circle').last()).not.toHaveAttribute('fill', '#3366ff')

  // 停用、删除（按钮与 Delete 键）
  await page.getByTestId(`light-enabled-${pointId}`).click()
  await expect(pointRow).toHaveAttribute('data-enabled', 'false')
  await page.getByTestId(`light-remove-${pointId}`).click()
  await expect(rows(page)).toHaveCount(count)
  await page.getByTestId('light-add-directional').click()
  await expect(rows(page)).toHaveCount(count + 1)
  await expect(rows(page).last()).toContainText('手动')
  await page.keyboard.press('Delete')
  await expect(rows(page)).toHaveCount(count)
})

test('overcast photo is recognized as diffuse', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '分析与渲染后端无关，只在一个项目中运行')
  await open(page, 'webgpu', overcast)
  await expect(page.getByTestId('light-diffuse')).toBeVisible()
  await expect(rows(page).first()).toHaveAttribute('data-type', 'directional')
})

test('lamp at night becomes a point light at the lamp', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '分析与渲染后端无关，只在一个项目中运行')
  await open(page, 'webgpu', night)
  await expect(page.getByTestId('light-diffuse')).toHaveCount(0)
  const row = page.locator('[data-testid^="light-row-"][data-type="point"]').first()
  await expect(row).toHaveAttribute('data-sources', /A/)
  const handle = page.getByTestId(`light-handle-${await lightId(row)}`)
  expectNear(await center(handle), (await docToPage(page))(LAMP), 10)
})
