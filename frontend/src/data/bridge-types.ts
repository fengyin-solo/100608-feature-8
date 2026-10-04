/** 廊桥靠接作业许可（PTW）领域模型：许可、检查项、限制条件都在这一层核，页面只负责呈现。 */

export type BridgeJobStatus = '待靠接' | '已靠桥' | '已撤离'

// 作业状态只允许按 待靠接 → 已靠桥 → 已撤离 顺序推进，不允许跳步、不允许回退。
export const BRIDGE_STATUS_FLOW: BridgeJobStatus[] = ['待靠接', '已靠桥', '已撤离']

export type CheckState = 'pending' | 'passed' | 'failed'

export interface BridgeCheck {
  key: string
  label: string
  state: CheckState
  remark: string
  checkedAt: string
  checkedBy: string
}

export interface BridgeConstraint {
  key: string
  label: string
  ok: boolean
  detail: string
}

export interface BridgeJob {
  id: number
  jobNo: string
  bridgeNo: string
  standNo: string
  flightNo: string
  aircraftType: string
  planDock: string
  planLeave: string
  /** 实际靠桥时间：许可签发时写入。 */
  dockedAt: string
  /** 实际撤桥时间：确认撤离时写入。 */
  leftAt: string
  operator: string
  status: BridgeJobStatus
  /** 对接检查项逐项存盘，中断后从断掉的那一项接着做。 */
  checks: BridgeCheck[]
  /** 许可编号：同一作业只签发一次，重复提交只算一次。 */
  permitNo: string
  /** 第一次提交许可的时间（即便当时没勾完被挡回也记录），用于同机位抢占裁决。 */
  appliedAt: string
  permittedAt: string
  createdAt: string
}

export interface PermitResult {
  ok: boolean
  message: string
  permitNo?: string
  /** 挡回时逐项指出缺哪一项 / 哪条限制不满足。 */
  missing: string[]
  /** 本次是否新签发许可（false = 被挡回或命中幂等）。 */
  granted: boolean
  /** 是否为同一份许可的重复提交。 */
  idempotent: boolean
}

export interface CreateBridgeJobInput {
  bridgeNo: string
  standNo: string
  flightNo: string
  aircraftType: string
  planDock: string
  planLeave: string
  operator: string
}

// 对接检查项模板：每一条都必须通过，许可才能签发。
export const CHECK_TEMPLATES: { key: string; label: string }[] = [
  { key: 'walkway', label: '廊桥行走通道无障碍物' },
  { key: 'brake', label: '廊桥行走制动与急停装置有效' },
  { key: 'cabin_match', label: '接机口与航空器舱门型号匹配' },
  { key: 'height', label: '廊桥高度与机型舱门限差匹配' },
  { key: 'grounding', label: '接地与防撞装置完好' },
  { key: 'cert', label: '操作人员靠接资质在有效期内' },
  { key: 'weather', label: '风速气象符合靠接条件' },
  { key: 'chock', label: '航空器轮挡已放置到位' },
]

export function blankChecks(): BridgeCheck[] {
  return CHECK_TEMPLATES.map((item) => ({
    key: item.key,
    label: item.label,
    state: 'pending',
    remark: '',
    checkedAt: '',
    checkedBy: '',
  }))
}
