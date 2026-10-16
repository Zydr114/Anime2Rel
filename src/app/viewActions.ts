import { zoomAt } from '@/algo/geometry'
import { useApp } from '@/state/store'

/** 以视口中心为锚点缩放。 */
export function zoomBy(factor: number): void {
  const s = useApp.getState()
  s.setView(zoomAt(s.view, factor, { x: s.viewport.width / 2, y: s.viewport.height / 2 }))
}

/** 缩放到 100%（一个文档像素对应一个 CSS 像素）。 */
export function zoomToActual(): void {
  zoomBy(1 / useApp.getState().view.zoom)
}
