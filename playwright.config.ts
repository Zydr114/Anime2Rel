import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium, defineConfig } from '@playwright/test'
import { swiftshader } from './tests/e2e/gpu'

// 本地可通过 CHROME_PATH 指定已安装的 Chromium；WebGPU 需要真实 GPU 或软件适配器。
const executablePath = process.env.CHROME_PATH || undefined
const port = 4173
// E2E_GPU=swiftshader：没有 GPU 的环境（GitHub Actions）让 Vulkan 只看到 Chromium 自带的 SwiftShader，
// WebGPU、WebGL2（ANGLE）和页面合成都在这个软件设备上运行。不能用 --use-angle=swiftshader：
// 那样页面改用软件合成，WebGPU 画布无法呈现，设备随即丢失。
// SwiftShader 不支持 shader-f16，最大纹理 8192；在它上面用 WebGPU 推理一张图要几分钟，所以推理固定用 WASM。
const swiftshaderIcd = join(dirname(executablePath ?? chromium.executablePath()), 'vk_swiftshader_icd.json')

// 侧栏分组默认收起（docs/Plan.md §3.7 M8.7）：测试默认展开全部分组，id 都是 <Group> / <More> 的第一个属性
const groups = Object.fromEntries(
  readdirSync('src/app/panels')
    .filter((f) => f.endsWith('.tsx'))
    .flatMap((f) => [...readFileSync(`src/app/panels/${f}`, 'utf8').matchAll(/<(?:Group|More)\s+id="([^"]+)"/g)].map((m) => [m[1], true])),
)

export default defineConfig({
  testDir: 'tests/e2e',
  // 测试会导入 src 中的合成场景生成器，需要 @/ 路径别名
  tsconfig: './tsconfig.node.json',
  timeout: 60_000,
  // 软件渲染一帧要慢得多，等画面变化的断言需要更长时间
  expect: { timeout: swiftshader ? 30_000 : 5_000 },
  // 用例之间没有共享状态，按单个用例分片（CI）；workers 为 1，本地仍逐个运行
  fullyParallel: true,
  workers: 1,
  // 部分用例用固定时长等待后台计算，CI 机器负载高时偶尔不够；重试后通过的用例在报告中标为 flaky
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${port}/`,
    // 默认模型源是魔搭；测试使用构建时下载到站点的模型，不依赖外网。关闭视图左下角的操作提示，以免挡住画布上的点击
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${port}`,
          localStorage: [
            { name: 'a2r.depth.settings', value: JSON.stringify({ version: 2, source: 'self', device: swiftshader ? 'wasm' : 'auto', precision: 'auto' }) },
            { name: 'a2r.ui.groups', value: JSON.stringify(groups) },
            { name: 'a2r.ui.prefs', value: JSON.stringify({ opHints: false, opHintsCollapsed: false }) },
          ],
        },
      ],
    },
    viewport: { width: 1440, height: 900 },
    // 主题默认跟随系统；测试固定使用深色，画布周围是 #1a1a1a（见 tests/e2e/canvas.ts）
    colorScheme: 'dark',
    acceptDownloads: true,
    // 失败后重试时记录 trace，CI 上作为构建产物上传
    trace: 'on-first-retry',
    // 不设置 CHROME_PATH 时用 Playwright 下载的完整 Chromium（新无头模式），而不是精简的 headless shell
    channel: 'chromium',
    launchOptions: {
      executablePath,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', ...(swiftshader ? ['--enable-unsafe-swiftshader'] : [])],
      env: swiftshader ? { ...process.env, VK_DRIVER_FILES: swiftshaderIcd } : undefined,
    },
  },
  projects: [
    { name: 'webgpu', use: { browserName: 'chromium' }, metadata: { renderer: 'webgpu' } },
    { name: 'webgl2', use: { browserName: 'chromium' }, metadata: { renderer: 'webgl' } },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
  },
})
