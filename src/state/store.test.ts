import { beforeEach, describe, expect, it } from 'vitest'
import { initialDoc, useApp } from './store'
import type { AssetRef } from './assets'
import type { LightCandidate } from '@/analysis/protocol'
import { MAX_REGIONS } from '@/focus/model'
import { DEFAULT_FUSION } from '@/fusion/model'
import { lightsFromCandidates, MAX_LIGHTS, newDirectionalLight } from '@/lighting/model'

const asset = (id: string, width = 1000, height = 800): AssetRef => ({
  id,
  name: id,
  width,
  height,
  sourceWidth: width,
  sourceHeight: height,
  hasTransparency: false,
})

beforeEach(() => {
  useApp.setState({ doc: initialDoc, past: [], future: [], gestureBase: null, viewport: { width: 800, height: 600 } })
})

describe('history', () => {
  it('undoes and redoes discrete edits', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg'))
    s.setCharTransform({ x: 10 })
    s.setCharTransform({ x: 20 })
    expect(useApp.getState().doc.charTransform.x).toBe(20)
    useApp.getState().undo()
    expect(useApp.getState().doc.charTransform.x).toBe(10)
    useApp.getState().redo()
    expect(useApp.getState().doc.charTransform.x).toBe(20)
  })

  it('records a gesture as a single history entry', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg'))
    const before = useApp.getState().past.length
    s.beginGesture()
    for (let i = 1; i <= 10; i++) useApp.getState().setCharTransform({ x: i })
    useApp.getState().endGesture()
    expect(useApp.getState().past.length).toBe(before + 1)
    useApp.getState().undo()
    expect(useApp.getState().doc.charTransform.x).toBe(0)
  })

  it('does not record empty gestures', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg'))
    const before = useApp.getState().past.length
    s.beginGesture()
    s.endGesture()
    expect(useApp.getState().past.length).toBe(before)
  })

  it('does not record the first background import', () => {
    useApp.getState().setBackground(asset('bg'))
    expect(useApp.getState().past.length).toBe(0)
    useApp.getState().setBackground(asset('bg2'))
    expect(useApp.getState().past.length).toBe(1)
    useApp.getState().undo()
    expect(useApp.getState().doc.background?.id).toBe('bg')
  })

  it('clears redo after a new edit', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg'))
    s.setCharTransform({ x: 5 })
    useApp.getState().undo()
    useApp.getState().setCharTransform({ x: 7 })
    expect(useApp.getState().future.length).toBe(0)
  })
})

describe('layers', () => {
  it('places a new character with the default transform', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg', 3000, 4000))
    s.setCharacter({ ...asset('ch', 1000, 2000), hasTransparency: true })
    const t = useApp.getState().doc.charTransform
    expect(t.x).toBe(1500)
    expect(t.scale).toBeCloseTo(1.6)
  })

  it('places a character added before the background once the background arrives', () => {
    const s = useApp.getState()
    s.setCharacter(asset('ch', 1000, 2000))
    useApp.getState().setBackground(asset('bg', 3000, 4000))
    expect(useApp.getState().doc.charTransform.x).toBe(1500)
  })

  it('keeps the character relative placement when the background size changes', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg', 1000, 1000))
    s.setCharacter(asset('ch', 100, 100))
    s.setCharTransform({ x: 250, y: 500, scale: 2 })
    useApp.getState().setBackground(asset('bg2', 2000, 2000))
    const t = useApp.getState().doc.charTransform
    expect(t).toMatchObject({ x: 500, y: 1000, scale: 4 })
  })
})

describe('lights', () => {
  const candidate = (type: 'directional' | 'point', confidence: number): LightCandidate => ({
    type,
    direction: [0, 1, 0],
    position: type === 'point' ? { u: 0.25, v: 0.5, depth: 0.6 } : null,
    color: [1, 1, 1],
    intensity: 0.4,
    softness: 0.2,
    confidence,
    sources: ['A'],
  })

  it('enables only the strongest directional candidate', () => {
    const lights = lightsFromCandidates([candidate('directional', 0.8), candidate('point', 0.5), candidate('directional', 0.6)], { width: 1000, height: 800 })
    expect(lights.map((l) => l.enabled)).toEqual([true, true, false])
    expect(lights[1].position).toEqual({ x: 250, y: 400, depth: 0.6 })
  })

  it('replaces candidates in place after a background change, so undo restores both together', () => {
    const s = useApp.getState()
    s.setBackground(asset('a'))
    s.replaceLights([newDirectionalLight()], 'a', false)
    s.setBackground(asset('b'))
    useApp.getState().replaceLights([newDirectionalLight(), newDirectionalLight()], 'b', false)
    expect(useApp.getState().doc.lighting.lights).toHaveLength(2)
    useApp.getState().undo()
    expect(useApp.getState().doc.background?.id).toBe('a')
    expect(useApp.getState().doc.lighting).toMatchObject({ analyzedFor: 'a', lights: [expect.anything()] })
    useApp.getState().redo()
    expect(useApp.getState().doc.lighting.lights).toHaveLength(2)
  })

  it('records edits and explicit re-analysis', () => {
    const s = useApp.getState()
    s.setBackground(asset('a'))
    const light = newDirectionalLight()
    s.addLight(light)
    useApp.getState().updateLight(light.id, { intensity: 2 })
    useApp.getState().replaceLights([], 'a', true)
    expect(useApp.getState().doc.lighting.lights).toHaveLength(0)
    useApp.getState().undo()
    expect(useApp.getState().doc.lighting.lights[0].intensity).toBe(2)
    useApp.getState().undo()
    useApp.getState().undo()
    expect(useApp.getState().doc.lighting.lights).toHaveLength(0)
  })

  it('caps the number of lights', () => {
    const s = useApp.getState()
    for (let i = 0; i < MAX_LIGHTS; i++) expect(s.addLight(newDirectionalLight())).toBe(true)
    expect(s.addLight(newDirectionalLight())).toBe(false)
  })
})

describe('fusion', () => {
  it('merges section updates and keeps the character depth and ground point on reset', () => {
    const s = useApp.getState()
    s.updateFusion('relight', { style: 'cel' })
    useApp.getState().setCharDepth(0.4)
    useApp.getState().setCharGround({ u: 0.4, v: 0.9 })
    useApp.getState().resetFusion()
    expect(useApp.getState().doc.fusion).toEqual({ ...DEFAULT_FUSION, depth: 0.4, ground: { u: 0.4, v: 0.9 } })
    useApp.getState().undo()
    expect(useApp.getState().doc.fusion.relight).toEqual({ ...DEFAULT_FUSION.relight, style: 'cel' })
    // 接地点只对原来的立绘有意义
    useApp.getState().setCharacter(asset('ch2', 100, 200))
    expect(useApp.getState().doc.fusion.ground).toBeNull()
  })
})

describe('focus', () => {
  it('scales a background focus point with the background and drops a character focus point with the character', () => {
    const s = useApp.getState()
    s.setBackground(asset('bg', 1000, 800))
    useApp.getState().setFocus({ target: { kind: 'background', x: 100, y: 80 } })
    useApp.getState().setBackground(asset('bg2', 2000, 1600))
    expect(useApp.getState().doc.focus.target).toEqual({ kind: 'background', x: 200, y: 160 })

    useApp.getState().setFocus({ target: { kind: 'character', u: 0.5, v: 0.2 } })
    useApp.getState().setCharacter(asset('ch', 100, 200))
    expect(useApp.getState().doc.focus.target).toBeNull()
  })

  it('caps occlusion regions, records each stroke as one step, keeps regions on reset and scales them with the background', () => {
    useApp.getState().setBackground(asset('bg', 1000, 800))
    const ids = Array.from({ length: MAX_REGIONS + 1 }, () => useApp.getState().addRegion())
    expect(ids.filter(Boolean)).toHaveLength(MAX_REGIONS)
    expect(ids[MAX_REGIONS]).toBeNull()
    const id = ids[0]!
    useApp.getState().addRegionStroke(id, { erase: false, radius: 10, points: [100, 80, 200, 80] })
    useApp.getState().addRegionStroke(id, { erase: true, radius: 5, points: [150, 80] })
    useApp.getState().undo()
    expect(useApp.getState().doc.focus.occlusion.regions[0].strokes).toHaveLength(1)
    useApp.getState().resetFocus()
    expect(useApp.getState().doc.focus.occlusion.regions).toHaveLength(MAX_REGIONS)
    useApp.getState().setBackground(asset('bg2', 2000, 1600))
    expect(useApp.getState().doc.focus.occlusion.regions[0].strokes[0]).toEqual({ erase: false, radius: 20, points: [200, 160, 400, 160] })
  })
})
