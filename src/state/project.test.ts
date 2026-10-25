import { describe, expect, it } from 'vitest'
import { DEFAULT_FOCUS, DEFAULT_STYLE } from '@/focus/model'
import { gridPoints } from '@/fusion/warp'
import { flarePreset } from '@/grade/flare'
import { newMask } from '@/grade/mask'
import { newBlendLayer } from '@/grade/model'
import { newDirectionalLight, newLightAt } from '@/lighting/model'
import type { AssetRef } from './assets'
import { conformProject, manifestSlots, manifestStep, projectManifest, readManifest, ProjectError } from './project'
import { initialDoc, type DocState } from './store'

const asset = (id: string, width: number, height: number): AssetRef => ({ id, name: `${id}.png`, width, height, sourceWidth: width, sourceHeight: height, hasTransparency: id === 'ch' })
const meta = (key: string) => ({ key: key.padEnd(16, '0'), name: `${key}.png`, type: 'image/png' })

function sampleDoc(): DocState {
  const background = asset('bg', 1000, 800)
  const sun = newDirectionalLight(0.8)
  const lamp = newLightAt({ x: 300, y: 200 }, background, 60, { depth: 0.4, sky: 0 })
  return {
    ...initialDoc,
    background,
    character: asset('ch', 200, 400),
    charTransform: { x: 500, y: 600, scale: 1.5, rotation: 0.2, flipX: true },
    charWarp: { grid: 3, points: gridPoints(3).map((p, i) => (i === 4 ? { x: 0.55, y: 0.45 } : p)), corners: [{ x: 0.1, y: 0 }, { x: 0.9, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
    charDepthEdit: { strokes: [{ mode: 'smooth', radius: 0.04, strength: 0.7, hardness: 0.2, points: [0.3, 0.4, 0.35, 0.42] }] },
    camera: { ...initialDoc.camera, fovDeg: 50, pitch: -0.2, roll: 0.05, confirmed: true, method: 'lines', lines: { first: [[{ x: 0.1, y: 0.8 }, { x: 0.4, y: 0.6 }], [{ x: 0.2, y: 0.95 }, { x: 0.5, y: 0.7 }]], second: [[{ x: 0.6, y: 0.6 }, { x: 0.9, y: 0.8 }], [{ x: 0.5, y: 0.7 }, { x: 0.8, y: 0.95 }]], secondAxis: 'horizontal' } },
    lighting: { lights: [sun, lamp], ambient: 1.3, analyzedFor: 'bg' },
    fusion: { ...initialDoc.fusion, relight: { ...initialDoc.fusion.relight, style: 'cel', rim: 1.2 }, depth: 0.42, ground: { u: 0.5, v: 0.9 } },
    focus: {
      ...DEFAULT_FOCUS,
      dof: { ...DEFAULT_FOCUS.dof, blades: 6 },
      target: { kind: 'background', x: 100, y: 80 },
      occlusion: { ...DEFAULT_FOCUS.occlusion, enabled: true, mode: 'water', reflection: 0.6, waterColor: '#9fc4d0', regions: [{ ...DEFAULT_STYLE, mode: 'medium', id: 'region-x', strokes: [{ erase: false, radius: 12, points: [10, 20, 30, 40] }] }] },
    },
    atmosphere: { fog: { ...initialDoc.atmosphere.fog, density: 0.4, falloff: 0.3, color: '#c0d0e0', sky: true }, dust: { ...initialDoc.atmosphere.dust, amount: 0.6, near: 1, far: 20, seed: 42 } },
    grade: { ...initialDoc.grade, creative: { ...initialDoc.grade.creative, layers: [{ ...newBlendLayer(), opacity: 0.3 }] } },
    masks: [
      { ...newMask(background), invert: true, ellipse: { x: 400, y: 300, rx: 200, ry: 100, rotation: 0.5, feather: 0.3 }, adjust: { ...newMask(background).adjust, exposure: -1.5, color: '#3366cc', mode: 'overlay', opacity: 0.4 } },
      { ...newMask(background), shape: 'brush', enabled: false, strokes: [{ erase: false, radius: 30, points: [100, 200, 300, 400] }], range: { kind: 'depth', near: true, depth: 0.7, softness: 0.2, low: 0, high: 1 } },
    ],
    post: {
      ...initialDoc.post,
      rays: { ...initialDoc.post.rays, intensity: 0.5, light: lamp.id },
      flare: { ...initialDoc.post.flare, enabled: true, light: sun.id, elements: flarePreset('star') },
    },
  }
}

/** 把会重新分配的 id 换成序号，便于比较 */
function withoutIds(doc: DocState) {
  const lights = doc.lighting.lights.map((l) => l.id)
  return {
    ...doc,
    background: null,
    character: null,
    lighting: { ...doc.lighting, analyzedFor: null, lights: doc.lighting.lights.map((l, i) => ({ ...l, id: i })) },
    focus: { ...doc.focus, occlusion: { ...doc.focus.occlusion, regions: doc.focus.occlusion.regions.map((r) => ({ ...r, id: 0 })) } },
    grade: { ...doc.grade, creative: { ...doc.grade.creative, layers: doc.grade.creative.layers.map((l) => ({ ...l, id: 0 })) } },
    masks: doc.masks.map((m) => ({ ...m, id: 0 })),
    post: {
      ...doc.post,
      rays: { ...doc.post.rays, light: doc.post.rays.light && lights.indexOf(doc.post.rays.light) },
      flare: { ...doc.post.flare, light: doc.post.flare.light && lights.indexOf(doc.post.flare.light), elements: doc.post.flare.elements.map((e) => ({ ...e, id: 0 })) },
    },
  }
}

const roundTrip = (doc: DocState, slots: { background: AssetRef; character: AssetRef | null }) =>
  conformProject(readManifest(JSON.stringify(projectManifest(doc, 'lens', { background: meta('bg'), character: meta('ch') }))), slots)

describe('project', () => {
  it('restores every parameter and remaps ids', () => {
    const doc = sampleDoc()
    const restored = roundTrip(doc, { background: asset('bg2', 1000, 800), character: asset('ch2', 200, 400) })
    expect(withoutIds(restored)).toEqual(withoutIds(doc))
    expect(restored.lighting.analyzedFor).toBe('bg2')
    expect(restored.post.rays.light).toBe(restored.lighting.lights[1].id)
    expect(restored.lighting.lights[0].id).not.toBe(doc.lighting.lights[0].id)
  })

  it('records the asset keys of both slots and the step', () => {
    const manifest = readManifest(JSON.stringify(projectManifest(sampleDoc(), 'fusion', { background: meta('bg'), character: meta('ch') })))
    expect(manifestSlots(manifest)).toEqual({ background: meta('bg').key, character: meta('ch').key })
    expect(manifestStep(manifest)).toBe('fusion')
    // M8.7 之前的步骤
    expect(['camera', 'depth', 'character', 'light', 'focus', 'effects', 'adjust', 'toString', 'nope'].map((step) => manifestStep({ ...manifest, step }))).toEqual([
      'scene',
      'scene',
      'place',
      'fusion',
      'lens',
      'lens',
      'adjust',
      'assets',
      'assets',
    ])
  })

  it('rescales coordinates when the bitmaps are decoded at another size', () => {
    const restored = roundTrip(sampleDoc(), { background: asset('bg2', 500, 400), character: asset('ch2', 100, 200) })
    expect(restored.charTransform).toMatchObject({ x: 250, y: 300 })
    // 立绘位图也缩小一半：在文档中的大小 = 1.5 × 200 × 0.5 → scale × 100
    expect(restored.charTransform.scale).toBeCloseTo(1.5)
    expect(restored.lighting.lights[1].position).toMatchObject({ x: 150, y: 100 })
    expect(restored.focus.occlusion.regions[0].strokes[0]).toEqual({ erase: false, radius: 6, points: [5, 10, 15, 20] })
    expect(restored.masks[0].ellipse).toEqual({ x: 200, y: 150, rx: 100, ry: 50, rotation: 0.5, feather: 0.3 })
    expect(restored.masks[0].linear).toEqual({ x0: 250, y0: 400, x1: 250, y1: 200 })
    expect(restored.masks[1].strokes[0]).toEqual({ erase: false, radius: 15, points: [50, 100, 150, 200] })
  })

  it('replaces invalid values with defaults or clamps them', () => {
    const manifest = projectManifest(sampleDoc(), 'lens', { background: meta('bg'), character: meta('ch') }) as { doc: Record<string, Record<string, unknown>> }
    manifest.doc.fusion.relight = { style: 'evil', strength: 99, rim: 'x' }
    manifest.doc.focus.dof = { blades: 7, aperture: -1 }
    manifest.doc.lighting.lights = [{ type: 'laser' }, { type: 'directional', direction: [0, 0, 0], intensity: Infinity }]
    manifest.doc.atmosphere = { fog: { density: 5, start: -3, color: 'blue', noiseSize: 0 }, dust: { amount: 'lots', far: 1e9, seed: 3.6 } }
    manifest.doc.masks = Array.from({ length: 12 }, () => ({ shape: 'star', range: { kind: 'evil', softness: 3 }, adjust: { exposure: 99, mode: 'evil', color: 'red' } })) as never
    const doc = conformProject(readManifest(JSON.stringify(manifest)), { background: asset('bg', 1000, 800), character: null })
    expect(doc.fusion.relight).toMatchObject({ style: 'realistic', strength: 1, rim: initialDoc.fusion.relight.rim })
    expect(doc.focus.dof).toMatchObject({ blades: 0, aperture: 0 })
    expect(doc.lighting.lights).toHaveLength(1)
    expect(doc.lighting.lights[0].direction).toEqual([0, 0, 1])
    expect(doc.atmosphere.fog).toMatchObject({ density: 1, start: 0, color: null, noiseSize: 0.5 })
    expect(doc.atmosphere.dust).toMatchObject({ amount: 0, far: 100, seed: 4 })
    expect(doc.masks).toHaveLength(8)
    expect(doc.masks[0]).toMatchObject({ shape: 'ellipse', range: { kind: 'all', softness: 0.5 }, adjust: { exposure: 5, mode: 'soft-light', color: '#ff9d4d' } })
    // 没有立绘时，立绘上的接地点没有意义
    expect(doc.fusion.ground).toBeNull()
  })

  it('rejects other files and newer versions', () => {
    expect(() => readManifest('{"format":"anime2real-preset","version":1}')).toThrow(ProjectError)
    expect(() => readManifest('{"format":"anime2real-project","version":99}')).toThrow(ProjectError)
  })
})
