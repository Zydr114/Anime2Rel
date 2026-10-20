import { expect, test, type Page } from '@playwright/test'
import { docPixels } from './canvas'
import { makeImage, type Rgba } from './png'

// 需要 dist 中带有自托管模型（pnpm test:e2e 会先下载）。
// 合成场景 640×480：上部天空渐变，地平线在 40% 高度，下方是透视棋盘地面，中下部有一个受光球体。
const W = 640
const H = 480
const HORIZON = 0.4 * H
const SPHERE = { x: 0.5 * W, y: 0.68 * H, r: 0.17 * H }

function scene(x: number, y: number): Rgba {
  const px = x + 0.5
  const py = y + 0.5
  const dx = (px - SPHERE.x) / SPHERE.r
  const dy = (py - SPHERE.y) / SPHERE.r
  const r2 = dx * dx + dy * dy
  if (r2 < 1) {
    // 光从左上方照来的 Lambert 球
    const nz = Math.sqrt(1 - r2)
    const lambert = Math.max(0, (-0.5 * dx - 0.6 * dy + 0.62 * nz) / Math.hypot(0.5, 0.6, 0.62))
    const k = 0.2 + 0.8 * lambert
    return [200 * k, 80 * k, 60 * k, 255]
  }
  if (py < HORIZON) {
    const t = py / HORIZON
    return [110 + 80 * t, 160 + 55 * t, 230 + 15 * t, 255]
  }
  // 相机高 1.6、焦距 0.8W 的透视地面，远处加雾
  const z = (1.6 * 0.8 * W) / Math.max(py - HORIZON, 1e-3)
  const u = ((px - W / 2) * z) / (0.8 * W)
  const checker = (Math.floor(u / 1.5) + Math.floor(z / 1.5)) & 1
  const fog = Math.min(1, z / 60)
  const base = checker ? [125, 155, 85] : [80, 115, 55]
  const fogColor = [175, 195, 215]
  return [0, 1, 2].map((c) => base[c] * (1 - fog) + fogColor[c] * fog).concat(255) as Rgba
}

const image = makeImage(W, H, (x, y) => scene(x, y).map(Math.round) as Rgba)

// 取样点（文档归一化坐标）
const SKY = [0.5, 0.1] as const
const SPHERE_CENTER = [0.5, 0.68] as const
const SPHERE_LEFT = [0.41, 0.68] as const
const SPHERE_RIGHT = [0.59, 0.68] as const
const GROUND_NEAR = [0.15, 0.95] as const
const GROUND_FAR = [0.15, 0.45] as const

test.setTimeout(120_000)

async function start(page: Page, renderer: string) {
  await page.goto(renderer === 'webgl' ? '/?renderer=webgl' : '/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('drop-background').click()
  await (await chooser).setFiles({ name: 'scene.png', mimeType: 'image/png', buffer: image })
  await page.getByTestId('start').click()
  await page.getByTestId('camera-confirm').click()
  await page.getByTestId('step-depth').click()
}

async function waitDone(page: Page) {
  await expect(page.getByTestId('depth-job-background')).toHaveAttribute('data-state', 'done', { timeout: 90_000 })
}

test('depth, normal and sky debug views', async ({ page }, info) => {
  await start(page, info.project.metadata.renderer as string)
  await waitDone(page)
  await expect(page.getByTestId('depth-model-ready')).toContainText(/WebGPU|WASM/)
  const points = [SKY, SPHERE_CENTER, SPHERE_LEFT, SPHERE_RIGHT, GROUND_NEAR, GROUND_FAR]
  const composite = await docPixels(page, points)

  // 深度：天空最远（inferno 低端接近黑色），球体很近，地面越往下越近
  await page.keyboard.press('v')
  const [skyD, sphereD, , , nearD, farD] = await docPixels(page, points)
  expect(skyD[0] + skyD[1] + skyD[2]).toBeLessThan(60)
  expect(sphereD[0]).toBeGreaterThan(200)
  expect(nearD[0]).toBeGreaterThan(farD[0] + 60)

  // 法线（RGB = n·0.5 + 0.5，y 向上）：地面朝上偏绿；球体左侧朝左、右侧朝右；天空置信度为 0，显示压暗的朝向相机法线
  await page.keyboard.press('v')
  const [skyN, , leftN, rightN, nearN] = await docPixels(page, points)
  expect(nearN[1]).toBeGreaterThan(nearN[0] + 40)
  expect(rightN[0]).toBeGreaterThan(leftN[0] + 60)
  expect(skyN[2]).toBeGreaterThan(skyN[0] + 40)

  // 天空：天空区域染成蓝色，地面不染色
  await page.keyboard.press('v')
  const [skyS, , , , nearS] = await docPixels(page, points)
  expect(skyS[2]).toBeGreaterThan(skyS[0] + 80)
  expect(nearS[2]).toBeLessThan(nearS[1])

  // 经过景深视图回到合成视图后与之前一致
  await page.keyboard.press('v')
  await page.keyboard.press('v')
  expect(await docPixels(page, points)).toEqual(composite)

  // 开关获得焦点后按空格（用于平移视图）不会切换开关
  const align = page.getByTestId('depth-edge-align')
  await align.click()
  await align.click()
  await page.keyboard.press(' ')
  await expect(align).toHaveJSProperty('checked', true)
})

test('falls back when a model variant is unavailable', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '推理与渲染后端无关，只在一个项目中运行')
  await page.route(/model_q4f16\.onnx/, (r) => r.fulfill({ status: 404, body: '' }))
  await start(page, 'webgpu')
  await waitDone(page)
  await expect(page.getByTestId('depth-model-ready')).toContainText('fp16')
  await expect(page.getByTestId('depth-failures')).toContainText('q4f16')
})

test('switching to WASM reloads the model', async ({ page }, info) => {
  test.skip(info.project.metadata.renderer === 'webgl', '推理与渲染后端无关，只在一个项目中运行')
  await start(page, 'webgpu')
  await waitDone(page)
  await page.getByTestId('depth-device').click()
  await page.getByTestId('depth-device').getByText('WASM（CPU）').click()
  await expect(page.getByTestId('depth-model-ready')).toContainText('WASM · q4', { timeout: 90_000 })
  await waitDone(page)
})
