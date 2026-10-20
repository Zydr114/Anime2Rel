/**
 * 相机标定（docs/Plan.md §3.7 M8.5）：视场角、俯仰、倾斜决定画面中的地平线和世界的上方向，主点固定在画面中心。
 * 标定有两种方式：拖动地平线，或沿照片中两组互相垂直的平行边各画两条线（消失点标定）。
 * 导入背景后要求用户先确认标定；更换背景后标定作废。
 */
import type { Point } from '@/algo/geometry'

export const CALIBRATION_METHODS = ['horizon', 'lines'] as const
export type CalibrationMethod = (typeof CALIBRATION_METHODS)[number]

/** 第二组平行线的方向：与第一组垂直的水平方向，或竖直方向 */
export const LINE_AXES = ['horizontal', 'vertical'] as const
export type LineAxis = (typeof LINE_AXES)[number]

/** 线段的两端（文档 UV） */
export type Segment = [Point, Point]

export interface CameraLines {
  /** 第一组：沿地面上某个水平方向的两条平行边 */
  first: [Segment, Segment]
  /** 第二组：与第一组垂直的方向 */
  second: [Segment, Segment]
  secondAxis: LineAxis
}

export interface CameraDoc {
  /** 长边方向的视场角（度） */
  fovDeg: number
  /** 俯仰（弧度）：光轴相对水平面的角度，向上为正 */
  pitch: number
  /** 倾斜（弧度）：地平线在画面中的旋转角，逆时针为正 */
  roll: number
  /** 地面网格的朝向（弧度）：绕世界的上方向，相对相机横轴在地面上的投影 */
  yaw: number
  /** 相机离地的高度（米）：只用来换算地面网格的间距和人物的身高读数 */
  height: number
  method: CalibrationMethod
  /** 平行线方式的线段；还没有用过这种方式时为 null，切换过去时按当前的标定生成 */
  lines: CameraLines | null
  /** 用户是否已经确认过标定 */
  confirmed: boolean
}

export const FOV_RANGE: readonly [number, number] = [15, 120]
/** 俯仰与倾斜的范围（弧度） */
export const PITCH_LIMIT = (80 * Math.PI) / 180
export const ROLL_LIMIT = (45 * Math.PI) / 180
export const HEIGHT_RANGE: readonly [number, number] = [0.1, 100]

/** 初始结果：相机水平、地平线在画面正中（即 M8.4 之前的假设） */
export const DEFAULT_CAMERA: CameraDoc = {
  fovDeg: 60,
  pitch: 0,
  roll: 0,
  yaw: 0,
  height: 1.6,
  method: 'horizon',
  lines: null,
  confirmed: false,
}
