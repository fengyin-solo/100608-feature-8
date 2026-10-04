<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接作业许可</h2>
        <p class="page-desc">靠接前按机位与机型核限制条件；作业状态按 待靠接 → 已靠桥 → 已撤离 顺序推进，检查项全项通过才签发许可，许可与检查结论同步机位占用台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记廊桥作业</button>
        <button class="btn" type="button" @click="exportRows">导出廊桥靠接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>许可作业</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] && row[column] !== '' ? row[column] : '—' }}</td>
          <td><span class="state-chip" :class="`chip-${String(row.status)}`">{{ row.status }}</span></td>
          <td class="row-actions">
            <template v-if="String(row.status) === '待靠接'">
              <button class="link" type="button" @click="openPermit(Number(row.id))">作业许可 / 检查</button>
            </template>
            <template v-else-if="String(row.status) === '已靠桥'">
              <button class="link" type="button" @click="openPermit(Number(row.id))">查看许可</button>
              <button class="link danger" type="button" @click="depart(Number(row.id))">确认撤离</button>
            </template>
            <template v-else>
              <button class="link" type="button" @click="openPermit(Number(row.id))">查看许可</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥靠接记录，可先登记廊桥作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥靠接记录；同一机位同一时段只允许一条在办作业，抢占按先申请先得裁决</span>
      <span v-if="banner" :class="bannerOk ? 'ok-text' : 'error-text'">{{ banner }}</span>
    </footer>

    <!-- 作业许可工作台：限制条件 + 逐项检查，检查进度存盘，中断后从断点接着做 -->
    <div v-if="permitJob" class="modal-mask" @click.self="closePermit">
      <div class="modal">
        <header class="modal-head">
          <h3>作业许可 · {{ permitJob.jobNo }}（{{ permitJob.flightNo }} / {{ permitJob.aircraftType }}）</h3>
          <button class="btn ghost" type="button" @click="closePermit">关闭</button>
        </header>

        <section class="permit-section">
          <h4>作业信息</h4>
          <div class="info-grid">
            <span>机位：{{ permitJob.standNo }}</span>
            <span>廊桥：{{ permitJob.bridgeNo }}</span>
            <span>操作人员：{{ permitJob.operator }}</span>
            <span>计划时段：{{ permitJob.planDock }} ~ {{ permitJob.planLeave }}</span>
            <span>实际靠桥：{{ permitJob.dockedAt || '—' }}</span>
            <span>实际撤离：{{ permitJob.leftAt || '—' }}</span>
            <span>许可编号：{{ permitJob.permitNo || '尚未签发' }}</span>
            <span>首次申请：{{ permitJob.appliedAt || '尚未提交' }}</span>
          </div>
        </section>

        <section class="permit-section">
          <h4>限制条件核对（靠接前按机位与机型核验）</h4>
          <ul class="constraint-list">
            <li v-for="c in permitConstraints" :key="c.key" :class="c.ok ? 'is-ok' : 'is-bad'">
              <span class="constraint-state">{{ c.ok ? '✓' : '✗' }}</span>
              <div>
                <strong>{{ c.label }}</strong>
                <p>{{ c.detail }}</p>
              </div>
            </li>
          </ul>
        </section>

        <section class="permit-section">
          <h4>
            对接检查项（{{ permitPassed }}/{{ permitJob.checks.length }} 通过，缺项不可靠桥）
            <span v-if="permitJob.status === '待靠接'" class="section-hint">逐项勾选并即时存盘，关掉再打开从断掉的那一项继续</span>
          </h4>
          <table class="check-table">
            <thead>
              <tr><th>检查项</th><th>结论</th><th>说明 / 记录时间 / 检查人</th><th v-if="permitJob.status === '待靠接'">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in permitJob.checks" :key="c.key">
                <td>{{ c.label }}</td>
                <td><span class="state-chip" :class="checkChip(c.state)">{{ checkLabel(c.state) }}</span></td>
                <td class="check-remark">
                  <template v-if="c.remark">问题：{{ c.remark }}；</template>{{ c.checkedAt || '—' }}<template v-if="c.checkedBy"> · {{ c.checkedBy }}</template>
                </td>
                <td v-if="permitJob.status === '待靠接'" class="row-actions">
                  <button class="link" type="button" :disabled="c.state === 'passed'" @click="setCheck(c.key, 'passed')">通过</button>
                  <button class="link danger" type="button" :disabled="c.state === 'failed'" @click="failCheck(c.key)">不通过</button>
                  <button class="link" type="button" :disabled="c.state === 'pending'" @click="setCheck(c.key, 'pending')">重置</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="permitResult" class="permit-result" :class="permitResult.ok ? 'is-ok' : 'is-bad'">
          <p>{{ permitResult.message }}</p>
          <ul v-if="permitResult.missing.length">
            <li v-for="(item, i) in permitResult.missing" :key="i">{{ item }}</li>
          </ul>
        </section>

        <footer class="modal-foot">
          <span class="foot-hint">
            <template v-if="permitJob.status === '待靠接'">状态只能由「待靠接」推进到「已靠桥」，无法跳到「已撤离」</template>
            <template v-else-if="permitJob.status === '已靠桥'">「已撤离」为终态，撤离后不允许退回「已靠桥」</template>
            <template v-else>本作业已完成，结论只读</template>
          </span>
          <span class="foot-btns">
            <button class="btn" type="button" @click="closePermit">关闭</button>
            <button v-if="permitJob.status === '待靠接'" class="btn primary" type="button" @click="submitPermit">提交作业许可</button>
            <button v-if="permitJob.status === '已靠桥'" class="btn primary" type="button" @click="depart(permitJob.id); closePermit()">确认撤离</button>
          </span>
        </footer>
      </div>
    </div>

    <!-- 登记廊桥作业 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal modal-sm">
        <header class="modal-head">
          <h3>登记廊桥作业</h3>
          <button class="btn ghost" type="button" @click="closeCreate">关闭</button>
        </header>
        <form class="create-form" @submit.prevent="submitCreate">
          <label>
            <span>航班号</span>
            <input v-model="createForm.flightNo" list="flight-options" required placeholder="选择或输入航班号" @change="prefillByFlight" />
            <datalist id="flight-options">
              <option v-for="f in flightOptions" :key="String(f.id)" :value="String(f['航班号'])"></option>
            </datalist>
          </label>
          <label>
            <span>机型</span>
            <input v-model="createForm.aircraftType" required placeholder="如 A320" />
          </label>
          <label>
            <span>对应机位</span>
            <select v-model="createForm.standNo" required @change="prefillByStand">
              <option value="" disabled>请选择机位</option>
              <option v-for="s in standOptions" :key="String(s.id)" :value="String(s['机位编号'])">
                {{ s['机位编号'] }}（{{ s['适用机型'] }} / {{ s['廊桥配置'] }}）
              </option>
            </select>
          </label>
          <label>
            <span>廊桥编号</span>
            <input v-model="createForm.bridgeNo" required placeholder="如 B1廊桥" />
          </label>
          <label>
            <span>操作人员</span>
            <input v-model="createForm.operator" required />
          </label>
          <label>
            <span>计划靠桥时间</span>
            <input v-model="createForm.planDock" type="datetime-local" required />
          </label>
          <label>
            <span>计划撤离时间</span>
            <input v-model="createForm.planLeave" type="datetime-local" required />
          </label>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <footer class="modal-foot">
            <span></span>
            <span class="foot-btns">
              <button class="btn" type="button" @click="closeCreate">取消</button>
              <button class="btn primary" type="submit">登记作业</button>
            </span>
          </footer>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  bridgeStats,
  confirmDeparture,
  createBridgeJob,
  evaluateConstraints,
  getBridgeJob,
  submitPermit as submitPermitApi,
  updateCheck,
} from '@/api/bridge-service'
import type { BridgeJob, CheckState } from '@/data/bridge-types'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('bridge')
const columns = ["作业编号", "廊桥编号", "对应机位", "航班号", "机型", "计划靠桥", "计划撤离", "靠桥时间", "撤桥时间", "许可编号", "检查结论"]
const statuses = ["待靠接", "已靠桥", "已撤离"]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref(bridgeStats())
const banner = ref('')
const bannerOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ["作业编号", "对应机位", "航班号"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 许可工作台状态
const permitJob = ref<BridgeJob | null>(null)
const permitResult = ref<{ ok: boolean; message: string; missing: string[] } | null>(null)
const permitConstraints = ref<ReturnType<typeof evaluateConstraints>>([])
const permitPassed = computed(() => (permitJob.value ? permitJob.value.checks.filter((c) => c.state === 'passed').length : 0))

// 登记表单
const createOpen = ref(false)
const createError = ref('')
const createForm = reactive({
  flightNo: '',
  aircraftType: '',
  standNo: '',
  bridgeNo: '',
  operator: session.operator,
  planDock: '',
  planLeave: '',
})

const flightOptions = ref<EntryRow[]>([])
const standOptions = ref<EntryRow[]>([])

function checkLabel(state: CheckState): string {
  return state === 'passed' ? '通过' : state === 'failed' ? '不通过' : '待检查'
}
function checkChip(state: CheckState): string {
  return state === 'passed' ? 'chip-pass' : state === 'failed' ? 'chip-fail' : 'chip-pending'
}

function flash(message: string, ok: boolean) {
  banner.value = message
  bannerOk.value = ok
}

function reload() {
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
  stats.value = bridgeStats()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function refreshPermit(id: number) {
  const job = getBridgeJob(id)
  if (job) {
    permitJob.value = job
    permitConstraints.value = evaluateConstraints(job)
  }
}

function openPermit(id: number) {
  permitResult.value = null
  refreshPermit(id)
}

function closePermit() {
  permitJob.value = null
  permitResult.value = null
  reload()
}

function setCheck(key: string, state: CheckState, failedRemark = '') {
  if (!permitJob.value) {
    return
  }
  const result = updateCheck(permitJob.value.id, key, state, failedRemark, permitJob.value.operator)
  permitResult.value = { ok: result.ok, message: result.message, missing: result.missing }
  refreshPermit(permitJob.value.id)
}

function failCheck(key: string) {
  if (!permitJob.value) {
    return
  }
  const remark = window.prompt('请填写不通过的问题说明（整改后可重新勾为通过）：')
  if (remark === null) {
    return
  }
  if (remark.trim() === '') {
    permitResult.value = { ok: false, message: '检查项标记为不通过时必须填写问题说明', missing: [] }
    return
  }
  setCheck(key, 'failed', remark.trim())
}

function submitPermit() {
  if (!permitJob.value) {
    return
  }
  const result = submitPermitApi(permitJob.value.id)
  permitResult.value = { ok: result.ok, message: result.message, missing: result.missing }
  if (result.ok && (result.granted || result.idempotent)) {
    // 签发成功或命中幂等：许可结论已落账，关闭工作台回到列表。
    permitJob.value = null
    permitResult.value = null
    reload()
    flash(result.message, true)
    return
  }
  refreshPermit(permitJob.value.id)
  reload()
}

function depart(id: number) {
  const result = confirmDeparture(id)
  reload()
  flash(result.message, result.ok)
}

function openCreate() {
  createError.value = ''
  flightOptions.value = listEntries('flight').items
  standOptions.value = listEntries('stand').items
  Object.assign(createForm, {
    flightNo: '',
    aircraftType: '',
    standNo: '',
    bridgeNo: '',
    operator: session.operator,
    planDock: '',
    planLeave: '',
  })
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function prefillByFlight() {
  const hit = flightOptions.value.find((f) => String(f['航班号']) === createForm.flightNo)
  if (!hit) {
    return
  }
  createForm.aircraftType = String(hit['机型'] || '')
  createForm.standNo = String(hit['机位号'] || '')
  prefillByStand()
}

function prefillByStand() {
  const hit = standOptions.value.find((s) => String(s['机位编号']) === createForm.standNo)
  const config = hit ? String(hit['廊桥配置'] || '') : ''
  if (config.includes('廊桥')) {
    createForm.bridgeNo = config
  }
}

function submitCreate() {
  const result = createBridgeJob({
    bridgeNo: createForm.bridgeNo,
    standNo: createForm.standNo,
    flightNo: createForm.flightNo,
    aircraftType: createForm.aircraftType,
    planDock: createForm.planDock,
    planLeave: createForm.planLeave,
    operator: createForm.operator,
  })
  if (!result.ok || !result.job) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  reload()
  flash(result.message, true)
  // 直接打开许可工作台继续做检查项
  openPermit(result.job.id)
}

onMounted(reload)
</script>

<style scoped>
.ok-text { color: #067647; }
.state-chip { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.chip-待靠接, .chip-pending { background: #eef2f7; color: #475569; }
.chip-已靠桥 { background: #e0f2fe; color: #0369a1; }
.chip-已撤离 { background: #dcfce7; color: #15803d; }
.chip-pass { background: #dcfce7; color: #15803d; }
.chip-fail { background: #fee2e2; color: #b42318; }
.link.danger { color: #b42318; }
.link:disabled { color: #94a3b8; cursor: not-allowed; }

.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px;
  z-index: 50; overflow-y: auto;
}
.modal {
  background: #fff; border-radius: 10px; width: min(860px, 100%);
  border: 1px solid var(--border); box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.modal-sm { width: min(520px, 100%); }
.modal-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.modal-head h3 { margin: 0; font-size: 15px; }
.permit-section { padding: 12px 18px 4px; }
.permit-section h4 { margin: 0 0 8px; font-size: 13px; }
.section-hint { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 8px; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; font-size: 13px; color: #334155; }

.constraint-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.constraint-list li { display: flex; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.constraint-list li.is-ok { background: #f0fdf4; border-color: #bbf7d0; }
.constraint-list li.is-bad { background: #fef2f2; border-color: #fecaca; }
.constraint-state { font-weight: 700; }
.is-ok .constraint-state { color: #15803d; }
.is-bad .constraint-state { color: #b42318; }
.constraint-list p { margin: 2px 0 0; color: var(--muted); }

.check-table th, .check-table td { font-size: 12.5px; }
.check-remark { color: var(--muted); }

.permit-result { margin: 12px 18px 0; border-radius: 8px; padding: 10px 12px; font-size: 13px; }
.permit-result.is-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #14532d; }
.permit-result.is-bad { background: #fef2f2; border: 1px solid #fecaca; color: #7f1d1d; }
.permit-result p { margin: 0 0 6px; font-weight: 600; }
.permit-result ul { margin: 0; padding-left: 18px; }
.permit-result li { margin: 2px 0; }

.modal-foot {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 12px 18px; border-top: 1px solid var(--border); margin-top: 12px;
}
.foot-hint { font-size: 12px; color: var(--muted); }
.foot-btns { display: flex; gap: 8px; }

.create-form { padding: 14px 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.create-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.create-form input, .create-form select {
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; font-size: 13px; color: #1f2937;
}
.create-form .modal-foot { grid-column: 1 / -1; border: none; padding: 4px 0 0; margin: 0; }
.create-form .error-text { grid-column: 1 / -1; margin: 0; }
</style>
