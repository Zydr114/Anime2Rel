import { t } from '@/i18n'
import type { Light } from '@/lighting/model'

/** 光源在列表中的名称：同类型按出现顺序编号 */
export function lightName(lights: readonly Light[], light: Light): string {
  const n = lights.filter((l) => l.type === light.type).indexOf(light) + 1
  return `${t.light.types[light.type]} ${n}`
}
