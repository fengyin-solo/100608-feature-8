<template>
  <section class="page" data-module="bridge">
    <header class="page-head">
      <div>
        <h2>廊桥靠接管理</h2>
        <p class="page-desc">先签发作业许可（按机位与机型核限制条件），对接检查项全部通过才能靠桥，状态按 待靠接 → 已靠桥 → 已撤离 顺序推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openPermitForm">申请靠接许可</button>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openCheckPanel(row)">对接检查</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊桥靠接数据，可先申请靠接许可</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊桥靠接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <div v-if="permitModalOpen" class="modal-mask" @click.self="closePermitForm">
      <div class="modal-card">
        <h3 class="modal-title">申请廊桥靠接作业许可</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>许可编号（同一份许可重复提交只算一次）</span>
            <input v-model="permitForm.permitNo" />
          </label>
          <label class="form-item">
            <span>航班号</span>
            <input v-model="permitForm.flightNo" placeholder="如 CA1234" />
          </label>
          <label class="form-item">
            <span>对应机位</span>
            <select v-model="permitForm.standCode">
              <option value="" disabled>选择机位</option>
              <option v-for="stand in standOptions" :key="stand.code" :value="stand.code">
                {{ stand.code }}（适用：{{ stand.types || '未登记' }}）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>机型</span>
            <input v-model="permitForm.aircraftType" :placeholder="aircraftHint" />
          </label>
          <label class="form-item">
            <span>廊桥编号</span>
            <input v-model="permitForm.bridgeNo" placeholder="如 L2-10" />
          </label>
          <label class="form-item">
            <span>操作人员</span>
            <input v-model="permitForm.operator" />
          </label>
          <label class="form-item">
            <span>靠桥时间</span>
            <input v-model="permitForm.startTime" type="datetime-local" />
          </label>
          <label class="form-item">
            <span>撤桥时间</span>
            <input v-model="permitForm.endTime" type="datetime-local" />
          </label>
        </div>
        <p v-if="permitError" class="error-text">{{ permitError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closePermitForm">取消</button>
          <button class="btn primary" type="button" @click="submitPermit">提交许可</button>
        </div>
      </div>
    </div>

    <div v-if="checkRow" class="modal-mask" @click.self="closeCheckPanel">
      <div class="modal-card">
        <h3 class="modal-title">
          对接检查项 · {{ checkRow['作业编号'] }}（{{ checkProgressText }}）
        </h3>
        <p class="hint-text">检查进度逐项落库，中断后从断掉那一项接着做，不会退回重来。</p>
        <p v-if="!checkPermit" class="hint-text">这条作业没有许可记录，先申请靠接许可。</p>
        <ul v-else class="check-list">
          <li
            v-for="item in checkPermit.checks"
            :key="item.name"
            class="check-item"
            :class="{ done: item.passed }"
          >
            <span>{{ item.name }}</span>
            <span class="check-state">{{ item.passed ? '已通过' : '待检查' }}</span>
            <button
              class="btn"
              type="button"
              :disabled="item.passed || !checkEditable"
              @click="passItem(item.name)"
            >
              {{ item.passed ? '已勾选' : '通过' }}
            </button>
          </li>
        </ul>
        <p v-if="checkMessage" class="hint-text">{{ checkMessage }}</p>
        <div class="modal-actions">
          <button
            v-if="checkPermit"
            class="btn"
            type="button"
            :disabled="!checkEditable || allChecksPassed"
            @click="passItem()"
          >
            从断点继续检查
          </button>
          <button class="btn primary" type="button" @click="closeCheckPanel">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applyBridgePermit,
  downloadEntries,
  listEntries,
  listPermits,
  moduleMeta,
  passBridgeCheck,
  runAction as applyAction,
  suggestPermitNo,
} from '@/api/local-service'
import type { BridgePermit, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('bridge')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses
const stats = [{"label": "今日靠接作业", "value": 0}, {"label": "待靠桥作业", "value": 0}, {"label": "异常中止作业", "value": 0}]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const permits = ref<BridgePermit[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  okMessage.value = result.message
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    permits.value = listPermits()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊桥靠接列表读取失败'
  }
}

// ---------- 许可申请 ----------

const permitModalOpen = ref(false)
const permitError = ref('')
const permitForm = ref({
  permitNo: '',
  flightNo: '',
  aircraftType: '',
  bridgeNo: '',
  standCode: '',
  operator: '',
  startTime: '',
  endTime: '',
})
const standOptions = ref<{ code: string; types: string }[]>([])

const aircraftHint = computed(() => {
  const stand = standOptions.value.find((item) => item.code === permitForm.value.standCode)
  return stand && stand.types ? `该机位适用：${stand.types}` : '如 A320'
})

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function openPermitForm() {
  permitError.value = ''
  standOptions.value = listEntries('stand').items.map((stand) => ({
    code: String(stand['机位编号'] ?? ''),
    types: String(stand['适用机型'] ?? ''),
  }))
  const now = Date.now()
  permitForm.value = {
    permitNo: suggestPermitNo(),
    flightNo: '',
    aircraftType: '',
    bridgeNo: '',
    standCode: standOptions.value[0]?.code ?? '',
    operator: session.operator,
    startTime: toLocalInput(new Date(now + 30 * 60000)),
    endTime: toLocalInput(new Date(now + 150 * 60000)),
  }
  permitModalOpen.value = true
}

function closePermitForm() {
  permitModalOpen.value = false
}

function submitPermit() {
  permitError.value = ''
  const result = applyBridgePermit({
    ...permitForm.value,
    startTime: permitForm.value.startTime.replace('T', ' '),
    endTime: permitForm.value.endTime.replace('T', ' '),
  })
  if (!result.ok) {
    permitError.value = result.message
    return
  }
  permitModalOpen.value = false
  reload()
  okMessage.value = result.message
}

// ---------- 对接检查 ----------

const checkRow = ref<EntryRow | null>(null)
const checkMessage = ref('')
const checkPermit = computed(() => {
  const row = checkRow.value
  if (!row) {
    return undefined
  }
  return permits.value.find((permit) => permit.permitNo === String(row['作业编号'] ?? ''))
})
const checkEditable = computed(
  () => Boolean(checkPermit.value) && String(checkRow.value?.status ?? '') === '待靠接',
)
const allChecksPassed = computed(() => {
  const checks = checkPermit.value?.checks ?? []
  return checks.length > 0 && checks.every((item) => item.passed)
})
const checkProgressText = computed(() => {
  const checks = checkPermit.value?.checks ?? []
  return `${checks.filter((item) => item.passed).length}/${checks.length}`
})

function openCheckPanel(row: EntryRow) {
  checkMessage.value = ''
  checkRow.value = row
}

function closeCheckPanel() {
  checkRow.value = null
  reload()
}

function passItem(itemName?: string) {
  const row = checkRow.value
  if (!row) {
    return
  }
  const result = passBridgeCheck(Number(row.id), itemName)
  checkMessage.value = result.message
  reload()
  checkRow.value = rows.value.find((item) => Number(item.id) === Number(row.id)) ?? row
}

onMounted(reload)
</script>
