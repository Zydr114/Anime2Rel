import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// 本地可通过 CHROME_PATH 指定已安装的 Chromium；WebGPU 需要真实 GPU 或软件适配器。
const executablePath = process.env.CHROME_PATH || undefined
const port = 4173

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
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}/`,
    // 默认模型源是魔搭；测试使用构建时下载到站点的模型，不依赖外网。关闭视图左下角的操作提示，以免挡住画布上的点击
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${port}`,
          localStorage: [
            { name: 'a2r.depth.settings', value: JSON.stringify({ version: 2, source: 'self', device: 'auto', precision: 'auto' }) },
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
    launchOptions: {
      executablePath,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
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
