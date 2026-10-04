import { listRows, saveRows } from '@/data/local-store'
import { blankChecks } from '@/data/bridge-types'
import type {
  BridgeCheck,
  BridgeConstraint,
  BridgeJob,
  CreateBridgeJobInput,
  PermitResult,
} from '@/data/bridge-types'
import { listBridgeJobs, resetBridgeJobs, saveBridgeJobs } from '@/data/bridge-store'
import type { EntryRow } from '@/data/types'

// 廊桥靠接作业许可：限制条件核对、顺序状态机、检查项断点续做、机位台账同步都在这里收口。

export const BRIDGE_ENTITY = '廊桥作业'

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function toTime(value: string): number {
  return new Date(value.replace(' ', 'T')).getTime()
}

// 两个作业时段是否重叠（端点相接不算重叠）。
function overlaps(a: BridgeJob, b: BridgeJob): boolean {
  if (!a.planDock || !a.planLeave || !b.planDock || !b.planLeave) {
    return false
  }
  const as = toTime(a.planDock)
  const ae = toTime(a.planLeave)
  const bs = toTime(b.planDock)
  const be = toTime(b.planLeave)
  if ([as, ae, bs, be].some((t) => Number.isNaN(t))) {
    return false
  }
  return as < be && bs < ae
}

function findStand(standNo: string): EntryRow | undefined {
  return listRows('stand').find((row) => String(row['机位编号']) === standNo)
}

function isActive(job: BridgeJob): boolean {
  return job.status === '待靠接' || job.status === '已靠桥'
}

function checkSummary(job: BridgeJob): string {
  const passed = job.checks.filter((c) => c.state === 'passed').length
  return `${passed}/${job.checks.length}`
}

function failedReasons(job: BridgeJob): string[] {
  return job.checks
    .filter((c) => c.state !== 'passed')
    .map((c) => (c.state === 'failed' ? `检查项「${c.label}」不通过（${c.remark || '待整改'}）` : `检查项「${c.label}」尚未完成`))
}

// 把领域作业投影成通用条目，列表、看板、导出都读同一份许可结论。
export function jobToRow(job: BridgeJob): EntryRow {
  return {
    id: job.id,
    status: job.status,
    pending: job.status !== '已撤离',
    abnormal: false,
    作业编号: job.jobNo,
    廊桥编号: job.bridgeNo,
    对应机位: job.standNo,
    航班号: job.flightNo,
    机型: job.aircraftType,
    计划靠桥: job.planDock,
    计划撤离: job.planLeave,
    靠桥时间: job.dockedAt,
    撤桥时间: job.leftAt,
    操作人员: job.operator,
    许可编号: job.permitNo,
    检查结论: checkSummary(job),
    作业状态: job.status,
  }
}

export function getBridgeJobs(): BridgeJob[] {
  return listBridgeJobs().map((job) => JSON.parse(JSON.stringify(job)) as BridgeJob)
}

export function getBridgeJob(id: number): BridgeJob | undefined {
  return getBridgeJobs().find((job) => job.id === id)
}

export function listBridgeRows(): EntryRow[] {
  return getBridgeJobs().map(jobToRow)
}

// 靠接前按对应机位与机型核限制条件；同机位同时段冲突时按「先申请先得，同时申请作业编号小者优先」裁决。
export function evaluateConstraints(job: BridgeJob): BridgeConstraint[] {
  const stand = findStand(job.standNo)
  const result: BridgeConstraint[] = []

  result.push({
    key: 'stand_exists',
    label: '机位存在',
    ok: Boolean(stand),
    detail: stand ? `机位 ${job.standNo} 已在机位台账登记` : `机位 ${job.standNo} 未在机位台账登记`,
  })

  const standStatus = stand ? String(stand.status) : ''
  result.push({
    key: 'stand_open',
    label: '机位可作业',
    ok: standStatus === '空闲' || standStatus === '占用中',
    detail: stand ? (standStatus === '空闲' || standStatus === '占用中' ? `机位当前「${standStatus}」，允许靠接` : `机位当前「${standStatus}」，禁止靠接`) : '无机位状态',
  })

  const acceptedTypes = stand ? String(stand['适用机型'] ?? '').split(/[/、,，\s]+/).filter(Boolean) : []
  const typeOk = acceptedTypes.length > 0 && acceptedTypes.includes(job.aircraftType)
  result.push({
    key: 'aircraft_type',
    label: '机型与机位适配',
    ok: typeOk,
    detail: stand ? (typeOk ? `机型 ${job.aircraftType} 在机位适用范围（${acceptedTypes.join('/')}）内` : `机型 ${job.aircraftType} 超出机位 ${job.standNo} 适用机型（${acceptedTypes.join('/') || '未配置'}）`) : '无机位适用机型配置',
  })

  const bridgeConfig = stand ? String(stand['廊桥配置'] ?? '') : ''
  const hasBridge = bridgeConfig.includes('廊桥') && !bridgeConfig.includes('无')
  result.push({
    key: 'bridge_config',
    label: '机位廊桥配置',
    ok: hasBridge,
    detail: stand ? (hasBridge ? `机位已配置廊桥（${bridgeConfig}）` : `机位廊桥配置为「${bridgeConfig || '未配置'}」，无法廊桥靠接`) : '无机位廊桥配置',
  })

  const nearFar = stand ? String(stand['近远机位'] ?? '') : ''
  result.push({
    key: 'near_stand',
    label: '近机位作业',
    ok: nearFar.includes('近'),
    detail: stand ? (nearFar.includes('近') ? `机位为${nearFar}，可由廊桥对接` : `机位为${nearFar || '未标注'}，廊桥无法对接`) : '无机位近远属性',
  })

  const timeOk = Boolean(job.planDock && job.planLeave && toTime(job.planLeave) > toTime(job.planDock))
  result.push({
    key: 'time_window',
    label: '靠接时段完整',
    ok: timeOk,
    detail: timeOk ? `时段 ${job.planDock} 至 ${job.planLeave}` : '计划靠桥/撤离时间缺失或撤桥早于靠桥',
  })

  result.push({
    key: 'operator',
    label: '操作人员在岗',
    ok: job.operator.trim().length > 0,
    detail: job.operator.trim() ? `操作人员 ${job.operator}` : '未指派操作人员',
  })

  const rival = getBridgeJobs()
    .filter((other) => other.id !== job.id && other.standNo === job.standNo && isActive(other) && overlaps(other, job))
    .sort((a, b) => {
      // 已靠桥的恒排在前；其次按申请先后，同秒则编号小者优先（先申请先得）。
      if (a.status !== b.status) {
        return a.status === '已靠桥' ? -1 : 1
      }
      if (a.appliedAt === b.appliedAt) {
        return a.id - b.id
      }
      return a.appliedAt.localeCompare(b.appliedAt)
    })[0]

  let slotOk = true
  let slotDetail = `机位 ${job.standNo} 在 ${job.planDock}~${job.planLeave} 暂无其他在办靠接作业`
  if (rival) {
    // 已持许可靠桥的作业物理占着机位，恒优先；待靠接作业之间按申请先后，同秒则编号小者优先。
    const rivalFirst =
      rival.status === '已靠桥' ||
      (rival.appliedAt !== '' &&
        (job.appliedAt === '' ||
          rival.appliedAt < job.appliedAt ||
          (rival.appliedAt === job.appliedAt && rival.id < job.id)))
    if (rivalFirst) {
      slotOk = false
      slotDetail = `机位时段与 ${rival.jobNo}（${rival.flightNo}，${rival.planDock}~${rival.planLeave}，${rival.appliedAt || rival.createdAt} 先申请）冲突，同一机位同一时段只允许一条在办作业`
    } else {
      slotDetail = `与 ${rival.jobNo} 时段重叠，但本作业申请在先，优先权归本作业`
    }
  } else if (!timeOk) {
    slotDetail = '作业时段无效，无法比对占用'
  }
  result.push({ key: 'stand_slot', label: '同机位时段独占', ok: slotOk, detail: slotDetail })

  return result
}

function persist(jobs: BridgeJob[], changed: BridgeJob): void {
  const idx = jobs.findIndex((j) => j.id === changed.id)
  if (idx >= 0) {
    jobs[idx] = changed
  }
  saveBridgeJobs(jobs)
  syncStandLedger(changed)
}

// 许可与检查结论同步到停机位占用台账：台账读到的当前航班、许可、结论都以本作业为准。
function syncStandLedger(job: BridgeJob): void {
  const stands = listRows('stand')
  const index = stands.findIndex((row) => String(row['机位编号']) === job.standNo)
  if (index < 0) {
    return
  }
  const current = stands[index]
  let next: EntryRow
  if (job.status === '已靠桥') {
    next = {
      ...current,
      status: '占用中',
      pending: true,
      当前航班: job.flightNo,
      占用时段: `${job.planDock} ~ ${job.planLeave}`,
      廊桥许可: job.permitNo,
      检查结论: `检查全项通过 ${checkSummary(job)}`,
    }
  } else if (job.status === '已撤离') {
    // 撤离后若没有其他在办作业占着同一机位，才释放台账占用。
    const stillOccupied = getBridgeJobs().some(
      (other) => other.standNo === job.standNo && other.id !== job.id && other.status === '已靠桥',
    )
    if (stillOccupied) {
      next = { ...current, status: '占用中', pending: true }
    } else {
      next = {
        ...current,
        status: '空闲',
        pending: false,
        当前航班: '—',
        占用时段: '—',
        廊桥许可: '—',
        检查结论: '—',
      }
    }
  } else {
    return
  }
  const updated = [...stands]
  updated[index] = next
  saveRows('stand', updated)
}

// 提交作业许可：限制条件全满足、检查项全部通过才签发；缺什么点什么，同一份许可重复提交只算一次。
export function submitPermit(id: number): PermitResult {
  const jobs = getBridgeJobs()
  const job = jobs.find((j) => j.id === id)
  if (!job) {
    return { ok: false, message: `没有找到编号为 ${id} 的${BRIDGE_ENTITY}`, missing: [], granted: false, idempotent: false }
  }
  // 同一份许可再次提交只算一次：已签发的直接返回原许可，不产生第二条许可、不重复写靠桥时间。
  if (job.status === '已靠桥') {
    return {
      ok: true,
      message: `许可 ${job.permitNo} 已签发，重复提交只算一次；作业保持「已靠桥」`,
      permitNo: job.permitNo,
      missing: [],
      granted: false,
      idempotent: true,
    }
  }
  if (job.status === '已撤离') {
    return { ok: false, message: `${job.jobNo} 已撤离，许可不可退回重提；状态只可按 待靠接→已靠桥→已撤离 推进`, missing: [], granted: false, idempotent: false }
  }

  const appliedAt = job.appliedAt || nowText()
  const pending: BridgeJob = { ...job, appliedAt }

  const constraints = evaluateConstraints(pending)
  const failedConstraints = constraints.filter((c) => !c.ok)
  const missingChecks = failedReasons(pending)
  const missing = [...failedConstraints.map((c) => `限制条件「${c.label}」不满足：${c.detail}`), ...missingChecks]

  if (missing.length > 0) {
    persist(jobs, pending)
    return {
      ok: false,
      message: `许可被挡回：还有 ${missing.length} 项不满足，补齐后从当前断点重新提交即可，已勾的检查项不会丢失`,
      missing,
      granted: false,
      idempotent: false,
    }
  }

  const permitNo = `PTW-${job.jobNo}`
  const ts = nowText()
  const granted: BridgeJob = {
    ...pending,
    status: '已靠桥',
    permitNo,
    permittedAt: ts,
    dockedAt: ts,
  }
  persist(jobs, granted)
  return {
    ok: true,
    message: `许可 ${permitNo} 签发，限制条件与 ${granted.checks.length} 项检查全部通过，作业进入「已靠桥」，机位台账已同步占用`,
    permitNo,
    missing: [],
    granted: true,
    idempotent: false,
  }
}

// 检查项逐项存盘：中断后从断掉的那一项接着做，不把整条作业退回重来。
export function updateCheck(
  id: number,
  checkKey: string,
  state: BridgeCheck['state'],
  remark: string,
  operator: string,
): PermitResult {
  const jobs = getBridgeJobs()
  const job = jobs.find((j) => j.id === id)
  if (!job) {
    return { ok: false, message: `没有找到编号为 ${id} 的${BRIDGE_ENTITY}`, missing: [], granted: false, idempotent: false }
  }
  if (job.status !== '待靠接') {
    return { ok: false, message: `${job.jobNo} 已进入「${job.status}」，检查结论已锁定，不能再改检查项`, missing: [], granted: false, idempotent: false }
  }
  if (state === 'failed' && remark.trim() === '') {
    return { ok: false, message: `检查项标记为不通过时必须填写问题说明，便于整改后复验`, missing: [], granted: false, idempotent: false }
  }
  const check = job.checks.find((c) => c.key === checkKey)
  if (!check) {
    return { ok: false, message: `检查项 ${checkKey} 不存在`, missing: [], granted: false, idempotent: false }
  }
  const updatedCheck: BridgeCheck = {
    ...check,
    state,
    remark: state === 'failed' ? remark.trim() : '',
    checkedAt: state === 'pending' ? '' : nowText(),
    checkedBy: state === 'pending' ? '' : operator,
  }
  const updated: BridgeJob = { ...job, checks: job.checks.map((c) => (c.key === checkKey ? updatedCheck : c)) }
  persist(jobs, updated)
  return { ok: true, message: `检查项「${check.label}」已${state === 'passed' ? '通过' : state === 'failed' ? '标记不通过' : '重置为待检查'}，进度已保存`, missing: [], granted: false, idempotent: false }
}

// 确认撤离：只允许 已靠桥 → 已撤离；已撤离的不许退回已靠桥。
export function confirmDeparture(id: number): PermitResult {
  const jobs = getBridgeJobs()
  const job = jobs.find((j) => j.id === id)
  if (!job) {
    return { ok: false, message: `没有找到编号为 ${id} 的${BRIDGE_ENTITY}`, missing: [], granted: false, idempotent: false }
  }
  if (job.status === '已撤离') {
    return { ok: false, message: `${job.jobNo} 已撤离，不允许退回「已靠桥」`, missing: [], granted: false, idempotent: false }
  }
  if (job.status !== '已靠桥') {
    return {
      ok: false,
      message: `跳步被挡回：当前「${job.status}」只能先提交作业许可、进入「已靠桥」后才能确认撤离`,
      missing: ['尚未取得靠接许可（未进入已靠桥）'],
      granted: false,
      idempotent: false,
    }
  }
  const updated: BridgeJob = { ...job, status: '已撤离', leftAt: nowText() }
  persist(jobs, updated)
  return { ok: true, message: `${job.jobNo} 已撤离，机位 ${job.standNo} 占用台账已释放（无其他在办作业时）`, missing: [], granted: false, idempotent: false }
}

export function createBridgeJob(input: CreateBridgeJobInput): { ok: boolean; message: string; job?: BridgeJob } {
  const jobs = getBridgeJobs()
  if (!input.bridgeNo.trim() || !input.standNo.trim() || !input.flightNo.trim()) {
    return { ok: false, message: '廊桥编号、对应机位、航班号为必填项' }
  }
  if (!input.aircraftType.trim()) {
    return { ok: false, message: '机型为必填项，用于核对机位适用机型' }
  }
  if (!input.planDock || !input.planLeave) {
    return { ok: false, message: '计划靠桥时间与计划撤离时间为必填项' }
  }
  if (toTime(input.planLeave) <= toTime(input.planDock)) {
    return { ok: false, message: '计划撤离时间必须晚于计划靠桥时间' }
  }
  const nextId = jobs.reduce((max, job) => Math.max(max, job.id), 0) + 1
  const jobNo = `BRID-${String(nextId).padStart(4, '0')}`
  const job: BridgeJob = {
    id: nextId,
    jobNo,
    bridgeNo: input.bridgeNo.trim(),
    standNo: input.standNo.trim(),
    flightNo: input.flightNo.trim(),
    aircraftType: input.aircraftType.trim(),
    planDock: input.planDock,
    planLeave: input.planLeave,
    dockedAt: '',
    leftAt: '',
    operator: input.operator.trim() || '值班管理员',
    status: '待靠接',
    checks: blankChecks(),
    permitNo: '',
    appliedAt: '',
    permittedAt: '',
    createdAt: nowText(),
  }
  saveBridgeJobs([...jobs, job])
  return { ok: true, message: `廊桥作业 ${jobNo} 已登记，状态「待靠接」，请提交作业许可`, job }
}

// 通用机位动作的旁路拦截：廊桥在办期间，机位分配/释放/封闭都不能绕过许可直接改台账。
export function standBlockedReason(standNo: string): string {
  const docked = getBridgeJobs().find((job) => job.standNo === standNo && job.status === '已靠桥')
  if (docked) {
    return `机位 ${standNo} 正被廊桥作业 ${docked.jobNo}（${docked.flightNo}）凭许可 ${docked.permitNo} 占用，占用变更请走廊桥撤离流程`
  }
  return ''
}

export function bridgeStats(): { label: string; value: number }[] {
  const jobs = getBridgeJobs()
  const today = nowText().slice(0, 10)
  return [
    { label: '今日靠接作业', value: jobs.filter((j) => (j.dockedAt || j.createdAt).slice(0, 10) === today).length },
    { label: '待靠接作业', value: jobs.filter((j) => j.status === '待靠接').length },
    { label: '已靠桥作业', value: jobs.filter((j) => j.status === '已靠桥').length },
    { label: '已撤离作业', value: jobs.filter((j) => j.status === '已撤离').length },
  ]
}

export { resetBridgeJobs }
