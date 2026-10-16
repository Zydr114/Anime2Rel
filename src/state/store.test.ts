import { beforeEach, describe, expect, it } from 'vitest'
import { initialDoc, useApp } from './store'
import type { AssetRef } from './assets'

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
