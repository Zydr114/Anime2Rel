import { expect, test, type Page } from '@playwright/test'
import { pagePixels } from './canvas'
import { figure } from './figure'
import { swiftshader } from './gpu'
import { makeImage } from './png'

const W = 640
const H = 480

test.setTimeout(180_000)
test.slow(swiftshader, '软件渲染')

async function choose(page: Page, testId: string, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId(testId).click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer })
}

const group = (page: Page, id: string) => page.locator(`[data-group="${id}"]`)

test('seven steps with collapsible groups, a toolbar 3D toggle, operation hints, task status and a settings dialog', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '与渲染后端无关')
  // 测试配置预设了全部分组展开、关闭操作提示，这里恢复默认
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.removeItem('a2r.ui.groups')
    localStorage.removeItem('a2r.ui.prefs')
  })
  await page.reload()
  await choose(page, 'drop-background', 'bg.png', makeImage(W, H, (x, y) => [60 + (x / W) * 60, 80 + (y / H) * 40, 110, 255]))
  await choose(page, 'drop-character', 'figure.png', figure(240, 480))
  await page.getByTestId('start').click()

  const steps = await page.locator('[data-testid^="step-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  // M8.9 起调色在镜头之后
  expect(steps).toEqual(['step-assets', 'step-scene', 'step-place', 'step-fusion', 'step-lens', 'step-adjust', 'step-export'])
  // 后台任务显示在工具栏中
  await expect(page.getByTestId('task-status')).toHaveAttribute('data-state', 'running')

  // 场景步骤：相机标定默认展开，其余分组收起
  await expect(group(page, 'camera.calibration')).toHaveAttribute('data-open', 'true')
  await expect(group(page, 'depth.estimate')).toHaveAttribute('data-open', 'false')
  await page.locator('[data-group-header="depth.estimate"]').click()
  await expect(group(page, 'depth.estimate')).toHaveAttribute('data-open', 'true')
  await page.getByTestId('camera-confirm').click()
  await expect(page.getByTestId('task-status')).toHaveCount(0, { timeout: 120_000 })

  // 摆放：选择工具时展开对应的分组，操作提示随工具变化
  await page.getByTestId('step-place').click()
  const hints = page.getByTestId('op-hints')
  await expect(hints).toContainText('拖动四角')
  await expect(group(page, 'character.warp')).toHaveAttribute('data-open', 'false')
  await page.locator('[data-testid="place-tool"] mdui-segmented-button[value="perspective"]').click()
  await expect(group(page, 'character.warp')).toHaveAttribute('data-open', 'true')
  await expect(hints).toContainText('四角透视')
  await page.getByTestId('op-hints-collapse').click()
  await expect(hints).toHaveCount(0)
  await page.getByTestId('op-hints-expand').click()

  // 3D 视图：工具栏按钮只在摆放和融合步骤可用，3D 的说明显示在操作提示中
  await page.getByTestId('view3d-toggle').click()
  await expect(page.getByTestId('view3d')).toBeVisible()
  await expect(page.getByTestId('view3d-notice')).toContainText('2.5D')
  await page.getByTestId('step-adjust').click()
  await expect(page.getByTestId('view3d')).toHaveCount(0)
  await expect(page.getByTestId('view3d-toggle')).toBeDisabled()
  await page.getByTestId('step-fusion').click()
  await expect(page.getByTestId('view3d')).toBeVisible()
  await page.getByTestId('view3d-toggle').click()
  await expect(page.getByTestId('view3d')).toHaveCount(0)

  // 设置对话框：深度模型的设置，关闭操作提示
  await page.getByTestId('settings-button').click()
  await expect(page.getByTestId('depth-settings')).toBeVisible()
  await page.getByTestId('settings-op-hints').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).not.toHaveAttribute('open')
  await expect(hints).toHaveCount(0)
  await expect(page.getByTestId('op-hints-expand')).toHaveCount(0)

  // 分组的展开状态和设置记在浏览器中
  await page.waitForTimeout(1500)
  await page.reload()
  await page.getByTestId('resume-project').click()
  await page.getByTestId('step-scene').click()
  await expect(group(page, 'depth.estimate')).toHaveAttribute('data-open', 'true')
  await page.getByTestId('step-place').click()
  await expect(hints).toHaveCount(0)
})

test('light theme: follows the system by default, can be chosen in settings and is remembered', async ({ page }) => {
  const root = page.locator('html')
  // 测试配置固定为深色，这里改为系统浅色
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(root).toHaveAttribute('data-theme', 'light')
  await expect(root).toHaveClass(/mdui-theme-light/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(root).toHaveAttribute('data-theme', 'dark')

  await choose(page, 'drop-background', 'bg.png', makeImage(W, H, (x, y) => [60 + (x / W) * 60, 80 + (y / H) * 40, 110, 255]))
  await page.getByTestId('start').click()
  // 画布周围：深色 #1a1a1a
  const surround = { x: 600, y: 30 }
  await expect.poll(async () => (await pagePixels(page, [surround]))[0]).toEqual([26, 26, 26])

  // 手动选择浅色，不再跟随系统；画布周围变为浅灰
  await page.getByTestId('settings-button').click()
  await page.locator('[data-testid="settings-theme"] mdui-segmented-button[value="light"]').click()
  await expect(root).toHaveAttribute('data-theme', 'light')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings')).not.toHaveAttribute('open')
  await expect.poll(async () => (await pagePixels(page, [surround]))[0]).toEqual([214, 214, 214])

  // 选择记在浏览器中，重新打开时在界面渲染之前就是浅色
  await page.reload()
  await expect(root).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('a2r.ui.theme'))).toBe('light')
})
