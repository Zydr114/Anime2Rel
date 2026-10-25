import { expect, test, type Locator, type Page } from '@playwright/test'
import { pixelToRay } from '@/algo/camera'
import { renderScene } from '@/analysis/synthetic'
import { figure } from './figure'
import { swiftshader } from './gpu'
import { encodePng } from './png'

// M8.9 光源操作与新手指引（docs/Plan.md §3.7 M8.9）。场景与 m8-8.spec.ts 相同，立绘为蓝色裙子的简笔人物。
const W = 640
const H = 480
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

const rendererQuery = (renderer: unknown) => (renderer === 'webgl' ? '?renderer=webgl' : '')

async function upload(page: Page, character: boolean) {
  const files = [['drop-background', 'bg.png', sunny] as const, ...(character ? [['drop-character', 'figure.png', figure(240, 480)] as const] : [])]
  for (const [testId, name, buffer] of files) {
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId(testId).click()
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
  }
  await page.getByTestId('start').click()
}

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b).not.toBeNull()
  return b!
}

/** 高亮框比目标向外多出 6 px（src/app/Tour.tsx 的 PAD）。工具栏的宽度随后台任务的状态变化，每次都重新取目标的位置 */
async function expectSpotlightOn(page: Page, target: Locator) {
  await expect
    .poll(async () => {
      const [t, s] = [await box(target), await box(page.getByTestId('tour-spotlight'))]
      return Math.max(Math.abs(s.x + 6 - t.x), Math.abs(s.y + 6 - t.y), Math.abs(s.width - 12 - t.width), Math.abs(s.height - 12 - t.height))
    })
    .toBeLessThan(2)
}

test('onboarding tour shows once before calibration, walks through the interface and reopens from settings', async ({ page }, info) => {
  // 减少动态效果：高亮框直接到位，不做移动动画（软件渲染时动画的进度取决于渲染的帧）
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  // 测试的初始状态把指引标为已看过（playwright.config.ts），这里还原为第一次使用
  await page.evaluate(() => localStorage.removeItem('a2r.ui.dismissedHints'))
  await page.reload()
  await upload(page, false)

  // 进入编辑器后先显示指引：场景步骤已经打开，标定还没有确认
  const tour = page.getByTestId('tour')
  await expect(tour).toHaveAttribute('data-page', 'welcome')
  await expect(page.getByTestId('tour-progress')).toHaveText('1 / 7')
  await expect(page.getByTestId('tour-prev')).toHaveCount(0)
  const confirm = page.getByTestId('camera-confirm')
  await expect(confirm).toBeVisible()
  // 指引盖住界面：点“确认相机”的位置不起作用
  const c = await box(confirm)
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2)
  await expect(confirm).toBeVisible()

  const next = page.getByTestId('tour-next')
  const pages: [string, Locator | null][] = [
    ['steps', page.locator('[data-tour="steps"]')],
    ['canvas', null],
    ['inspector', page.getByTestId('inspector')],
    ['toolbar', page.locator('[data-tour="toolbar"]')],
    // 测试关闭了操作提示：不高亮，只显示说明
    ['hints', null],
    ['settings', page.getByTestId('settings-button')],
  ]
  for (const [id, target] of pages) {
    await next.click()
    await expect(tour).toHaveAttribute('data-page', id)
    if (target) await expectSpotlightOn(page, target)
  }
  await expect(page.getByTestId('tour-progress')).toHaveText('7 / 7')
  // 相机未标定：最后一页提示先标定
  await expect(page.getByTestId('tour-bubble')).toContainText('标定相机')
  await expect(next).toHaveText('开始使用')

  // 上一步、方向键翻页，Esc 跳过
  await page.getByTestId('tour-prev').click()
  await expect(tour).toHaveAttribute('data-page', 'hints')
  await expect(page.getByTestId('tour-bubble')).toContainText('没有显示')
  await page.keyboard.press('ArrowLeft')
  await expect(tour).toHaveAttribute('data-page', 'toolbar')
  await page.keyboard.press('ArrowRight')
  await expect(tour).toHaveAttribute('data-page', 'hints')
  await page.keyboard.press('Escape')
  await expect(tour).toHaveCount(0)
  // 关闭后界面恢复可用
  await confirm.click()
  await expect(page.getByTestId('camera-confirmed')).toBeVisible()

  // 再次进入编辑器不再自动显示
  await page.reload()
  await upload(page, false)
  await expect(confirm).toBeVisible()
  await expect(tour).toHaveCount(0)

  // 设置中可以再次查看，从第 1 页开始
  await page.getByTestId('settings-button').click()
  await page.getByTestId('settings-tour').click()
  await expect(tour).toHaveAttribute('data-page', 'welcome')
  await expect(page.getByTestId('tour-progress')).toHaveText('1 / 7')
  await expect(page.getByTestId('settings')).not.toHaveAttribute('open')
  await page.getByTestId('tour-skip').click()
  await expect(tour).toHaveCount(0)
})

test('lights are added with two equal buttons; the lamp starts beside the head at the character depth', async ({ page }, info) => {
  await page.goto(`/${rendererQuery(info.project.metadata.renderer)}`)
  await upload(page, true)
  await page.getByTestId('camera-confirm').click()
  for (const job of ['depth-job-background', 'depth-job-character']) await expect(page.getByTestId(job)).toHaveAttribute('data-state', 'done', { timeout: 90_000 })

  // 导航顺序：调色在镜头之后
  const order = await page.locator('[data-testid="steps"] mdui-navigation-rail-item').evaluateAll((items) => items.map((el) => el.getAttribute('data-testid')))
  expect(order).toEqual(['step-assets', 'step-scene', 'step-place', 'step-fusion', 'step-lens', 'step-adjust', 'step-export'])

  // 立绘向左移 60 像素，画面右侧空间较大；记下立绘在画面上的范围（变换控件的外框）与前后位置
  await page.getByTestId('step-place').click()
  const before = await box(page.getByTestId('gizmo-body'))
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await box(page.getByTestId('gizmo-body'))).x).toBeLessThan(before.x - 20)
  await page.waitForTimeout(500)
  const layer = await box(page.getByTestId('gizmo-body'))
  const charDepth = await page.getByTestId('fusion-depth').evaluate((el) => (el as HTMLElement & { value: number }).value)

  // 分析完成后才添加，否则分析结果会替换光源列表
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('light-analysis-state')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
  await expect(page.getByTestId('fusion-color')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  const rows = page.locator('[data-testid^="light-row-"]')
  const count = await rows.count()

  for (const [i, type] of (['directional', 'point'] as const).entries()) {
    await page.getByTestId(`light-add-${type}`).click()
    await expect(rows).toHaveCount(count + i + 1)
    const row = rows.last()
    await expect(row).toHaveAttribute('data-type', type)
    // 新光源被选中，编辑区顶部显示这种光源的说明
    await expect(page.getByTestId('light-editor')).toHaveAttribute('data-type', type)
    await expect(page.getByTestId('light-type-hint')).toHaveText(type === 'point' ? /近处的光源/ : /远处的光源/)
  }

  // 灯在人物肩部的斜上方：立绘不透明区域为图片宽的 14%–86%、高的 7%–99%（tests/e2e/figure.ts），
  // 灯在头部高度（顶边下 10% 的不透明高度），在中心右侧 0.6 倍不透明宽度处
  const id = (await rows.last().getAttribute('data-testid'))!.replace('light-row-', '')
  const lamp = await box(page.getByTestId(`light-handle-${id}`))
  const expected = { x: layer.x + (0.5 + 0.6 * 0.72) * layer.width, y: layer.y + (0.07 + 0.1 * 0.92) * layer.height }
  expect(Math.abs(lamp.x + lamp.width / 2 - expected.x)).toBeLessThan(0.05 * layer.width)
  expect(Math.abs(lamp.y + lamp.height / 2 - expected.y)).toBeLessThan(0.04 * layer.height)
  // 深度与立绘相同（滑块按 1% 取整）
  const lampDepth = await page.getByTestId('light-depth').evaluate((el) => (el as HTMLElement & { value: number }).value)
  expect(Math.abs(lampDepth - charDepth)).toBeLessThanOrEqual(1)
})
