import { defineConfig } from '@playwright/test'

// 本地可通过 CHROME_PATH 指定已安装的 Chromium；WebGPU 需要真实 GPU 或软件适配器。
const executablePath = process.env.CHROME_PATH || undefined
const port = 4173

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
    // 默认模型源是魔搭；测试使用构建时下载到站点的模型，不依赖外网
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'a2r.depth.settings', value: JSON.stringify({ version: 2, source: 'self', device: 'auto', precision: 'auto' }) }] }],
    },
    viewport: { width: 1440, height: 900 },
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
