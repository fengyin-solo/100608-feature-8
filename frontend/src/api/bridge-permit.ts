import { listRows, saveRows } from '@/data/local-store'
import { SEED_BRIDGE_PERMITS } from '@/data/seed'
import type { ActionResult, BridgeCheckItem, BridgePermit, EntryRow, PermitApplication } from '@/data/types'
import { BRIDGE_CHECK_ITEMS } from '@/data/types'

// 廊桥靠接作业许可层：
// - 靠接前按对应机位与机型核限制条件，核不过不发许可；
// - 作业状态只可按 待靠接 → 已靠桥 → 已撤离 顺序推进，跳步一律挡回；
// - 检查项逐项落库，中断后从断掉那一项接着做，不退回重来；
// - 同一机位同一时段只允许一条在办作业，撞时段先提交先上；
// - 许可与检查结论同步到机位占用台账，台账以许可为准，不各算各的。

const ENTITY = '廊桥作业'
const PERMIT_STORAGE_KEY = 'airport-ground-ops:bridge-permits'
/** 在办状态：这两种状态的许可占着机位 */
const ACTIVE_STATUSES = ['待靠接', '已靠桥']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

// ---------- 许可存取（localStorage，与台账数据层同一套打法） ----------

let permitCache: BridgePermit[] | null = null

/** 检查项以固定清单为准归一化：旧数据缺项补「未通过」，多项按清单顺序排。 */
function normalizeChecks(checks: BridgeCheckItem[] | undefined): BridgeCheckItem[] {
  const stored = new Map((checks ?? []).map((item) => [item.name, Boolean(item.passed)]))
  return BRIDGE_CHECK_ITEMS.map((name) => ({ name, passed: stored.get(name) ?? false }))
}

/** 只播种挂得上台账行的许可（按作业编号挂钩），旧缓存里没有对应作业就跳过。 */
function seedPermits(): BridgePermit[] {
  const rows = listRows('bridge')
  return clone(SEED_BRIDGE_PERMITS).filter((permit) =>
    rows.some((row) => String(row['作业编号']) === permit.permitNo),
  )
}

function persistPermits(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PERMIT_STORAGE_KEY, JSON.stringify(permitCache ?? []))
  }
}

function readPermits(): BridgePermit[] {
  if (permitCache === null) {
    let stored: BridgePermit[] | null = null
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(PERMIT_STORAGE_KEY)
      if (raw) {
        try {
          stored = JSON.parse(raw) as BridgePermit[]
        } catch {
          stored = null
        }
      }
    }
    permitCache = (stored ?? seedPermits()).map((permit) => ({
      ...permit,
      checks: normalizeChecks(permit.checks),
    }))
    persistPermits()
  }
  return permitCache
}

function writePermits(permits: BridgePermit[]): void {
  permitCache = permits
  persistPermits()
}

export function listPermits(): BridgePermit[] {
  return clone(readPermits())
}

export function resetBridgePermits(): void {
  permitCache = seedPermits().map((permit) => ({ ...permit, checks: normalizeChecks(permit.checks) }))
  persistPermits()
}

// ---------- 基础查询 ----------

function findBridgeRow(rowId: number): EntryRow | undefined {
  return listRows('bridge').find((row) => Number(row.id) === rowId)
}

function permitOfNo(permitNo: string): BridgePermit | undefined {
  return readPermits().find((permit) => permit.permitNo === permitNo)
}

export function permitOfRow(row: EntryRow): BridgePermit | undefined {
  return permitOfNo(String(row['作业编号'] ?? ''))
}

export function checkProgress(permit: BridgePermit): { passed: number; total: number } {
  return { passed: permit.checks.filter((item) => item.passed).length, total: permit.checks.length }
}

export function suggestPermitNo(): string {
  const used = new Set([
    ...listRows('bridge').map((row) => String(row['作业编号'] ?? '')),
    ...readPermits().map((permit) => permit.permitNo),
  ])
  let seq = 1
  for (const no of used) {
    const match = /^BRID-(\d+)$/.exec(no)
    if (match) {
      seq = Math.max(seq, Number(match[1]) + 1)
    }
  }
  let candidate = `BRID-${String(seq).padStart(4, '0')}`
  while (used.has(candidate)) {
    seq += 1
    candidate = `BRID-${String(seq).padStart(4, '0')}`
  }
  return candidate
}

// ---------- 时间区间 ----------

function parseTime(raw: string): number | null {
  const text = String(raw ?? '').trim()
  if (!text) {
    return null
  }
  const ts = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
  return Number.isNaN(ts) ? null : ts
}

type TimeRange = { start: number; end: number }

function rangeOf(startTime: string, endTime: string): TimeRange | null {
  const start = parseTime(startTime)
  if (start === null) {
    return null
  }
  return { start, end: parseTime(endTime) ?? start }
}

/** 两边时间都解析得出来就按区间重叠判；解析不出来退化为靠桥日期是否同一天。 */
function overlaps(a: PermitApplication | BridgePermit, b: PermitApplication | BridgePermit): boolean {
  const rangeA = rangeOf(a.startTime, a.endTime)
  const rangeB = rangeOf(b.startTime, b.endTime)
  if (rangeA && rangeB) {
    return rangeA.start <= rangeB.end && rangeB.start <= rangeA.end
  }
  return a.startTime.slice(0, 10) === b.startTime.slice(0, 10)
}

// ---------- 签发许可 ----------

export function applyBridgePermit(input: PermitApplication): ActionResult {
  const application: PermitApplication = {
    permitNo: input.permitNo.trim(),
    standCode: input.standCode.trim(),
    flightNo: input.flightNo.trim(),
    aircraftType: input.aircraftType.trim(),
    bridgeNo: input.bridgeNo.trim(),
    operator: input.operator.trim(),
    startTime: input.startTime.trim(),
    endTime: input.endTime.trim(),
  }
  if (Object.values(application).some((value) => value === '')) {
    return fail('许可编号、航班号、机型、对应机位、廊桥编号、操作人员、靠桥时间、撤桥时间都要填')
  }

  // 幂等：同一份许可（同一许可编号）再次提交只算一次，直接认原来的
  const existing = permitOfNo(application.permitNo)
  if (existing) {
    return ok(`许可 ${existing.permitNo} 已签发过，同一份许可只算一次，本次不重复登记`)
  }

  const range = rangeOf(application.startTime, application.endTime)
  if (range && range.end < range.start) {
    return fail(`撤桥时间 ${application.endTime} 早于靠桥时间 ${application.startTime}，先改时间再报`)
  }

  // 限制条件核对：机位得登记过、能用，机型得在机位适用机型里
  const stand = listRows('stand').find((row) => String(row['机位编号']) === application.standCode)
  if (!stand) {
    return fail(`机位 ${application.standCode} 没有在机位分配里登记，不能签发靠接许可`)
  }
  const standStatus = String(stand.status)
  if (standStatus === '维护中' || standStatus === '已封闭') {
    return fail(`机位 ${application.standCode} 当前「${standStatus}」，不能签发靠接许可`)
  }
  const allowedTypes = String(stand['适用机型'] ?? '')
    .split(/[、,，;/；\s]+/)
    .filter(Boolean)
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.some((type) => type.toUpperCase() === application.aircraftType.toUpperCase())
  ) {
    return fail(
      `机型 ${application.aircraftType} 不在机位 ${application.standCode} 的适用机型（${allowedTypes.join('、')}）内，不能靠接`,
    )
  }

  // 同一机位同一时段只办一条：撞时段先提交先上，后来的挡回并告知被谁占着
  const rows = listRows('bridge')
  const holder = readPermits()
    .filter((permit) => permit.standCode === application.standCode)
    .filter((permit) => {
      const row = rows.find((item) => String(item['作业编号']) === permit.permitNo)
      return row !== undefined && ACTIVE_STATUSES.includes(String(row.status))
    })
    .filter((permit) => overlaps(application, permit))
    .sort((a, b) => a.createdSeq - b.createdSeq)[0]
  if (holder) {
    return fail(
      `机位 ${application.standCode} 在 ${holder.startTime} ~ ${holder.endTime} 已有在办靠接作业 ${holder.permitNo}（同一机位同一时段只办一条，先申请先上）`,
    )
  }

  const newId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: newId,
    status: '待靠接',
    pending: true,
    abnormal: false,
    '作业编号': application.permitNo,
    '航班号': application.flightNo,
    '机型': application.aircraftType,
    '廊桥编号': application.bridgeNo,
    '对应机位': application.standCode,
    '靠桥时间': application.startTime,
    '撤桥时间': application.endTime,
    '操作人员': application.operator,
    '对接检查项': `0/${BRIDGE_CHECK_ITEMS.length}`,
    '作业状态': '待靠接',
  }
  saveRows('bridge', [...rows, row])

  const createdSeq = readPermits().reduce((max, permit) => Math.max(max, permit.createdSeq), 0) + 1
  writePermits([
    ...readPermits(),
    {
      ...application,
      checks: normalizeChecks(undefined),
      createdSeq,
    },
  ])
  syncStandLedger()
  return ok(`许可 ${application.permitNo} 已签发，${ENTITY}进入「待靠接」，检查项全部通过后才能靠桥`)
}

// ---------- 对接检查：逐项落库，断点续做 ----------

export function passBridgeCheck(rowId: number, itemName?: string): ActionResult {
  const row = findBridgeRow(rowId)
  if (!row) {
    return fail(`没有找到编号为 ${rowId} 的${ENTITY}`)
  }
  const permit = permitOfRow(row)
  if (!permit) {
    return fail(`作业 ${String(row['作业编号'] ?? rowId)} 没有签发作业许可，先申请许可再检查`)
  }
  if (String(row.status) !== '待靠接') {
    return fail(`当前状态「${String(row.status)}」，对接检查项只在待靠接阶段勾选`)
  }

  // 不点名就从断掉那一项接着做：第一项未通过的
  const target = itemName
    ? permit.checks.find((item) => item.name === itemName)
    : permit.checks.find((item) => !item.passed)
  if (!target) {
    return itemName
      ? fail(`没有名为「${itemName}」的对接检查项`)
      : ok('对接检查项已全部通过，可以开始靠接')
  }
  if (target.passed) {
    return ok(`检查项「${target.name}」此前已通过，接着做下一项即可`)
  }

  const permits = readPermits()
  const stored = permits.find((item) => item.permitNo === permit.permitNo)
  const storedItem = stored?.checks.find((item) => item.name === target.name)
  if (!stored || !storedItem) {
    return fail(`许可 ${permit.permitNo} 的检查记录读取失败`)
  }
  storedItem.passed = true
  writePermits([...permits])

  const { passed, total } = checkProgress(stored)
  const rows = listRows('bridge')
  saveRows(
    'bridge',
    rows.map((item) =>
      Number(item.id) === rowId ? { ...item, '对接检查项': `${passed}/${total}` } : item,
    ),
  )
  syncStandLedger()

  const next = stored.checks.find((item) => !item.passed)
  return ok(
    next
      ? `检查项「${target.name}」已通过（${passed}/${total}），下一项「${next.name}」`
      : `检查项「${target.name}」已通过（${passed}/${total}），全部通过，可以开始靠接`,
  )
}

// ---------- 状态流转：只许 待靠接 → 已靠桥 → 已撤离 ----------

function setRowStatus(rowId: number, status: string, extra: Partial<EntryRow> = {}): void {
  const rows = listRows('bridge')
  saveRows(
    'bridge',
    rows.map((row) =>
      Number(row.id) === rowId ? { ...row, status, '作业状态': status, ...extra } : row,
    ),
  )
}

export function runBridgeAction(rowId: number, action: string): ActionResult {
  const row = findBridgeRow(rowId)
  if (!row) {
    return fail(`没有找到编号为 ${rowId} 的${ENTITY}`)
  }
  const status = String(row.status)

  if (action === '开始靠接') {
    if (status === '已靠桥') {
      return fail(`${ENTITY}已经是「已靠桥」，不用重复操作`)
    }
    if (status === '已撤离') {
      return fail(`${ENTITY}已撤离，不允许退回已靠桥；作业状态只可按 待靠接→已靠桥→已撤离 推进`)
    }
    if (status === '异常中止') {
      return fail(`${ENTITY}已异常中止，不能再靠接`)
    }
    const permit = permitOfRow(row)
    if (!permit) {
      return fail(`作业 ${String(row['作业编号'] ?? rowId)} 没有签发作业许可，先申请许可再靠接`)
    }
    const missing = permit.checks.filter((item) => !item.passed).map((item) => item.name)
    if (missing.length > 0) {
      return fail(`对接检查项未全部通过，不能靠桥；还差 ${missing.length} 项：${missing.join('、')}`)
    }
    setRowStatus(rowId, '已靠桥', { pending: true })
    syncStandLedger()
    return ok(`${ENTITY}已开始靠接，当前状态「已靠桥」`)
  }

  if (action === '确认撤离') {
    if (status === '已撤离') {
      return fail(`${ENTITY}已经是「已撤离」，不用重复操作`)
    }
    if (status === '异常中止') {
      return fail(`${ENTITY}已异常中止，不能再撤离`)
    }
    if (status === '待靠接') {
      return fail(`还没靠桥不能撤离：作业状态只可按 待靠接→已靠桥→已撤离 顺序推进，不许跳步`)
    }
    setRowStatus(rowId, '已撤离', { pending: false })
    syncStandLedger()
    return ok(`${ENTITY}已确认撤离，当前状态「已撤离」`)
  }

  if (action === '登记中止') {
    if (status === '异常中止') {
      return fail(`${ENTITY}已经是「异常中止」，不用重复操作`)
    }
    if (status === '已撤离') {
      return fail(`${ENTITY}已撤离闭环，不能再登记中止`)
    }
    setRowStatus(rowId, '异常中止', { pending: false, abnormal: true })
    syncStandLedger()
    return ok(`${ENTITY}已登记中止，当前状态「异常中止」`)
  }

  return fail(`${ENTITY}没有登记「${action}」这个动作`)
}

// ---------- 机位占用台账同步：台账以许可为准 ----------

export function syncStandLedger(): void {
  const permits = readPermits()
  const bridgeRows = listRows('bridge')
  const stands = listRows('stand')
  let changed = false
  const next = stands.map((stand) => {
    const code = String(stand['机位编号'] ?? '')
    const related = permits
      .map((permit) => ({
        permit,
        row: bridgeRows.find((item) => String(item['作业编号']) === permit.permitNo),
      }))
      .filter((item): item is { permit: BridgePermit; row: EntryRow } =>
        Boolean(item.row) && item.permit.standCode === code,
      )
    if (related.length === 0) {
      return stand
    }
    const active = related
      .filter((item) => ACTIVE_STATUSES.includes(String(item.row.status)))
      .sort((a, b) => b.permit.createdSeq - a.permit.createdSeq)[0]
    let updated: EntryRow
    if (active) {
      const { passed, total } = checkProgress(active.permit)
      updated = {
        ...stand,
        status: '占用中',
        pending: true,
        '当前航班': active.permit.flightNo,
        '占用时段': `${active.permit.startTime} ~ ${active.permit.endTime}`,
        '机位状态': `许可${active.permit.permitNo}·${String(active.row.status)}·检查${passed}/${total}`,
      }
    } else {
      updated = {
        ...stand,
        status: '空闲',
        pending: false,
        '当前航班': '',
        '占用时段': '',
        '机位状态': '空闲',
      }
    }
    if (JSON.stringify(updated) !== JSON.stringify(stand)) {
      changed = true
    }
    return updated
  })
  if (changed) {
    saveRows('stand', next)
  }
}
