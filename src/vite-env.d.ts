/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
/** 当前构建对应的源码地址（AGPL §13） */
declare const __SOURCE_URL__: string

/** 由 scripts/vite-plugin-ort-runtime.ts 生成：ONNX Runtime WebAssembly 运行时的分片清单 */
declare module 'virtual:ort-runtime' {
  const runtime: { files: string[]; size: number; sha256: string }
  export default runtime
}
