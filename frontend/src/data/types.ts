/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 廊桥对接检查项：固定清单。放在这里让 seed 与许可层共用同一份，避免循环引用。 */
export const BRIDGE_CHECK_ITEMS = [
  '机位机型限制核对',
  '廊桥设备完好检查',
  '机位区域无障碍确认',
  '对接高度校准',
  '安全联锁确认',
] as const

export type BridgeCheckItem = {
  name: string
  passed: boolean
}

/** 廊桥靠接作业许可：permitNo 即台账行的作业编号，同一份许可重复提交只算一次。 */
export type BridgePermit = {
  permitNo: string
  standCode: string
  flightNo: string
  aircraftType: string
  bridgeNo: string
  operator: string
  startTime: string
  endTime: string
  checks: BridgeCheckItem[]
  /** 提交先后：同一机位撞时段时先提交先上 */
  createdSeq: number
}

export type PermitApplication = {
  permitNo: string
  standCode: string
  flightNo: string
  aircraftType: string
  bridgeNo: string
  operator: string
  startTime: string
  endTime: string
}
