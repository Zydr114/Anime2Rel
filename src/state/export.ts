import { create } from 'zustand'
import type { ImageFormat } from '@/io/encode'

/** 导出设置与进度（不属于文档，不进入撤销和工程文件） */
interface ExportState {
  format: ImageFormat
  /** JPEG、WebP 的质量（0–1） */
  quality: number
  /** 导出进度（0–1）；null 为没有在导出 */
  progress: number | null
  setFormat: (format: ImageFormat) => void
  setQuality: (quality: number) => void
  setProgress: (progress: number | null) => void
}

export const DEFAULT_QUALITY = 0.92

export const useExport = create<ExportState>()((set) => ({
  format: 'png',
  quality: DEFAULT_QUALITY,
  progress: null,
  setFormat: (format) => set({ format }),
  setQuality: (quality) => set({ quality }),
  setProgress: (progress) => set({ progress }),
}))

/** 正在导出：引擎逐块渲染，期间视口不向引擎同步文档的变化 */
export const isExporting = () => useExport.getState().progress !== null
