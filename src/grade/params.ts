/** 基础调整的着色器参数（src/engine/grade.ts），由文档参数换算。 */
import { mat3Mul, type Mat3 } from '@/algo/cat'
import { curveLut, whiteBalanceMatrix, type CurveLut, type LocalAdjust, type PointAdjust } from './color'
import { CURVE_CHANNELS, GRADE_LEVELS, isIdentityCurve, isNeutralAdjust, type BasicAdjust, type CurveChannel, type CurvePoints, type GradeDoc, type GradeLevel } from './model'

export interface AdjustParams extends PointAdjust, LocalAdjust {
  /** 有任何调整；否则着色器直接输出原色 */
  active: boolean
  /** 有局部调整，需要先计算 log2 亮度的金字塔和引导滤波系数 */
  local: boolean
}

export type GradeParams = Record<GradeLevel, AdjustParams>

const curveCache = new WeakMap<Record<CurveChannel, CurvePoints>, CurveLut | null>()
const paramsCache = new WeakMap<BasicAdjust, AdjustParams>()

function cachedCurve(curves: Record<CurveChannel, CurvePoints>): CurveLut | null {
  let lut = curveCache.get(curves)
  if (lut === undefined) {
    lut = CURVE_CHANNELS.every((c) => isIdentityCurve(curves[c])) ? null : curveLut(curves)
    curveCache.set(curves, lut)
  }
  return lut
}

/** 同一个参数对象返回同一个结果，引擎据此判断背景层是否需要重算 */
export function adjustParams(a: BasicAdjust): AdjustParams {
  const cached = paramsCache.get(a)
  if (cached) return cached
  const gain = 2 ** a.exposure
  const exposure: Mat3 = [gain, 0, 0, 0, gain, 0, 0, 0, gain]
  const params: AdjustParams = {
    active: !isNeutralAdjust(a),
    local: a.highlights !== 0 || a.shadows !== 0 || a.clarity !== 0 || a.sharpen !== 0,
    wb: mat3Mul(exposure, whiteBalanceMatrix(a.temperature, a.tint)),
    contrast: a.contrast,
    whites: a.whites,
    blacks: a.blacks,
    hsl: a.hsl,
    vibrance: a.vibrance,
    saturation: a.saturation,
    curve: cachedCurve(a.curves),
    highlights: a.highlights,
    shadows: a.shadows,
    clarity: a.clarity,
    sharpen: a.sharpen,
  }
  paramsCache.set(a, params)
  return params
}

export function gradeParams(grade: GradeDoc): GradeParams {
  return Object.fromEntries(GRADE_LEVELS.map((level) => [level, adjustParams(grade.levels[level])])) as GradeParams
}
