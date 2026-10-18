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

// 遮挡扩展的场景：立绘缩小到 50%、中心 (320, 300)，双脚在 y ≈ 415 处，左腿在 x ≈ 308、y 360–415 之间
async function standOnGround(page: Page) {
  await page.getByTestId('step-character').click()
  await setSlider(page, 'char-scale', 50)
  await setSlider(page, 'char-y', 300)
}

const luminance = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]

function meanLuminance(img: ExportedImage, { x0, x1, y0, y1 }: { x0: number; x1: number; y0: number; y1: number }) {
  let sum = 0
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += luminance(pixel(img, x, y))
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1))
}

/** 把接地点标记沿屏幕竖直方向拖动 dy 像素 */
async function dragGround(page: Page, dy: number) {
  const box = (await page.getByTestId('ground-handle').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 5 })
  await page.mouse.up()
}

/** 用区域画笔在画布上沿文档坐标的折线涂一笔 */
async function paint(page: Page, points: [number, number][]) {
  const box = (await page.getByTestId('region-canvas').boundingBox())!
  const at = ([x, y]: [number, number]) => [box.x + (x / W) * box.width, box.y + (y / H) * box.height] as const
  await page.mouse.move(...at(points[0]))
  await page.mouse.down()
  for (const p of points.slice(1)) await page.mouse.move(...at(p), { steps: 8 })
  await page.mouse.up()
}

/** 打开下拉选择框并点选一项 */
async function setSelect(page: Page, testId: string, value: string) {
  const select = page.getByTestId(testId)
  await select.click()
  await select.locator(`mdui-menu-item[value="${value}"]`).click()
  await expect(select).toHaveJSProperty('value', value)
}

test('contact point can be dragged and reset, and the standing shadow darkens the ground below the feet in export', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  await standOnGround(page)
  const GROUND = { x0: 250, x1: 330, y0: 418, y1: 475 }
  const SKY_BOX = { x0: 40, x1: 120, y0: 20, y1: 60 }

  await setSlider(page, 'fusion-shadow-contact', 100)
  await setSlider(page, 'fusion-shadow-cast', 100)
  const shadowed = await exportPixels(page)
  await page.getByTestId('step-character').click()
  await setSlider(page, 'fusion-shadow-contact', 0)
  await setSlider(page, 'fusion-shadow-cast', 0)
  const plain = await exportPixels(page)
  await page.getByTestId('step-character').click()
  expect(meanLuminance(shadowed, GROUND)).toBeLessThan(meanLuminance(plain, GROUND) - 3)
  expect(Math.abs(meanLuminance(shadowed, SKY_BOX) - meanLuminance(plain, SKY_BOX))).toBeLessThan(1)

  // 拖动接地点后变为手动，双击恢复自动
  const handle = page.getByTestId('ground-handle')
  await expect(handle).toHaveAttribute('data-manual', 'false')
  await dragGround(page, -30)
  await expect(handle).toHaveAttribute('data-manual', 'true')
  await expect(page.getByTestId('fusion-ground-state')).toHaveText('手动')
  await handle.dblclick()
  await expect(handle).toHaveAttribute('data-manual', 'false')
})

test('water occlusion covers the character below the waterline at the contact point, medium mode lets it show through', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  await standOnGround(page)
  await page.getByTestId('step-focus').click()
  const ABOVE: [number, number] = [308, 378]
  const BELOW: [number, number] = [308, 408]
  const clear = await exportFromFocus(page)

  await page.getByTestId('focus-occlusion-enabled').click()
  await setSelect(page, 'focus-occlusion-mode', 'water')
  await expect(page.getByTestId('waterline')).toHaveCount(1)
  // 接地点拖到小腿处，水线随之上移到 y ≈ 396
  await dragGround(page, -30)
  const water = await exportFromFocus(page)
  expect(diff(pixel(water, ...ABOVE), pixel(clear, ...ABOVE))).toBeLessThan(15)
  expect(diff(pixel(water, ...BELOW), pixel(clear, ...BELOW))).toBeGreaterThan(60)

  // 介质：立绘在更近的地面后面时按深度差透出一部分，介于不遮挡与不透明遮挡之间
  await setSelect(page, 'focus-occlusion-mode', 'medium')
  await expect(page.getByTestId('waterline')).toHaveCount(0)
  await setSlider(page, 'fusion-depth', 30)
  const medium = await exportFromFocus(page)
  await setSelect(page, 'focus-occlusion-mode', 'opaque')
  const opaque = await exportFromFocus(page)
  await page.getByTestId('focus-occlusion-enabled').click()
  const behind = await exportFromFocus(page)
  const LEG_MID: [number, number] = [308, 395]
  expect(diff(pixel(opaque, ...LEG_MID), pixel(behind, ...LEG_MID))).toBeGreaterThan(100)
  expect(diff(pixel(medium, ...LEG_MID), pixel(behind, ...LEG_MID))).toBeGreaterThan(20)
  expect(diff(pixel(medium, ...LEG_MID), pixel(opaque, ...LEG_MID))).toBeGreaterThan(20)
})

test('occlusion regions painted with the brush use their own mode, apply to export and are undoable', async ({ page }, info) => {
  await open(page, info.project.metadata.renderer as string)
  const leg = async () => (await docPixels(page, [LEG]))[0]
  // 深度会影响立绘的光照，未遮挡的颜色在改完深度之后取
  await setSlider(page, 'fusion-depth', 30)
  await expect.poll(async () => (await leg())[0]).toBeGreaterThan(170)
  const skin = await leg()
  await page.getByTestId('focus-occlusion-enabled').click()
  await expect.poll(async () => diff(await leg(), skin)).toBeGreaterThan(120)

  // 新建区域并涂过双腿，区域着色显示在画布上
  await page.getByTestId('region-add').click()
  await expect(page.getByTestId('region-0')).toHaveAttribute('data-active', 'true')
  await setSlider(page, 'region-size', 60)
  await paint(page, [
    [270, 415],
    [340, 415],
    [340, 440],
    [270, 440],
  ])
  await expect(page.getByTestId('region-overlay')).toBeVisible()
  await setSelect(page, 'region-mode', 'none')
  await page.getByTestId('region-done').click()
  await expect(page.getByTestId('region-overlay')).toHaveCount(0)

  // 区域内不遮挡：双腿恢复，导出同样如此；区域外仍按默认方式遮挡
  await expect.poll(async () => diff(await leg(), skin)).toBeLessThan(30)
  const img = await exportFromFocus(page)
  expect(diff(pixel(img, Math.round(LEG[0] * W), Math.round(LEG[1] * H)), skin)).toBeLessThan(30)

  // 撤销区域的遮挡方式，双腿重新被挡住
  await page.getByTestId('undo').click()
  await expect.poll(async () => diff(await leg(), skin)).toBeGreaterThan(120)
})
