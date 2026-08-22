export interface AssessResult {
  level: 'high' | 'normal' | 'low'
  text: string
  color: 'danger' | 'success' | 'warning'
}

/** 血压评估：收缩压 90~139、舒张压 60~89 为正常参考范围 */
export function assessBp(systolic: number, diastolic: number): AssessResult {
  if (systolic >= 140 || diastolic >= 90) return { level: 'high', text: '偏高', color: 'danger' }
  if (systolic < 90 || diastolic < 60) return { level: 'low', text: '偏低', color: 'warning' }
  return { level: 'normal', text: '正常', color: 'success' }
}

/** 血糖评估(mmol/L)：<3.9 低血糖，>11.1 偏高 */
export function assessGlucose(value: number): AssessResult {
  if (value > 11.1) return { level: 'high', text: '偏高', color: 'danger' }
  if (value < 3.9) return { level: 'low', text: '偏低', color: 'warning' }
  return { level: 'normal', text: '正常', color: 'success' }
}
