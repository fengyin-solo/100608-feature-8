import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyBridgePermit,
  listPermits,
  passBridgeCheck,
  resetBridgePermits,
  runBridgeAction,
  suggestPermitNo,
  syncStandLedger,
} from './bridge-permit'
import { runAction } from './local-service'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import type { EntryRow, PermitApplication } from '@/data/types'

// 数据层在没有 window 的环境下走内存缓存，直接当单元测试跑。
function freshState() {
  resetRows('bridge')
  resetRows('stand')
  resetBridgePermits()
  syncStandLedger()
}

function bridgeRow(permitNo: string): EntryRow {
  const row = listRows('bridge').find((item) => String(item['作业编号']) === permitNo)
  if (!row) {
    throw new Error(`台账里没有 ${permitNo}`)
  }
  return row
}

function standRow(code: string): EntryRow {
  const row = listRows('stand').find((item) => String(item['机位编号']) === code)
  if (!row) {
    throw new Error(`机位台账里没有 ${code}`)
  }
  return row
}

function application(patch: Partial<PermitApplication> = {}): PermitApplication {
  return {
    permitNo: 'BRID-0100',
    standCode: 'STAN-0003',
    flightNo: 'ZH0001',
    aircraftType: 'C919',
    bridgeNo: 'L2-10',
    operator: '测试员',
    startTime: '2026-10-05 08:00',
    endTime: '2026-10-05 09:00',
    ...patch,
  }
}

beforeEach(freshState)

describe('签发许可', () => {
  it('同一份许可再次提交只算一次', () => {
    const first = applyBridgePermit(application())
    expect(first.ok).toBe(true)
    const rowCount = listRows('bridge').length

    const second = applyBridgePermit(application())
    expect(second.ok).toBe(true)
    expect(second.message).toContain('只算一次')
    expect(listRows('bridge')).toHaveLength(rowCount)
    expect(listPermits().filter((permit) => permit.permitNo === 'BRID-0100')).toHaveLength(1)
  })

  it('机型不在机位适用机型内，许可核不过', () => {
    const result = applyBridgePermit(application({ aircraftType: 'B747' }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('B747')
    expect(result.message).toContain('适用机型')
    expect(listPermits().some((permit) => permit.permitNo === 'BRID-0100')).toBe(false)
  })

  it('机位未登记、维护中、已封闭都不发许可', () => {
    expect(applyBridgePermit(application({ standCode: 'STAN-9999' })).ok).toBe(false)

    saveRows(
      'stand',
      listRows('stand').map((row) =>
        String(row['机位编号']) === 'STAN-0003' ? { ...row, status: '维护中' } : row,
      ),
    )
    const denied = applyBridgePermit(application())
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain('维护中')

    saveRows(
      'stand',
      listRows('stand').map((row) =>
        String(row['机位编号']) === 'STAN-0003' ? { ...row, status: '已封闭' } : row,
      ),
    )
    expect(applyBridgePermit(application()).ok).toBe(false)
  })

  it('撤桥时间早于靠桥时间直接挡回', () => {
    const result = applyBridgePermit(
      application({ startTime: '2026-10-05 09:00', endTime: '2026-10-05 08:00' }),
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('撤桥时间')
  })

  it('同一机位同一时段只办一条，先申请先上；错开时段可以放', () => {
    // BRID-0001 占着 STAN-0001 的 2026-10-04 08:30 ~ 10:00
    const conflict = applyBridgePermit(
      application({
        permitNo: 'BRID-0101',
        standCode: 'STAN-0001',
        aircraftType: 'A320',
        startTime: '2026-10-04 09:00',
        endTime: '2026-10-04 11:00',
      }),
    )
    expect(conflict.ok).toBe(false)
    expect(conflict.message).toContain('BRID-0001')
    expect(conflict.message).toContain('先申请先上')

    const clear = applyBridgePermit(
      application({
        permitNo: 'BRID-0102',
        standCode: 'STAN-0001',
        aircraftType: 'A320',
        startTime: '2026-10-04 10:30',
        endTime: '2026-10-04 11:30',
      }),
    )
    expect(clear.ok).toBe(true)
  })

  it('在办许可撤离后，同一机位同一时段可以再办', () => {
    runBridgeAction(Number(bridgeRow('BRID-0002').id), '确认撤离')
    const result = applyBridgePermit(
      application({
        permitNo: 'BRID-0103',
        standCode: 'STAN-0002',
        aircraftType: 'A320',
        startTime: '2026-10-04 09:30',
        endTime: '2026-10-04 10:30',
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe('对接检查：断点续做', () => {
  it('从断掉那一项接着做，逐项落库', () => {
    const row = bridgeRow('BRID-0001') // 种子数据已勾 2/5
    expect(row['对接检查项']).toBe('2/5')

    const third = passBridgeCheck(Number(row.id))
    expect(third.ok).toBe(true)
    expect(third.message).toContain('机位区域无障碍确认')
    expect(bridgeRow('BRID-0001')['对接检查项']).toBe('3/5')

    const fourth = passBridgeCheck(Number(row.id))
    expect(fourth.message).toContain('对接高度校准')

    const fifth = passBridgeCheck(Number(row.id))
    expect(fifth.message).toContain('安全联锁确认')
    expect(fifth.message).toContain('全部通过')
    expect(bridgeRow('BRID-0001')['对接检查项']).toBe('5/5')

    const extra = passBridgeCheck(Number(row.id))
    expect(extra.ok).toBe(true)
    expect(extra.message).toContain('已全部通过')
  })

  it('已勾过的项再勾不重复计数', () => {
    const row = bridgeRow('BRID-0001')
    const result = passBridgeCheck(Number(row.id), '机位机型限制核对')
    expect(result.ok).toBe(true)
    expect(bridgeRow('BRID-0001')['对接检查项']).toBe('2/5')
  })

  it('离开待靠接状态后检查锁定', () => {
    const row = bridgeRow('BRID-0002') // 已靠桥
    const result = passBridgeCheck(Number(row.id))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('待靠接')
  })
})

describe('状态流转：只许 待靠接 → 已靠桥 → 已撤离', () => {
  it('检查项没全部通过进不了已靠桥，并指出缺哪一项', () => {
    const row = bridgeRow('BRID-0001') // 2/5
    const result = runBridgeAction(Number(row.id), '开始靠接')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('机位区域无障碍确认')
    expect(result.message).toContain('对接高度校准')
    expect(result.message).toContain('安全联锁确认')
    expect(bridgeRow('BRID-0001').status).toBe('待靠接')
  })

  it('检查全部通过后可以靠桥', () => {
    const row = bridgeRow('BRID-0001')
    passBridgeCheck(Number(row.id))
    passBridgeCheck(Number(row.id))
    passBridgeCheck(Number(row.id))
    const result = runBridgeAction(Number(row.id), '开始靠接')
    expect(result.ok).toBe(true)
    expect(bridgeRow('BRID-0001').status).toBe('已靠桥')
  })

  it('待靠接直接撤离算跳步，一律挡回', () => {
    const row = bridgeRow('BRID-0001')
    const result = runBridgeAction(Number(row.id), '确认撤离')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不许跳步')
    expect(bridgeRow('BRID-0001').status).toBe('待靠接')
  })

  it('已撤离不允许退回已靠桥，也不能再中止', () => {
    const row = bridgeRow('BRID-0003') // 已撤离
    const back = runBridgeAction(Number(row.id), '开始靠接')
    expect(back.ok).toBe(false)
    expect(back.message).toContain('不允许退回已靠桥')

    const abort = runBridgeAction(Number(row.id), '登记中止')
    expect(abort.ok).toBe(false)
    expect(bridgeRow('BRID-0003').status).toBe('已撤离')
  })

  it('没有许可的作业不能靠接', () => {
    const rows = listRows('bridge')
    saveRows('bridge', [
      ...rows,
      {
        id: 99,
        status: '待靠接',
        pending: true,
        abnormal: false,
        '作业编号': 'BRID-9999',
        '航班号': 'XX0000',
        '机型': 'A320',
        '廊桥编号': 'L9-99',
        '对应机位': 'STAN-0003',
        '靠桥时间': '2026-10-06 08:00',
        '撤桥时间': '2026-10-06 09:00',
        '操作人员': '测试员',
        '对接检查项': '0/5',
        '作业状态': '待靠接',
      },
    ])
    const result = runBridgeAction(99, '开始靠接')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('许可')
  })

  it('local-service 的 runAction 也走同一套门禁', () => {
    const row = bridgeRow('BRID-0001')
    const skip = runAction('bridge', Number(row.id), '确认撤离')
    expect(skip.ok).toBe(false)
    expect(skip.message).toContain('不许跳步')

    const dock = runAction('bridge', Number(bridgeRow('BRID-0002').id), '确认撤离')
    expect(dock.ok).toBe(true)
    expect(bridgeRow('BRID-0002').status).toBe('已撤离')
  })
})

describe('机位占用台账同步', () => {
  it('许可在办期间机位台账跟着许可走', () => {
    const stand = standRow('STAN-0001')
    expect(stand.status).toBe('占用中')
    expect(stand['当前航班']).toBe('CA1234')
    expect(String(stand['机位状态'])).toContain('BRID-0001')
    expect(String(stand['机位状态'])).toContain('检查2/5')
  })

  it('检查结论、靠桥、撤离都会同步到台账', () => {
    const row = bridgeRow('BRID-0001')
    passBridgeCheck(Number(row.id))
    expect(String(standRow('STAN-0001')['机位状态'])).toContain('检查3/5')

    passBridgeCheck(Number(row.id))
    passBridgeCheck(Number(row.id))
    runBridgeAction(Number(row.id), '开始靠接')
    expect(String(standRow('STAN-0001')['机位状态'])).toContain('已靠桥')
    expect(String(standRow('STAN-0001')['机位状态'])).toContain('检查5/5')

    runBridgeAction(Number(row.id), '确认撤离')
    const released = standRow('STAN-0001')
    expect(released.status).toBe('空闲')
    expect(released['当前航班']).toBe('')
  })

  it('中止作业会释放机位', () => {
    runBridgeAction(Number(bridgeRow('BRID-0002').id), '登记中止')
    expect(bridgeRow('BRID-0002').status).toBe('异常中止')
    expect(standRow('STAN-0002').status).toBe('空闲')
    expect(standRow('STAN-0002')['当前航班']).toBe('')
  })

  it('新签许可立刻反映到机位台账', () => {
    applyBridgePermit(application())
    const stand = standRow('STAN-0003')
    expect(stand.status).toBe('占用中')
    expect(stand['当前航班']).toBe('ZH0001')
    expect(stand['占用时段']).toBe('2026-10-05 08:00 ~ 2026-10-05 09:00')
  })
})

describe('许可编号建议', () => {
  it('从现有台账与许可往后顺号', () => {
    expect(suggestPermitNo()).toBe('BRID-0004')
    applyBridgePermit(application({ permitNo: 'BRID-0004' }))
    expect(suggestPermitNo()).toBe('BRID-0005')
  })
})
