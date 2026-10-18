/** 主线程侧的景深参数换算：从当前文档、深度结果和融合 Worker 的立绘信息得到着色器参数。 */
import { getDepthResult } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import type { DocState } from '@/state/store'
import { focusParams, type FocusInputs, type FocusParams } from './params'

export function focusInputs(doc: DocState): FocusInputs {
  const character = useFusion.getState().character
  return {
    doc,
    background: getDepthResult(doc.background?.id),
    character: getDepthResult(doc.character?.id),
    info: character && character.id === doc.character?.id ? character.info : undefined,
  }
}

/** 没有背景时返回 null */
export function currentFocusParams(doc: DocState): FocusParams | null {
  return doc.background ? focusParams(focusInputs(doc)) : null
}
