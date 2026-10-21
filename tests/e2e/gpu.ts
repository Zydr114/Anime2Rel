/**
 * E2E_GPU=swiftshader：没有 GPU 的环境（GitHub Actions）用 Chromium 自带的 SwiftShader 软件渲染，见 playwright.config.ts。
 * 这时渲染慢得多，用例用 test.slow(swiftshader) 放宽超时；推理固定用 WASM。
 */
export const swiftshader = process.env.E2E_GPU === 'swiftshader'
