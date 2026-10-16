import { describe, expect, it } from 'vitest'
import { defaultLayerTransform, docToLayerUV, docToScreen, fitView, fitWithin, layerCorners, layerToDoc, screenToDoc, zoomAt } from './geometry'

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('view transform', () => {
  it('fits and centers the document', () => {
    const v = fitView({ width: 3000, height: 4000 }, { width: 1000, height: 1000 }, 0)
    close(v.zoom, 0.25)
    close(v.panX, (1000 - 750) / 2)
    close(v.panY, 0)
  })

  it('centers the document inside the unobstructed area', () => {
    const v = fitView({ width: 100, height: 100 }, { width: 1000, height: 600 }, 0, { left: 100, right: 300, top: 0, bottom: 100 })
    close(v.zoom, 5)
    close(v.panX, 100 + (600 - 500) / 2)
    close(v.panY, 0)
  })

  it('round-trips doc and screen coordinates', () => {
    const v = { zoom: 0.37, panX: 12, panY: -40 }
    const p = screenToDoc(v, docToScreen(v, { x: 123, y: 456 }))
    close(p.x, 123)
    close(p.y, 456)
  })

  it('keeps the anchor fixed when zooming', () => {
    const v = { zoom: 0.5, panX: 10, panY: 20 }
    const anchor = { x: 300, y: 200 }
    const before = screenToDoc(v, anchor)
    const after = screenToDoc(zoomAt(v, 1.7, anchor), anchor)
    close(before.x, after.x)
    close(before.y, after.y)
  })
})

describe('layer transform', () => {
  const size = { width: 200, height: 400 }

  it('maps layer corners back to UV corners', () => {
    const t = { x: 500, y: 600, scale: 1.5, rotation: 0.7, flipX: true }
    const uvs = layerCorners(t, size).map((p) => docToLayerUV(t, size, p))
    const expected = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    uvs.forEach((uv, i) => {
      close(uv.x, expected[i][0])
      close(uv.y, expected[i][1])
    })
  })

  it('rotates clockwise in y-down space', () => {
    const t = { x: 0, y: 0, scale: 1, rotation: Math.PI / 2, flipX: false }
    const p = layerToDoc(t, { x: 10, y: 0 })
    close(p.x, 0)
    close(p.y, 10)
  })

  it('places the default layer inside the document, bottom aligned', () => {
    const doc = { width: 3072, height: 4096 }
    const t = defaultLayerTransform(doc, { width: 1000, height: 2000 })
    const corners = layerCorners(t, { width: 1000, height: 2000 })
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x).toBeLessThanOrEqual(doc.width)
    }
    close(corners[2].y, doc.height * 0.98, 1e-6)
  })

  it('limits preview size by long edge', () => {
    expect(fitWithin({ width: 3072, height: 4096 }, 2048)).toEqual({ width: 1536, height: 2048 })
    expect(fitWithin({ width: 800, height: 600 }, 2048)).toEqual({ width: 800, height: 600 })
  })
})
