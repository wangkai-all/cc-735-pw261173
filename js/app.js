import { DEFAULT_DRAFT, parseWorkspaceDraft } from './input.js';
import { SAMPLES, getSample } from './samples.js';
import { verifyWithInterpreter, findEarliestAffectedRound } from './compare.js';
import { countElectionBatch } from './counter.js';
import {
  AUDIT_SCHEMA,
  REPORT_SCHEMA,
  buildAuditExport,
  buildConfirmedReport,
  checksumResult,
  flowEntriesCsv,
  markdownReport,
  reproduceReport,
  roundsCsv,
} from './reporting.js';
import { loadReports, loadWorkspace, saveReports, saveWorkspace } from './storage.js';
import { candidateName, downloadTextFile, escapeHtml, fmtDecimal, fmtExact } from './format.js';
import { Fraction } from './fractions.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseBranch() {
  return { id: 'base', name: '共享基线', parentId: null, decisions: {}, createdAt: new Date().toISOString() };
}

function normalizeBranches(stored) {
  const usedIds = new Set();
  const branches = [];
  if (Array.isArray(stored)) {
    for (const value of stored) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || usedIds.has(value.id)) continue;
      usedIds.add(value.id);
      branches.push({
        id: value.id,
        name: typeof value.name === 'string' ? value.name : value.id,
        parentId: typeof value.parentId === 'string' ? value.parentId : null,
        decisions: value.decisions && typeof value.decisions === 'object' && !Array.isArray(value.decisions) ? value.decisions : {},
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
      });
    }
  }
  if (!branches.some((branch) => branch.id === 'base')) branches.unshift(baseBranch());
  return branches;
}

const storedWorkspace = loadWorkspace();
const initialSample = getSample('tie-three-way');
const storedDraft = storedWorkspace?.draft && typeof storedWorkspace.draft === 'object' && !Array.isArray(storedWorkspace.draft)
  ? storedWorkspace.draft
  : null;
const storedStatusById = storedDraft?.statusById;
const safeStatusById = storedStatusById && typeof storedStatusById === 'object' && !Array.isArray(storedStatusById)
  ? storedStatusById
  : (initialSample.draft.statusById ?? {});

const state = {
  draft: {
    ...clone(DEFAULT_DRAFT),
    ...(storedDraft ?? initialSample.draft),
    statusById: safeStatusById,
  },
  branches: normalizeBranches(storedWorkspace?.branches),
  activeBranchId: storedWorkspace?.activeBranchId ?? 'base',
  impact: storedWorkspace?.impact ?? null,
  reports: loadReports(),
  parsed: null,
  result: null,
  verification: null,
  runError: null,
  currentChecksum: null,
  activeTab: 'setup',
  selectedCandidateId: null,
  ballotSearch: '',
  traceFilter: '',
  reproductions: {},
  reportsStorageOk: true,
  toastTimer: null,
};

if (!state.branches.some((b) => b.id === state.activeBranchId)) state.activeBranchId = state.branches[0]?.id ?? 'base';

function getActiveBranch() {
  return state.branches.find((b) => b.id === state.activeBranchId) ?? state.branches[0] ?? baseBranch();
}

function persistWorkspace() {
  const saved = saveWorkspace({
    draft: state.draft,
    branches: state.branches,
    activeBranchId: state.activeBranchId,
    impact: state.impact,
    savedAt: new Date().toISOString(),
  });
  const saveState = $('#saveState');
  if (!saveState) return saved;
  saveState.classList.toggle('save-failed', !saved);
  saveState.textContent = saved
    ? `已自动保存到本机浏览器 ${new Date().toLocaleTimeString('zh-CN')}`
    : '⚠️ 本机工作区存储失败（隐私模式或容量不足），请及时导出 JSON / CSV 备份';
  return saved;
}

function persistReports() {
  const saved = saveReports(state.reports);
  state.reportsStorageOk = saved;
  return saved;
}

let saveTimer = null;
function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistWorkspace, 250);
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function safeFileName(label) {
  return String(label || 'traceable-stv').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80);
}

function nameOf(id) {
  if (!id) return '耗尽票池';
  return candidateName(state.parsed?.input ?? state.result, id);
}

function statusLabel(status) {
  return { continuing: '继续', elected: '当选', eliminated: '淘汰' }[status] ?? status;
}

function syncFormFromState() {
  $('#titleInput').value = state.draft.title ?? '';
  $('#seatsInput').value = state.draft.seats ?? 2;
  $('#ballotOrderInput').value = state.draft.ballotOrder ?? 'input';
  $('#tiePolicyInput').value = state.draft.tiePolicy ?? 'manual';
  $('#duplicateInput').value = state.draft.duplicatePreference ?? 'first';
  $('#seedInput').value = state.draft.tieSeed ?? state.draft.orderSeed ?? '';
  $('#candidateText').value = state.draft.candidateText ?? '';
  $('#ballotText').value = state.draft.ballotText ?? '';
  $('#sampleSelect').innerHTML = SAMPLES.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  $('#sampleQuick').innerHTML = SAMPLES.map((s) => `
    <button type="button" class="btn tiny" data-action="load-sample-id" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>
  `).join('');
  $('#sampleDescription').textContent = getSample($('#sampleSelect').value)?.description ?? '';
}

function syncDraftFromForm() {
  state.draft.title = $('#titleInput').value;
  state.draft.seats = Number.parseInt($('#seatsInput').value, 10);
  state.draft.ballotOrder = $('#ballotOrderInput').value;
  state.draft.tiePolicy = $('#tiePolicyInput').value;
  state.draft.duplicatePreference = $('#duplicateInput').value;
  const seed = $('#seedInput').value || 'traceable-stv';
  state.draft.tieSeed = seed;
  state.draft.orderSeed = seed;
  state.draft.candidateText = $('#candidateText').value;
  state.draft.ballotText = $('#ballotText').value;
}

function recompute() {
  syncDraftFromForm();
  const parsed = parseWorkspaceDraft(state.draft);
  state.parsed = parsed;
  state.runError = null;

  if (!parsed.ok) {
    state.result = null;
    state.verification = null;
    state.currentChecksum = null;
    renderAll();
    persistWorkspace();
    return;
  }

  const branch = getActiveBranch();
  try {
    const verification = verifyWithInterpreter(parsed.input, branch.decisions ?? {}, { maxBallots: 240 });
    state.verification = verification;
    state.result = verification.batch;
    state.currentChecksum = null;
    const checksumElement = $('[data-current-checksum]');
    if (checksumElement) checksumElement.textContent = '计算中…';
    checksumResult(state.result).then((checksum) => {
      state.currentChecksum = checksum;
      const el = $('[data-current-checksum]');
      if (el) el.textContent = checksum;
    });
    if (state.selectedCandidateId && !parsed.input.candidates.some((c) => c.id === state.selectedCandidateId)) {
      state.selectedCandidateId = null;
    }
    if (!state.selectedCandidateId) state.selectedCandidateId = parsed.input.candidates[0]?.id ?? null;
  } catch (error) {
    console.error(error);
    state.runError = error instanceof Error ? error.message : String(error);
    state.result = null;
    state.verification = null;
  }

  persistWorkspace();
  renderAll();
}

function preferencePills(ballot) {
  const candidateByRef = new Map();
  for (const c of state.parsed?.input.candidates ?? []) {
    candidateByRef.set(c.id, c);
    candidateByRef.set(c.name.toLowerCase(), c);
  }
  const seen = new Set();
  const pills = [];
  for (const ref of ballot.rawPreferences ?? []) {
    const candidate = candidateByRef.get(ref) ?? candidateByRef.get(String(ref).toLowerCase());
    if (!candidate) {
      pills.push(`<span class="pref-pill unknown" title="无法识别">${escapeHtml(ref)}?</span>`);
    } else if (seen.has(candidate.id)) {
      pills.push(`<span class="pref-pill dup" title="重复候选，按配置处理">${escapeHtml(candidate.name)}↻</span>`);
    } else {
      seen.add(candidate.id);
      pills.push(`<span class="pref-pill">${escapeHtml(candidate.name)}</span>`);
    }
  }
  if (pills.length === 0) pills.push('<span class="muted small">（无偏好）</span>');
  return pills.join('');
}

function renderIssues() {
  const panel = $('#issuesPanel');
  const parsed = state.parsed;
  if (!parsed) {
    panel.innerHTML = '<div class="empty-state">尚未解析。</div>';
    return;
  }
  $('#parseStats').innerHTML = [
    `候选人 <strong>${parsed.stats.candidateCount}</strong>`,
    `选票 <strong>${parsed.stats.ballotCount}</strong>`,
    `有效 <strong>${parsed.stats.validCount}</strong>`,
    `无有效偏好 <strong>${parsed.stats.noValidCount}</strong>`,
    `已撤销 <strong>${parsed.stats.rescindedCount}</strong>`,
  ].map((x) => `<span class="stat-chip">${x}</span>`).join('');

  if (!parsed.issues.length) {
    panel.innerHTML = '<div class="issue info"><span>✅</span><div>解析通过，没有警告。</div></div>';
    return;
  }
  panel.innerHTML = parsed.issues.map((issue) => `
    <div class="issue ${escapeHtml(issue.severity)}">
      <span>${issue.severity === 'error' ? '⛔' : issue.severity === 'warning' ? '⚠️' : 'ℹ️'}</span>
      <div>${escapeHtml(issue.message)}</div>
    </div>`).join('');
}

function renderBallotTable() {
  const wrap = $('#ballotTableWrap');
  if (!state.parsed?.input) {
    wrap.innerHTML = '<div class="empty-state">请先填写候选人与选票。</div>';
    return;
  }
  const query = state.ballotSearch.trim().toLowerCase();
  const ballots = state.parsed.input.ballots.filter((b) => {
    if (!query) return true;
    return [b.id, b.rawText, ...(b.preferences ?? []).map(nameOf)].join(' ').toLowerCase().includes(query);
  });

  wrap.innerHTML = `
    <table>
      <thead><tr><th>编号</th><th>原始排序 / 解析</th><th>状态</th><th class="right">争议操作</th></tr></thead>
      <tbody>
        ${ballots.map((b) => `
          <tr class="${b.status === 'rescinded' ? 'row-rescinded' : ''} ${b.disputed ? 'row-disputed' : ''}">
            <td class="nowrap"><strong>${escapeHtml(b.id)}</strong><div class="muted small">第 ${b.lineNo} 行</div></td>
            <td><div class="raw-prefs">${preferencePills(b)}</div><div class="muted small">${escapeHtml(b.rawText)}</div></td>
            <td>
              <div class="pill-row">
                ${b.status === 'rescinded' ? '<span class="badge bad">已撤销</span>' : '<span class="badge good">计入</span>'}
                ${b.disputed ? '<span class="badge warn">争议</span>' : ''}
                ${!b.valid ? '<span class="badge neutral">无有效偏好</span>' : ''}
              </div>
              ${b.rescindReason ? `<div class="small muted">原因：${escapeHtml(b.rescindReason)}</div>` : ''}
            </td>
            <td class="right">
              <div class="table-actions" style="justify-content:flex-end">
                <button class="btn tiny" data-action="toggle-dispute" data-id="${escapeHtml(b.id)}">${b.disputed ? '取消争议' : '标记争议'}</button>
                ${b.status === 'rescinded'
                  ? `<button class="btn tiny" data-action="restore-ballot" data-id="${escapeHtml(b.id)}">恢复</button>`
                  : `<button class="btn tiny danger" data-action="rescind-ballot" data-id="${escapeHtml(b.id)}">撤销</button>`}
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderGlobalStatus() {
  const el = $('#globalStatus');
  if (state.runError) {
    el.className = 'badge bad';
    el.textContent = `计数错误：${state.runError}`;
  } else if (!state.parsed?.ok) {
    el.className = 'badge bad';
    el.textContent = '配置存在致命问题';
  } else if (state.result?.status === 'tie_pending') {
    el.className = 'badge warn';
    el.textContent = '存在并列，等待保存分支裁决';
  } else if (state.result?.status === 'complete') {
    el.className = state.verification?.matched === false ? 'badge bad' : 'badge good';
    el.textContent = state.verification?.ran
      ? (state.verification.matched ? '精确计数完成 · 逐票解释器一致' : '批量/逐票结果不一致')
      : '精确计数完成';
  } else {
    el.className = 'badge neutral';
    el.textContent = '尚未计数';
  }
}

function fractionTile(label, value, sub = '', tone = '') {
  return `<div class="stat-tile ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function renderSummary() {
  const container = $('#summaryCards');
  if (!state.result) {
    container.innerHTML = `
      <div class="stat-tile" style="grid-column:1/-1">
        <div class="label">等待计数</div>
        <div class="sub">${state.runError ? escapeHtml(state.runError) : '请在“配置与选票”中检查解析错误，然后重新计数。'}</div>
      </div>`;
    return;
  }
  const r = state.result;
  const parity = state.verification;
  container.innerHTML = [
    fractionTile('计数状态', r.status === 'complete' ? '完成' : '并列待裁', `第 ${r.rounds.length} 轮 · ${r.engine}`),
    fractionTile('Droop 精确配额', `<span class="exact">${r.quota.toString()}</span>`, `正式有效票 ${r.formalValue} / 计票票值 ${r.totalCounted}`),
    fractionTile('当选', r.electedIds.length ? r.electedIds.map((id) => escapeHtml(nameOf(id))).join('、') : '—', `席位 ${state.parsed.input.seats}`),
    fractionTile('耗尽票值', `<span class="exact">${r.exhausted.toString()}</span>`, '含空偏好与无后续继续候选'),
    fractionTile('守恒', r.finalConservation.balanced ? '✅ 平衡' : '❌ 不平', `<span class="exact">${r.finalConservation.candidateHeld.toString()} + ${r.finalConservation.exhausted.toString()} = ${r.finalConservation.heldPlusExhausted.toString()}</span>`),
    fractionTile('逐票对照', !parity?.ran ? '跳过' : parity.matched ? '✅ 一致' : '❌ 差异', parity?.ran ? `守恒 ${parity.conservationOk ? '通过' : '失败'} · 差异 ${parity.differences.length}` : parity?.reason ?? ''),
  ].join('');
}

function renderImpact() {
  const el = $('#impactBanner');
  const impact = state.impact;
  if (!impact) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="impact-banner">
      <h3>撤票 / 恢复影响分析：${escapeHtml(impact.ballotId ?? '')}</h3>
      <p>${impact.earliestRound === 0
        ? `最早在<strong>初始配置阶段（第 0 阶段）</strong>发现变化：${escapeHtml(impact.reason)}`
        : impact.earliestRound
          ? `最早受影响的是<strong>第 ${impact.earliestRound} 轮</strong>；其后的轮次已用当前分支决策精确重算。${escapeHtml(impact.reason ?? '')}`
          : escapeHtml(impact.reason ?? '未发现差异')}</p>
      ${impact.differences?.length ? `<pre class="checksum">${escapeHtml(JSON.stringify(impact.differences.slice(0, 4), null, 2))}</pre>` : ''}
      <p class="small muted">动作：${escapeHtml(impact.action)} · 时间：${escapeHtml(impact.at)}${impact.reasonText ? ` · 原因：${escapeHtml(impact.reasonText)}` : ''}</p>
    </div>`;
}

function branchResultFor(branch) {
  if (!state.parsed?.ok) return null;
  try {
    return countElectionBatch(state.parsed.input, branch.decisions ?? {});
  } catch (error) {
    return { error: error.message };
  }
}

function renderBranchPanel() {
  const el = $('#branchPanel');
  if (!state.parsed?.ok) {
    el.innerHTML = '<div class="empty-state">修复配置错误后可管理并列分支。</div>';
    return;
  }

  const active = getActiveBranch();
  const pendingTie = state.result?.pendingTie;
  const allOptions = pendingTie?.options ?? [];

  let sharedHtml = '';
  if (active?.parentId) {
    const parent = state.branches.find((b) => b.id === active.parentId);
    if (parent) {
      const parentResult = branchResultFor(parent);
      if (parentResult && !parentResult.error && state.result) {
        const impact = findEarliestAffectedRound(parentResult, state.result);
        const shared = impact.earliestRound == null ? state.result.rounds.length : Math.max(0, impact.earliestRound - 1);
        sharedHtml = `<p class="branch-meta">与父分支「${escapeHtml(parent.name)}」共享前 <strong>${shared}</strong> 轮不可变计数前缀。</p>`;
      }
    }
  }

  el.innerHTML = `
    <div class="card-head"><h2>并列裁决分支树</h2><p>每个分支只保存决策映射；选择分支只切换只读结果，不会改写其他分支。</p></div>
    ${sharedHtml}
    ${pendingTie ? `
      <div class="tie-box">
        <strong>待裁决：第 ${pendingTie.round} 轮最低票精确并列</strong>
        <div class="branch-meta">tie key <code>${escapeHtml(pendingTie.key)}</code><br>共同票值 <code>${pendingTie.tieValue.toString()}</code></div>
        <div class="tie-options">
          ${allOptions.map((id) => `
            <button class="btn small primary" data-action="branch-choice" data-key="${escapeHtml(pendingTie.key)}" data-choice="${escapeHtml(id)}">
              新建分支并裁决为：${escapeHtml(nameOf(id))}
            </button>`).join('')}
          <button class="btn small" data-action="branch-all" data-key="${escapeHtml(pendingTie.key)}">一次保存 ${allOptions.length} 个候选裁决分支</button>
        </div>
      </div>` : ''}
    <div class="branch-list">
      ${state.branches.map((branch, index) => {
        const r = branch.id === active.id ? state.result : branchResultFor(branch);
        const summary = r?.error
          ? `<span class="badge bad">${escapeHtml(r.error)}</span>`
          : r
            ? `<span class="badge ${r.status === 'complete' ? 'good' : 'warn'}">${r.status === 'complete' ? '完成' : '待并列'}</span>
               <span class="badge info">当选 ${r.electedIds.map(nameOf).join('、') || '—'}</span>`
            : '';
        const decisionCount = Object.keys(branch.decisions ?? {}).length;
        return `
          <div class="branch-item ${branch.id === active?.id ? 'active' : ''}" role="button" tabindex="0" data-action="select-branch" data-id="${escapeHtml(branch.id)}">
            <div class="branch-title">
              <span>${index === 0 ? '┌ ' : '├ '}${escapeHtml(branch.name)}</span>
              ${branch.id === 'base' ? '<span class="badge neutral">BASE</span>' : ''}
            </div>
            <div class="branch-meta">${summary}</div>
            <div class="branch-meta">${decisionCount} 个裁决 · <code>${escapeHtml(branch.id)}</code></div>
            ${branch.parentId ? `<div class="branch-tree-line">↳ parent ${escapeHtml(branch.parentId)}</div>` : ''}
            <div class="table-actions" style="margin-top:.45rem">
              <button class="btn tiny" data-action="select-branch" data-id="${escapeHtml(branch.id)}">选择</button>
              ${branch.id !== 'base' ? `<button class="btn tiny danger" data-action="delete-branch" data-id="${escapeHtml(branch.id)}">删除</button>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>
    <p class="small muted">默认并列规则：${({ manual: '人工保存分支', 'candidate-order': '候选人名单顺序', seeded: '种子哈希' })[state.draft.tiePolicy]}。已自动裁决的并列仍可在轮次卡片中“另存分支”。</p>`;
}

function renderFlow(flow) {
  const from = flow.fromCandidateId ? nameOf(flow.fromCandidateId) : '初始票仓';
  const to = flow.toCandidateId ? nameOf(flow.toCandidateId) : '耗尽票池';
  const kindLabel = { initial: '初始分配', surplus: '余额转移', elimination: '淘汰转移' }[flow.kind] ?? flow.kind;
  return `
    <div class="flow-item">
      <div class="flow-head">
        <span class="badge ${flow.kind === 'surplus' ? 'info' : flow.kind === 'elimination' ? 'warn' : 'neutral'}">${kindLabel}</span>
        ${flow.fromCandidateId ? `<button class="candidate-link" data-action="select-candidate" data-id="${flow.fromCandidateId}">${escapeHtml(from)}</button>` : `<strong>${escapeHtml(from)}</strong>`}
        <span class="flow-arrow">→</span>
        ${flow.toCandidateId ? `<button class="candidate-link" data-action="select-candidate" data-id="${flow.toCandidateId}">${escapeHtml(to)}</button>` : `<strong>${escapeHtml(to)}</strong>`}
        <span class="badge neutral">比例 <span class="exact">${fmtExact(flow.ratio)}</span></span>
        <span class="badge good">总量 <span class="exact">${fmtExact(flow.amount)}</span></span>
        <span class="muted small">${flow.entryCount ?? flow.entries.length} 笔原票分录</span>
      </div>
      <details>
        <summary class="small" style="cursor:pointer;margin-top:.35rem">展开原票金额分录</summary>
        <div class="flow-entries">
          <table><thead><tr><th>原票</th><th class="num">转移精确金额</th><th class="num">源票批保留</th></tr></thead>
          <tbody>
            ${flow.entries.map((e) => `
              <tr>
                <td><code class="mono">${escapeHtml(e.ballotId)}</code></td>
                <td class="num exact">${fmtExact(e.amount)}<span class="decimal">${fmtDecimal(e.amount, 8)}</span></td>
                <td class="num exact">${e.retainedAmount !== undefined ? fmtExact(e.retainedAmount) : '—'}</td>
              </tr>`).join('')}
          </tbody></table>
        </div>
      </details>
    </div>`;
}

function renderTieActions(round) {
  const tie = round.tie;
  if (!tie) return '';
  const active = getActiveBranch();
  const selected = tie.selectedId ?? round.resolution?.selectedId;
  const alternatives = tie.tiedIds.filter((id) => id !== selected);
  return `
    <div class="tie-box">
      <div class="row-between">
        <strong>${tie.resolution === 'pending' ? '⚠️ 精确并列，等待裁决' : '并列事件已处置'}</strong>
        <span class="badge ${tie.resolution === 'pending' ? 'warn' : 'good'}">${tie.resolution === 'pending' ? 'PENDING' : tie.resolvedBy}</span>
      </div>
      <p class="small">tie key <code>${escapeHtml(tie.key)}</code> · 共同票值 <code>${fmtExact(tie.tieValue)}</code></p>
      ${round.resolution?.matchedDecisionKey ? `<p class="small muted">轮次号已漂移；已按“并列类型 + 同一组候选人”重放旧裁决 <code>${escapeHtml(round.resolution.matchedDecisionKey)}</code>。</p>` : ''}
      ${selected ? `<p>当前选择：<button class="candidate-link" data-action="select-candidate" data-id="${selected}">${escapeHtml(nameOf(selected))}</button></p>` : ''}
      <div class="tie-options">
        ${tie.resolution === 'pending' ? tie.options.map((id) => `
          <button class="btn small primary" data-action="branch-choice" data-key="${escapeHtml(tie.key)}" data-choice="${escapeHtml(id)}">新建分支：${escapeHtml(nameOf(id))}</button>
        `).join('') : alternatives.map((id) => `
          <button class="btn small" data-action="branch-choice" data-key="${escapeHtml(tie.key)}" data-choice="${escapeHtml(id)}" data-from-active="${escapeHtml(active.id)}">另存分支并改裁：${escapeHtml(nameOf(id))}</button>
        `).join('')}
      </div>
    </div>`;
}

function renderRounds() {
  const el = $('#roundsContainer');
  if (state.runError) {
    el.innerHTML = `<div class="empty-state"><strong>计数引擎抛出错误</strong><p>${escapeHtml(state.runError)}</p></div>`;
    return;
  }
  if (!state.result) {
    el.innerHTML = '<div class="empty-state">没有可显示的轮次。请先修复左侧解析错误。</div>';
    return;
  }
  const r = state.result;
  const maxTally = r.candidateIds.reduce((max, id) => {
    const value = r.rounds[0]?.tallies?.[id] ?? r.finalTallies[id];
    return value && value.gt?.(max) ? value : max;
  }, r.quota);

  el.innerHTML = r.rounds.map((round) => {
    const roundFlows = r.flows.filter((f) => f.round === round.index);
    const initialFlows = roundFlows.filter((f) => f.kind === 'initial');
    const actionFlows = roundFlows.filter((f) => f.kind !== 'initial');
    const batches = round.batches ?? [];
    return `
      <article class="round-card">
        <div class="round-head">
          <div class="round-title-wrap">
            <div class="round-index">${round.index}</div>
            <div>
              <h3>${escapeHtml(round.title ?? round.kind)}</h3>
              <p class="muted small">${escapeHtml(round.kind)} · 剩余席位 ${round.remainingSeats ?? '—'} · 本轮当选 ${round.electedThisRound.map(nameOf).join('、') || '无'} · 淘汰 ${round.eliminatedThisRound.map(nameOf).join('、') || '无'}</p>
            </div>
          </div>
          <span class="badge neutral">${round.flows?.length ?? actionFlows.length} 个流向批次</span>
        </div>
        <div class="round-body">
          <div class="table-wrap">
            <table class="tally-table">
              <thead><tr><th>候选人</th><th>状态</th><th class="vote-bar-cell">相对票型</th><th class="num">轮初精确票值</th><th class="num">轮末精确票值</th><th class="num">净变化</th></tr></thead>
              <tbody>
                ${r.candidateIds.map((id) => {
                  const start = round.tallies[id];
                  const end = round.postTallies?.[id] ?? start;
                  const delta = end.sub(start);
                  const barWidth = start.isZero() ? 0 : Math.max(2, start.toDecimal(6) / Math.max(0.000001, maxTally.toDecimal(6)) * 100);
                  return `<tr>
                    <td><button class="candidate-link" data-action="select-candidate" data-id="${id}">${escapeHtml(nameOf(id))}</button></td>
                    <td><span class="badge ${round.statusById?.[id] === 'elected' ? 'good' : round.statusById?.[id] === 'eliminated' ? 'bad' : 'neutral'}">${statusLabel(round.statusById?.[id])}</span></td>
                    <td class="vote-bar-cell"><div class="vote-bar"><span style="width:${barWidth}%"></span></div></td>
                    <td class="num exact">${fmtExact(start)}<span class="decimal">${fmtDecimal(start, 5)}</span></td>
                    <td class="num exact">${fmtExact(end)}<span class="decimal">${fmtDecimal(end, 5)}</span></td>
                    <td class="num exact ${delta.gt(0) ? 'amount-pos' : delta.lt(0) ? 'amount-neg' : 'muted'}">${delta.gt(0) ? '+' : ''}${fmtExact(delta)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>

          ${renderTieActions(round)}

          ${round.index === 1 && initialFlows.length ? `
            <details class="flow-list" ${r.counts.noValidBallots ? 'open' : ''}>
              <summary class="btn small" style="width:fit-content">查看初始票仓分配（${initialFlows.length} 批）</summary>
              ${initialFlows.map(renderFlow).join('')}
            </details>` : ''}

          ${round.index === 1 && r.processingOrder?.length ? `
            <details>
              <summary class="small" style="cursor:pointer">查看配置的选票处理顺序（${r.processingOrder.length} 张；批量精确汇总与顺序无关，逐票解释器按此顺序执行）</summary>
              <div class="conservation-line" style="margin-top:.45rem; display:block; line-height:1.9">${r.processingOrder.map((id) => escapeHtml(id)).join(' → ')}</div>
            </details>` : ''}

          ${batches.length ? batches.map((batch) => `
            <div class="flow-item" style="background:var(--surface-2)">
              <div class="flow-head">
                <strong>票批 ${escapeHtml(batch.id)}</strong>
                <span>候选人：${batch.candidateId ? `<button class="candidate-link" data-action="select-candidate" data-id="${batch.candidateId}">${escapeHtml(nameOf(batch.candidateId))}</button>` : '初始'}</span>
                ${batch.totalVotes != null ? `<span class="badge neutral">V=<span class="exact">${fmtExact(batch.totalVotes)}</span></span>` : ''}
                ${batch.surplus != null ? `<span class="badge info">余额=<span class="exact">${fmtExact(batch.surplus)}</span></span>` : ''}
                ${batch.ratio != null ? `<span class="badge violet">转移系数=<span class="exact">${fmtExact(batch.ratio)}</span></span>` : ''}
                <span class="badge good">转出 <span class="exact">${fmtExact(batch.amountTransferred)}</span></span>
                <span class="badge bad">耗尽 <span class="exact">${fmtExact(batch.amountExhausted)}</span></span>
              </div>
            </div>`).join('') : ''}

          <div class="flow-list">${actionFlows.map(renderFlow).join('')}</div>

          ${round.conservation ? `
            <div class="conservation-line">
              <span class="badge ${round.conservation.balanced ? 'good' : 'bad'}">${round.conservation.balanced ? '守恒 ✓' : '不守恒'}</span>
              <span>${fmtExact(round.conservation.candidateHeld)} (候选人持有) + ${fmtExact(round.conservation.exhausted)} (耗尽) = ${fmtExact(round.conservation.heldPlusExhausted)}</span>
              <span class="muted">应等于计票票值 ${fmtExact(round.conservation.totalCounted)}</span>
              ${round.conservation.rescindedValue && !round.conservation.rescindedValue.isZero() ? `
                <span class="badge bad">撤销封存 ${fmtExact(round.conservation.rescindedValue)}</span>
                <span class="muted">全量：${fmtExact(round.conservation.heldPlusExhausted)} + ${fmtExact(round.conservation.rescindedValue)} = ${fmtExact(round.conservation.fullSum)} / 原票 ${fmtExact(round.conservation.originalTotal)}，${round.conservation.fullBalanced ? '平衡' : '不平衡'}</span>
              ` : ''}
            </div>` : ''}
        </div>
      </article>`;
  }).join('');
}

function renderCandidateTrace() {
  const grid = $('#candidateTraceGrid');
  const detail = $('#traceDetail');
  if (!state.result || !state.parsed?.ok) {
    grid.innerHTML = '';
    detail.innerHTML = '<div class="empty-state">完成一次有效计数后，可在此点击候选人追溯原票。</div>';
    return;
  }
  const r = state.result;
  grid.innerHTML = r.candidateIds.map((id) => `
    <button class="candidate-tile ${state.selectedCandidateId === id ? 'active' : ''}" data-action="select-candidate" data-id="${id}">
      <div class="name">${escapeHtml(nameOf(id))}</div>
      <div class="value exact">${fmtExact(r.finalTallies[id])}</div>
      <div class="muted small">${statusLabel(state.result.rounds.at(-1)?.statusById?.[id] ?? 'continuing')} · 点击追溯原票</div>
    </button>`).join('');

  const id = state.selectedCandidateId;
  if (!id || !r.candidateIds.includes(id)) {
    detail.innerHTML = '<div class="empty-state">请选择一名候选人。</div>';
    return;
  }

  const query = state.traceFilter.trim().toLowerCase();
  const events = [];
  let totalIn = null;
  let totalOut = null;
  for (const flow of r.flows) {
    if (flow.toCandidateId === id) {
      const entries = flow.entries.filter((e) => !query || e.ballotId.toLowerCase().includes(query) || (state.parsed.input.ballots.find((b) => b.id === e.ballotId)?.rawText ?? '').toLowerCase().includes(query));
      if (entries.length) events.push({ direction: 'in', flow, entries });
    }
    if (flow.fromCandidateId === id) {
      const entries = flow.entries.filter((e) => !query || e.ballotId.toLowerCase().includes(query) || (state.parsed.input.ballots.find((b) => b.id === e.ballotId)?.rawText ?? '').toLowerCase().includes(query));
      if (entries.length) events.push({ direction: 'out', flow, entries });
    }
  }
  const sumEntries = (entries) => entries.reduce((sum, entry) => sum.add(entry.amount), new Fraction(0n));
  totalIn = sumEntries(events.filter((event) => event.direction === 'in').flatMap((event) => event.entries));
  totalOut = sumEntries(events.filter((event) => event.direction === 'out').flatMap((event) => event.entries));

  const ballotById = new Map(state.parsed.input.ballots.map((b) => [b.id, b]));
  detail.innerHTML = `
    <div class="card-head row-between">
      <div>
        <h2>${escapeHtml(nameOf(id))} 的原票变化账本</h2>
        <p>最终票值 <span class="exact"><strong>${fmtExact(r.finalTallies[id])}</strong></span> <span class="decimal">${fmtDecimal(r.finalTallies[id], 9)}</span></p>
      </div>
      <div class="pill-row">
        <span class="badge good">分录流入 ${fmtExact(totalIn)}</span>
        <span class="badge warn">分录转出 ${fmtExact(totalOut)}</span>
        <span class="badge neutral">事件 ${events.length}</span>
      </div>
    </div>
    <p class="small muted">说明：流入/转出是逐笔发生额；余额转移后源票批可能保留一部分，因此二者差额不等于最终票值。每轮完整余额以轮次表和守恒关系为准。</p>
    ${events.length === 0 ? '<div class="empty-state">没有匹配的原票变化事件。</div>' : events.map(({ direction, flow, entries }) => `
      <div class="trace-event ${direction}">
        <div class="trace-event-head">
          <span>${direction === 'in' ? '＋ 流入' : '－ 转出'} · 第 ${flow.round} 轮 · ${({ initial: '初始分配', surplus: '余额转移', elimination: '淘汰转移' })[flow.kind] ?? flow.kind}</span>
          <span>${direction === 'in' ? `来自 ${flow.fromCandidateId ? escapeHtml(nameOf(flow.fromCandidateId)) : '初始票仓'}` : `流向 ${flow.toCandidateId ? escapeHtml(nameOf(flow.toCandidateId)) : '耗尽票池'}`}</span>
          <span class="badge neutral">系数 ${fmtExact(flow.ratio)}</span>
        </div>
        <div class="table-wrap" style="margin-top:.55rem">
          <table><thead><tr><th>原票编号</th><th>原始排序</th><th class="num">${direction === 'in' ? '增加票值' : '转出票值'}</th><th class="num">保留在源票批</th></tr></thead>
          <tbody>
            ${entries.map((e) => {
              const ballot = ballotById.get(e.ballotId);
              return `<tr>
                <td><strong>${escapeHtml(e.ballotId)}</strong>${ballot?.disputed ? ' <span class="badge warn">争议</span>' : ''}${ballot?.status === 'rescinded' ? ' <span class="badge bad">已撤销</span>' : ''}</td>
                <td class="raw-prefs">${escapeHtml(ballot?.rawText ?? '')}</td>
                <td class="num exact ${direction === 'in' ? 'amount-pos' : 'amount-neg'}">${direction === 'in' ? '+' : '-'}${fmtExact(e.amount)}</td>
                <td class="num exact">${e.retainedAmount !== undefined ? fmtExact(e.retainedAmount) : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody></table>
        </div>
      </div>`).join('')}`;
}

function renderReports() {
  const el = $('#reportsList');
  const storageBanner = state.reportsStorageOk === false ? `
    <div class="issue error" role="alert">
      <span>⚠️</span>
      <div><strong>浏览器本机报告存储写入失败。</strong>当前报告只保留在本页内存中，刷新前请使用“导出报告 JSON”备份；也可能是 localStorage 配额已满。</div>
    </div>` : '';
  if (!state.reports.length) {
    el.innerHTML = `${storageBanner}<div class="empty-state">还没有确认报告。点击右上角“确认并固化报告”，当前输入、分支和 SHA-256 结果会保存为不可变快照。</div>`;
    return;
  }
  el.innerHTML = storageBanner + state.reports.map((report) => {
    const reproduction = state.reproductions[report.auditChecksum ?? report.reportId];
    return `
      <article class="report-item">
        <div class="report-head">
          <div>
            <h3>${escapeHtml(report.title)}</h3>
            <p class="muted small">${escapeHtml(report.reportId ?? report.schema)} · 确认于 ${escapeHtml(new Date(report.confirmedAt).toLocaleString('zh-CN'))} · 分支 ${escapeHtml(report.branch?.name ?? '')}</p>
          </div>
          <div class="pill-row">
            ${report.verification?.matched ? '<span class="badge good">逐票一致</span>' : ''}
            ${report.verification?.matched === false ? '<span class="badge bad">对照差异</span>' : ''}
            ${report.result?.status === 'tie_pending' ? '<span class="badge warn">待裁决中间快照</span>' : '<span class="badge good">计数完成</span>'}
            <span class="badge info">${report.input?.ballots?.length ?? 0} 票快照</span>
          </div>
        </div>
        <p class="checksum">result SHA-256：${escapeHtml(report.resultChecksum)}</p>
        <p class="checksum">audit SHA-256：${escapeHtml(report.auditChecksum)}</p>
        ${reproduction ? `
          <p class="${reproduction.ok ? 'repro-ok' : 'repro-bad'}">
            ${reproduction.running ? '复现中…' : reproduction.ok ? '✅ 从快照独立重算，结果校验和一致' : '❌ 复现校验和不一致'}
          </p>
          ${!reproduction.running ? `<p class="checksum">actual：${escapeHtml(reproduction.actualChecksum)} · 逐票 ${reproduction.parityMatched ? '一致' : '不一致'}</p>` : ''}
        ` : ''}
        <div class="report-actions">
          <button class="btn small primary" data-action="reproduce-report" data-id="${escapeHtml(report.auditChecksum)}">从快照复现校验</button>
          <button class="btn small" data-action="export-report-json" data-id="${escapeHtml(report.auditChecksum)}">导出报告 JSON</button>
          <button class="btn small" data-action="export-report-md" data-id="${escapeHtml(report.auditChecksum)}">导出归档 MD</button>
          <button class="btn small" data-action="load-report-snapshot" data-id="${escapeHtml(report.auditChecksum)}">载入快照</button>
          <button class="btn small danger" data-action="delete-report" data-id="${escapeHtml(report.auditChecksum)}">删除本机记录</button>
        </div>
      </article>`;
  }).join('');
}

function renderAll() {
  renderIssues();
  renderBallotTable();
  renderGlobalStatus();
  renderSummary();
  renderImpact();
  renderBranchPanel();
  renderRounds();
  renderCandidateTrace();
  renderReports();
}

function findReport(id) {
  return state.reports.find((r) => r.auditChecksum === id);
}

async function handleAction(action, dataset, event) {
  switch (action) {
    case 'run':
      recompute();
      toast(state.result?.status === 'tie_pending' ? '计数完成：存在待裁决并列' : '已使用精确分数重新计数并完成逐票对照');
      break;

    case 'load-sample': {
      const sample = getSample($('#sampleSelect').value);
      state.draft = clone(sample.draft);
      state.branches = [baseBranch()];
      state.activeBranchId = 'base';
      state.impact = null;
      state.selectedCandidateId = null;
      syncFormFromState();
      recompute();
      toast(`已载入样例：${sample.name}`);
      break;
    }

    case 'load-sample-id': {
      const sample = getSample(dataset.id);
      $('#sampleSelect').value = sample.id;
      const btn = $('[data-action="load-sample"]');
      btn?.click();
      break;
    }

    case 'reset-draft': {
      const stored = loadWorkspace();
      if (stored?.draft && typeof stored.draft === 'object' && !Array.isArray(stored.draft)) {
        state.draft = { ...clone(DEFAULT_DRAFT), ...clone(stored.draft) };
        if (!state.draft.statusById || typeof state.draft.statusById !== 'object') state.draft.statusById = {};
        state.branches = normalizeBranches(stored.branches);
        state.activeBranchId = stored.activeBranchId ?? 'base';
        if (!state.branches.some((branch) => branch.id === state.activeBranchId)) state.activeBranchId = state.branches[0].id;
        state.impact = stored.impact ?? null;
        syncFormFromState();
        recompute();
        toast('已恢复本机自动保存的输入');
      } else {
        toast('没有已保存输入');
      }
      break;
    }

    case 'toggle-dispute': {
      const id = dataset.id;
      state.draft.statusById ??= {};
      const meta = state.draft.statusById[id] ?? { status: 'active', disputed: false, history: [] };
      meta.disputed = !meta.disputed;
      meta.updatedAt = new Date().toISOString();
      meta.history = [...(meta.history ?? []), { at: meta.updatedAt, type: meta.disputed ? 'flag-disputed' : 'clear-disputed' }];
      state.draft.statusById[id] = meta;
      recompute();
      break;
    }

    case 'rescind-ballot': {
      const id = dataset.id;
      if (!state.parsed?.ok) {
        toast('请先修复致命配置错误，再撤销选票；当前未修改选票状态');
        return;
      }
      const reasonText = window.prompt(`撤销 ${id} 的原因（留空也可；点击取消则中止）：`, '复核发现争议票');
      if (reasonText === null) return;
      syncDraftFromForm();
      const beforeParsed = parseWorkspaceDraft(state.draft);
      if (!beforeParsed.ok) {
        toast('配置仍有致命错误，已取消撤销且未修改选票状态');
        recompute();
        return;
      }
      const branch = getActiveBranch();
      const beforeResult = countElectionBatch(beforeParsed.input, branch.decisions ?? {});

      state.draft.statusById ??= {};
      const meta = state.draft.statusById[id] ?? { status: 'active', disputed: true, history: [] };
      const at = new Date().toISOString();
      meta.status = 'rescinded';
      meta.disputed = true;
      meta.rescindReason = reasonText;
      meta.updatedAt = at;
      meta.history = [...(meta.history ?? []), { at, type: 'rescind', reason: reasonText }];
      state.draft.statusById[id] = meta;

      const afterParsed = parseWorkspaceDraft(state.draft);
      const afterVerification = verifyWithInterpreter(afterParsed.input, branch.decisions ?? {}, { maxBallots: 100000 });
      const impact = findEarliestAffectedRound(beforeResult, afterVerification.batch);
      state.impact = {
        ballotId: id,
        action: 'rescind',
        at,
        reasonText,
        ...impact,
        beforeChecksum: beforeResult ? await checksumResult(beforeResult) : null,
        afterChecksum: await checksumResult(afterVerification.batch),
      };
      recompute();
      toast(impact.earliestRound != null ? `已撤销；最早影响第 ${impact.earliestRound} 轮` : '已撤销；未发现结果差异');
      break;
    }

    case 'restore-ballot': {
      const id = dataset.id;
      if (!state.parsed?.ok) {
        toast('请先修复致命配置错误，再恢复选票；当前未修改选票状态');
        return;
      }
      syncDraftFromForm();
      const beforeParsed = parseWorkspaceDraft(state.draft);
      if (!beforeParsed.ok) {
        toast('配置仍有致命错误，已取消恢复且未修改选票状态');
        recompute();
        return;
      }
      const branch = getActiveBranch();
      const beforeResult = countElectionBatch(beforeParsed.input, branch.decisions ?? {});
      const at = new Date().toISOString();
      const meta = state.draft.statusById[id] ?? { history: [] };
      meta.status = 'active';
      meta.updatedAt = at;
      meta.history = [...(meta.history ?? []), { at, type: 'restore' }];
      state.draft.statusById[id] = meta;
      const afterParsed = parseWorkspaceDraft(state.draft);
      const afterResult = countElectionBatch(afterParsed.input, branch.decisions ?? {});
      state.impact = { ballotId: id, action: 'restore', at, ...findEarliestAffectedRound(beforeResult, afterResult) };
      recompute();
      toast('选票已恢复并重算影响');
      break;
    }

    case 'select-branch': {
      if (event?.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      state.activeBranchId = dataset.id;
      recompute();
      break;
    }

    case 'delete-branch': {
      if (!window.confirm('删除该裁决分支？其他分支和已确认报告不会被删除。')) return;
      state.branches = state.branches.filter((b) => b.id !== dataset.id);
      if (state.activeBranchId === dataset.id) state.activeBranchId = 'base';
      recompute();
      toast('分支已删除；其他分支保持不变');
      break;
    }

    case 'branch-choice': {
      const parent = getActiveBranch();
      const key = dataset.key;
      const choice = dataset.choice;
      const id = uid('branch');
      const candidate = state.parsed.input.candidates.find((c) => c.id === choice);
      const branch = {
        id,
        name: `R${key.match(/^r(\d+)/)?.[1] ?? '?'} 裁决 · ${candidate?.name ?? choice}`,
        parentId: parent.id,
        decisions: { ...(parent.decisions ?? {}), [key]: choice },
        createdAt: new Date().toISOString(),
      };
      state.branches.push(branch);
      state.activeBranchId = id;
      recompute();
      switchTab('count');
      toast('已保存并切换到新分支；父分支和其他分支未被覆盖');
      break;
    }

    case 'branch-all': {
      const pendingTie = state.result?.pendingTie;
      if (!pendingTie || pendingTie.key !== dataset.key) return;
      const parent = getActiveBranch();
      const created = pendingTie.options.map((choice) => {
        const candidate = state.parsed.input.candidates.find((c) => c.id === choice);
        return {
          id: uid('branch'),
          name: `R${pendingTie.round} 裁决 · ${candidate?.name ?? choice}`,
          parentId: parent.id,
          decisions: { ...(parent.decisions ?? {}), [pendingTie.key]: choice },
          createdAt: new Date().toISOString(),
        };
      });
      state.branches.push(...created);
      persistWorkspace();
      renderBranchPanel();
      toast(`已保存 ${created.length} 个并列裁决分支，当前分支未被覆盖`);
      break;
    }

    case 'select-candidate': {
      if (!dataset.id) return;
      state.selectedCandidateId = dataset.id;
      renderCandidateTrace();
      switchTab('trace');
      break;
    }

    case 'confirm-report': {
      if (!state.parsed?.ok || !state.result) {
        toast('请先修复配置并完成计数');
        return;
      }
      if (state.verification?.matched === false || state.result.finalConservation?.balanced === false) {
        toast('逐票对照或守恒未通过，不能确认为可信报告');
        return;
      }
      if (state.result.status === 'tie_pending' && !window.confirm('当前仍有精确并列等待裁决。继续固化的是“待裁决中间快照”，不是完整当选报告；是否继续？')) {
        return;
      }
      const branch = getActiveBranch();
      const checksum = state.currentChecksum ?? await checksumResult(state.result);
      const markdown = markdownReport({
        parsed: state.parsed,
        branch,
        result: state.result,
        verification: state.verification,
        checksum,
        impact: state.impact,
        reportsCount: state.reports.length + 1,
      });
      const report = await buildConfirmedReport({
        draft: state.draft,
        parsed: state.parsed,
        branch,
        branches: state.branches,
        result: state.result,
        verification: state.verification,
        impact: state.impact,
        markdown,
      });
      report.reportId = `RPT-${state.reports.length + 1}-${Date.now().toString(36)}`;
      state.reports.unshift(report);
      const persisted = persistReports();
      renderReports();
      switchTab('reports');
      toast(persisted
        ? '旧报告已确认并固化；之后数据变化不会改写此快照'
        : '报告已在当前页面生成，但浏览器本机存储失败；请立即“导出报告 JSON”备份');
      break;
    }

    case 'export-audit': {
      if (!state.result) return toast('没有可导出的计数结果');
      const payload = await buildAuditExport({
        draft: state.draft,
        parsed: state.parsed,
        branch: getActiveBranch(),
        branches: state.branches,
        result: state.result,
        verification: state.verification,
        impact: state.impact,
      });
      downloadTextFile(`${safeFileName(state.draft.title)}-audit.json`, JSON.stringify(payload, null, 2), 'application/json');
      toast('完整审计 JSON 已导出');
      break;
    }

    case 'export-rounds-csv': {
      if (!state.result) return toast('没有可导出的结果');
      downloadTextFile(`${safeFileName(state.draft.title)}-rounds.csv`, `﻿${roundsCsv(state.result)}`, 'text/csv;charset=utf-8');
      break;
    }

    case 'export-flows-csv': {
      if (!state.result) return toast('没有可导出的结果');
      downloadTextFile(`${safeFileName(state.draft.title)}-flows-entries.csv`, `﻿${flowEntriesCsv(state.result, state.parsed.input)}`, 'text/csv;charset=utf-8');
      break;
    }

    case 'export-markdown': {
      if (!state.result) return toast('没有可导出的结果');
      const checksum = state.currentChecksum ?? await checksumResult(state.result);
      const md = markdownReport({ parsed: state.parsed, branch: getActiveBranch(), result: state.result, verification: state.verification, checksum, impact: state.impact, reportsCount: state.reports.length });
      downloadTextFile(`${safeFileName(state.draft.title)}-report.md`, md, 'text/markdown;charset=utf-8');
      break;
    }

    case 'reproduce-report': {
      const report = findReport(dataset.id);
      if (!report) return;
      state.reproductions[report.auditChecksum] = { running: true };
      renderReports();
      const reproduction = await reproduceReport(report);
      state.reproductions[report.auditChecksum] = reproduction;
      renderReports();
      toast(reproduction.ok ? '旧报告快照复现一致' : '复现校验失败');
      break;
    }

    case 'export-report-json': {
      const report = findReport(dataset.id);
      if (!report) return;
      downloadTextFile(`${safeFileName(report.title)}-confirmed-report.json`, JSON.stringify(report, null, 2), 'application/json');
      break;
    }

    case 'export-report-md': {
      const report = findReport(dataset.id);
      if (!report) return;
      if (report.markdown) downloadTextFile(`${safeFileName(report.title)}-confirmed-report.md`, report.markdown, 'text/markdown;charset=utf-8');
      else toast('该旧报告未保存 Markdown，请先复现后导出 JSON');
      break;
    }

    case 'load-report-snapshot': {
      const report = findReport(dataset.id);
      if (!report) return;
      if (!window.confirm('载入该旧报告快照将替换当前表单输入；当前工作区已自动保存。继续？')) return;
      state.draft = { ...clone(DEFAULT_DRAFT), ...clone(report.draft ?? {}), statusById: clone(report.input?.ballots ? Object.fromEntries(report.input.ballots.map((b) => [b.id, { status: b.status, disputed: b.disputed, rescindReason: b.rescindReason }])) : {}) };
      const branchId = uid('snapshot-branch');
      state.branches = [baseBranch(), { ...clone(report.branch), id: branchId, name: `快照 · ${report.branch?.name ?? '分支'}`, parentId: 'base' }];
      state.activeBranchId = branchId;
      state.impact = report.impactAtConfirmation ?? null;
      state.selectedCandidateId = null;
      syncFormFromState();
      recompute();
      switchTab('setup');
      toast('旧报告输入与决策已载入为新的快照分支');
      break;
    }

    case 'delete-report': {
      if (!window.confirm('只删除本机保存的报告快照？已导出的文件不受影响。')) return;
      state.reports = state.reports.filter((r) => r.auditChecksum !== dataset.id);
      const persisted = persistReports();
      renderReports();
      toast(persisted ? '本机报告记录已删除' : '删除状态未能写入本机存储；浏览器可能处于配额不足或禁用存储状态');
      break;
    }

    case 'run-all-parity': {
      recompute();
      const outcomes = [];
      for (const sample of SAMPLES) {
        const parsed = parseWorkspaceDraft(sample.draft);
        const verification = verifyWithInterpreter(parsed.input, {}, { maxBallots: 100000 });
        outcomes.push({ id: sample.id, name: sample.name, matched: verification.matched, differences: verification.differences });
        if (!verification.matched) console.error('sample parity mismatch', sample.id, verification.differences);
      }
      if (state.verification?.matched === false) {
        toast('当前工作台的批量计数与逐票解释器不一致，请查看控制台差异');
      } else {
        const failed = outcomes.filter((item) => item.matched === false);
        toast(failed.length
          ? `内置样例对照有 ${failed.length}/${outcomes.length} 个未通过，详情见控制台`
          : `当前结果与 ${outcomes.length} 个内置样例均通过逐票精确对照`);
      }
      break;
    }
    default:
      break;
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tabName));
  if (tabName === 'trace') renderCandidateTrace();
  if (tabName === 'reports') renderReports();
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    handleAction(actionEl.dataset.action, actionEl.dataset, event).catch((error) => {
      console.error(error);
      toast(`操作失败：${error.message}`);
    });
  });

  document.addEventListener('keydown', (event) => {
    const actionEl = event.target.closest?.('[data-action]');
    // Native buttons activate themselves; this handler is only for div/span branch rows.
    if (actionEl && actionEl.tagName !== 'BUTTON' && actionEl.tagName !== 'A' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      handleAction(actionEl.dataset.action, actionEl.dataset, event);
    }
  });

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  ['titleInput', 'seatsInput', 'ballotOrderInput', 'tiePolicyInput', 'duplicateInput', 'seedInput'].forEach((id) => {
    $(`#${id}`).addEventListener('change', () => {
      syncDraftFromForm();
      recompute();
    });
  });

  let textTimer = null;
  ['candidateText', 'ballotText'].forEach((id) => {
    $(`#${id}`).addEventListener('input', () => {
      syncDraftFromForm();
      clearTimeout(textTimer);
      textTimer = setTimeout(() => recompute(), 350);
      schedulePersist();
    });
  });

  $('#ballotSearch').addEventListener('input', (event) => {
    state.ballotSearch = event.target.value;
    renderBallotTable();
  });
  $('#traceBallotFilter').addEventListener('input', (event) => {
    state.traceFilter = event.target.value;
    renderCandidateTrace();
  });
  $('#sampleSelect').addEventListener('change', () => {
    $('#sampleDescription').textContent = getSample($('#sampleSelect').value)?.description ?? '';
  });

  $('#importReportInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      let report;
      if (json.schema === REPORT_SCHEMA) {
        report = json;
      } else if (json.schema === AUDIT_SCHEMA) {
        report = {
          ...json,
          reportId: `IMPORT-${Date.now().toString(36)}`,
          confirmedAt: json.exportedAt ?? new Date().toISOString(),
          auditChecksum: json.checksum?.auditSha256 ?? uid('import'),
          resultChecksum: json.checksum?.resultSha256,
        };
      } else {
        throw new Error('文件 schema 不是本系统的 confirmed report 或 audit export');
      }
      if (!report.input || !report.branch?.decisions || !report.resultChecksum) {
        throw new Error('导入文件缺少 input、branch.decisions 或 resultChecksum');
      }
      let storagePersisted = true;
      if (!state.reports.some((r) => r.auditChecksum === report.auditChecksum)) {
        state.reports.unshift(report);
        storagePersisted = persistReports();
      }
      switchTab('reports');
      state.reproductions[report.auditChecksum] = { running: true };
      renderReports();
      const reproduction = await reproduceReport(report);
      state.reproductions[report.auditChecksum] = reproduction;
      renderReports();
      if (!storagePersisted) toast('报告已导入并可复现，但本机存储失败；请保留原始 JSON 或重新导出备份');
      else toast(reproduction.ok ? '导入报告已从快照复现，校验和一致' : '导入报告复现失败：校验和不一致');
    } catch (error) {
      console.error(error);
      toast(`导入复现失败：${error.message}`);
    } finally {
      event.target.value = '';
    }
  });

  window.addEventListener('beforeunload', persistWorkspace);
}

syncFormFromState();
bindEvents();
recompute();
