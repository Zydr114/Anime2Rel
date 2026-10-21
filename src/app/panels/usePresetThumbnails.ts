import { useEffect, useState } from 'react'
import type { ThumbnailParams, Thumbnails } from '@/engine/Engine'
import { gradeParams } from '@/grade/params'
import { postParams } from '@/grade/post'
import { presetPost, type Preset } from '@/grade/preset'
import { useDepth } from '@/state/depth'
import { useEngine } from '@/state/engine'
import { isExporting, useExport } from '@/state/export'
import { useFusion } from '@/state/fusion'
import { useApp, type DocState } from '@/state/store'

/** 画面停止变化多久之后重新生成（毫秒） */
const THUMBNAIL_DELAY = 500

type PresetParams = Pick<Preset, 'grade' | 'post'>

/** 套用预设之后同步给引擎的参数，与 Viewport 中的一致 */
function thumbnailParams(preset: PresetParams, doc: DocState): ThumbnailParams {
  const post = presetPost(preset.post, doc.post)
  return { grade: gradeParams(preset.grade), post: postParams(post, doc.lighting, doc.background, doc.camera.fovDeg, doc.focus.dof) }
}

/** 缩略图依赖的画面内容：调色和后期以外的文档、光束和光晕所选的光源，以及深度、融合等异步结果 */
function contentKey(): unknown[] {
  const { doc } = useApp.getState()
  const depth = useDepth.getState()
  const fusion = useFusion.getState()
  return [
    ...Object.entries(doc).flatMap(([key, value]) => (key === 'grade' || key === 'post' ? [] : [value])),
    doc.post.rays.light,
    doc.post.flare.light,
    depth.resultsVersion,
    depth.edgeAlign,
    fusion.background,
    fusion.character,
    fusion.warped,
    fusion.normals,
    fusion.matte,
    useEngine.getState().engine,
    isExporting(),
  ]
}

let canvas: HTMLCanvasElement | null = null

function toDataUrl({ width, height }: Thumbnails, pixels: Uint8Array): string {
  canvas ??= document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/**
 * 预设缩略图（docs/Plan.md §3.7 M8.8a）：用当前画面按每个预设渲染的小图，返回预设 → 图片地址。
 * 打开时生成，画面变化后停止操作约 0.5 s 重新生成；重新生成期间沿用上一组缩略图。
 */
export function usePresetThumbnails(presets: readonly PresetParams[]): ReadonlyMap<PresetParams, string> {
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<PresetParams, string>>(() => new Map())
  useEffect(() => {
    let alive = true
    let key: unknown[] | null = null
    let timer = 0
    let running = false
    let pending = false
    const generate = async () => {
      const engine = useEngine.getState().engine
      if (!engine || isExporting()) return
      // 生成期间画面又变了：这一轮结束后再生成一次
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        const { doc } = useApp.getState()
        const result = await engine.renderThumbnails(presets.map((p) => thumbnailParams(p, doc)))
        if (alive && result) setThumbnails(new Map(presets.map((p, i) => [p, toDataUrl(result, result.pixels[i])])))
      } finally {
        running = false
        if (alive && pending) {
          pending = false
          void generate()
        }
      }
    }
    const check = () => {
      const next = contentKey()
      if (key?.length === next.length && next.every((v, i) => v === key![i])) return
      const first = key === null
      key = next
      window.clearTimeout(timer)
      if (first) void generate()
      else timer = window.setTimeout(() => void generate(), THUMBNAIL_DELAY)
    }
    check()
    const offs = [useApp.subscribe(check), useDepth.subscribe(check), useFusion.subscribe(check), useEngine.subscribe(check), useExport.subscribe(check)]
    return () => {
      alive = false
      window.clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [presets])
  return thumbnails
}
