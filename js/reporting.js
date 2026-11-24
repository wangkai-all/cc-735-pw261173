import { countElectionBatch } from './counter.js';
import { verifyWithInterpreter } from './compare.js';
import { sha256Hex } from './hash.js';
import { csvCell } from './format.js';
import { exactString } from './compare.js';

export const REPORT_SCHEMA = 'traceable-stv-confirmed-report-v1';
export const AUDIT_SCHEMA = 'traceable-stv-audit-export-v1';

export function serializeAuditValue(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export async function checksumResult(result) {
  return sha256Hex(serializeAuditValue(result));
}

function verificationSummary(verification) {
  if (!verification) return null;
  return {
    ran: verification.ran,
    matched: verification.matched ?? null,
    conservationOk: verification.conservationOk ?? null,
    reason: verification.reason ?? null,
    differenceCount: verification.differences?.length ?? 0,
    differences: verification.differences ?? [],
  };
}

export async function buildConfirmedReport({ draft, parsed, branch, branches, result, verification, impact, markdown }) {
  const resultPayload = serializeAuditValue(result);
  const resultChecksum = await sha256Hex(resultPayload);
  const now = new Date().toISOString();
  const base = {
    schema: REPORT_SCHEMA,
    confirmedAt: now,
    title: parsed.input.title,
    algorithmVersion: parsed.input.algorithmVersion,
    algorithmName: parsed.input.algorithmName,
    branch: {
      id: branch?.id ?? 'base',
      name: branch?.name ?? '基线',
      parentId: branch?.parentId ?? null,
      decisions: branch?.decisions ?? {},
    },
    allBranches: (branches ?? []).map((b) => ({ id: b.id, name: b.name, parentId: b.parentId, decisions: b.decisions })),
    impactAtConfirmation: impact ?? null,
    draft: serializeAuditValue(draft),
    input: serializeAuditValue(parsed.input),
    parseIssues: parsed.issues,
    stats: parsed.stats,
    markdown: markdown ?? null,
    verification: verificationSummary(verification),
    result: resultPayload,
    resultChecksum,
  };
  const auditChecksum = await sha256Hex({ ...base, auditChecksum: null });
  return { ...base, auditChecksum };
}

export async function buildAuditExport({ draft, parsed, branch, branches, result, verification, impact, reportChecksum }) {
  const resultChecksum = await checksumResult(result);
  const payload = {
    schema: AUDIT_SCHEMA,
    exportedAt: new Date().toISOString(),
    title: parsed.input.title,
    algorithm: {
      name: parsed.input.algorithmName,
      version: parsed.input.algorithmVersion,
      quota: 'Droop exact integer: floor(formalValue/(seats+1))+1',
      transfer: 'Weighted inclusive Gregory (WIG), exact BigInt fractions',
      tie: parsed.input.tiePolicy,
    },
    checksum: {
      resultSha256: resultChecksum,
      confirmedReportChecksum: reportChecksum ?? null,
    },
    branch,
    branches,
    impact,
    verification: verificationSummary(verification),
    issues: parsed.issues,
    stats: parsed.stats,
    input: serializeAuditValue(parsed.input),
    draft: serializeAuditValue(draft),
    result: serializeAuditValue(result),
  };
  payload.checksum.auditSha256 = await sha256Hex({ ...payload, checksum: { ...payload.checksum, auditSha256: null } });
  return payload;
}

export async function reproduceReport(report) {
  const input = report.input;
  const decisions = report.branch?.decisions ?? {};
  const result = countElectionBatch(input, decisions);
  const actualChecksum = await checksumResult(result);
  const verification = verifyWithInterpreter(input, decisions, { maxBallots: 100000 });
  return {
    ok: actualChecksum === report.resultChecksum,
    expectedChecksum: report.resultChecksum,
    actualChecksum,
    parityMatched: verification.matched,
    conservationOk: verification.conservationOk,
    result,
    verification,
  };
}

export function roundsCsv(result) {
  const nameById = new Map(result.candidates.map((c) => [c.id, c.name]));
  const rows = [
    ['round', 'round_kind', 'candidate_id', 'candidate_name', 'status_at_round_end', 'tally_start_exact', 'tally_end_exact', 'elected_this_round', 'eliminated_this_round', 'quota_exact', 'candidate_held', 'exhausted', 'total_counted', 'conservation_balanced', 'tie_key', 'tie_selected'],
  ];
  for (const round of result.rounds) {
    for (const id of result.candidateIds) {
      rows.push([
        round.index,
        round.kind,
        id,
        nameById.get(id) ?? id,
        round.statusById?.[id] ?? '',
        exactString(round.tallies?.[id]),
        exactString(round.postTallies?.[id] ?? round.tallies?.[id]),
        (round.electedThisRound ?? []).includes(id) ? 'yes' : '',
        (round.eliminatedThisRound ?? []).includes(id) ? 'yes' : '',
        exactString(round.quota ?? result.quota),
        exactString(round.conservation?.candidateHeld),
        exactString(round.conservation?.exhausted),
        exactString(round.conservation?.totalCounted ?? result.totalCounted),
        round.conservation?.balanced ? 'yes' : 'no',
        round.tie?.key ?? '',
        round.tie?.selectedId ?? '',
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function flowEntriesCsv(result, input) {
  const ballotById = new Map((input?.ballots ?? result.ballots ?? []).map((b) => [b.id, b]));
  const name = (id) => (!id ? 'EXHAUSTED' : result.candidates.find((c) => c.id === id)?.name ?? id);
  const rows = [[
    'round', 'flow_id', 'kind', 'from_id', 'from_name', 'to_id', 'to_name', 'ratio_exact', 'flow_amount_exact',
    'ballot_id', 'entry_amount_exact', 'raw_preferences', 'effective_preference_ids',
  ]];
  for (const flow of result.flows) {
    for (const entry of flow.entries ?? []) {
      const ballot = ballotById.get(entry.ballotId);
      rows.push([
        flow.round,
        flow.id,
        flow.kind,
        flow.fromCandidateId ?? '',
        name(flow.fromCandidateId),
        flow.toCandidateId ?? '',
        name(flow.toCandidateId),
        exactString(flow.ratio),
        exactString(flow.amount),
        entry.ballotId,
        exactString(entry.amount),
        ballot?.rawText ?? '',
        (ballot?.preferences ?? []).join('>'),
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function mdCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`).join('\n');
  return [head, separator, body].join('\n');
}

export function markdownReport({ parsed, branch, result, verification, checksum, impact, reportsCount }) {
  const name = (id) => parsed.input.candidates.find((c) => c.id === id)?.name ?? (id ? id : '耗尽票池');
  const lines = [];
  lines.push(`# ${parsed.input.title} — 可追查计数报告`);
  lines.push('');
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 算法：${parsed.input.algorithmName}（\`${parsed.input.algorithmVersion}\`）`);
  lines.push(`- 分支：${branch?.name ?? '基线'}${branch?.id ? `（\`${branch.id}\`）` : ''}`);
  lines.push(`- 席位：${parsed.input.seats}；Droop 精确配额：\`${result.quota.toString()}\``);
  lines.push(`- 计票选票：${result.totalCounted}；其中有效偏好：${result.formalValue}；无有效偏好：${result.counts.noValidBallots}`);
  lines.push(`- 当选：${result.electedIds.map(name).join('、') || '尚未完成'}`);
  lines.push(`- 淘汰：${result.eliminatedIds.map(name).join('、') || '无'}`);
  lines.push(`- 耗尽票值：\`${result.exhausted.toString()}\``);
  lines.push(`- 最终守恒：候选人名下 \`${result.finalConservation.candidateHeld.toString()}\` + 耗尽 \`${result.finalConservation.exhausted.toString()}\` = \`${result.finalConservation.heldPlusExhausted.toString()}\`，应等于计票票值 \`${result.finalConservation.totalCounted.toString()}\`；${result.finalConservation.balanced ? '✅ 平衡' : '❌ 不平衡'}`);
  if (result.finalConservation.rescindedValue && !result.finalConservation.rescindedValue.isZero()) {
    lines.push(`- 含撤销票的全量守恒：计票池 \`${result.finalConservation.heldPlusExhausted.toString()}\` + 撤销封存 \`${result.finalConservation.rescindedValue.toString()}\` = \`${result.finalConservation.fullSum.toString()}\`，应等于原票总数 \`${result.finalConservation.originalTotal.toString()}\`；${result.finalConservation.fullBalanced ? '✅ 平衡' : '❌ 不平衡'}`);
  }
  if (verification?.ran) {
    lines.push(`- 逐票解释器对照：${verification.matched ? '✅ 精确一致' : '❌ 发现差异'}；轮次守恒：${verification.conservationOk ? '✅' : '❌'}`);
  } else if (verification) {
    lines.push(`- 逐票解释器对照：未运行（${verification.reason ?? '规模超过阈值'}）`);
  }
  if (checksum) lines.push(`- 结果 SHA-256：\`${checksum}\``);
  if (impact?.earliestRound != null) lines.push(`- 最近一次撤票影响：最早阶段/第 ${impact.earliestRound} 轮发生变化（${impact.reason}）`);
  if (reportsCount != null) lines.push(`- 本机已确认旧报告：${reportsCount} 份，快照可独立复现`);
  lines.push('');

  lines.push('## 项目说明中的算法口径');
  lines.push('');
  lines.push('1. 每张纳入计数的原票初始票值为精确整数 `1`。');
  lines.push('2. 配额采用精确 Droop 公式 `floor(有效票数/(席位+1))+1`。');
  lines.push('3. 候选人票值是其名下全部票批/lot 的精确分数之和；并列比较使用 BigInt 交叉相乘，不使用浮点。');
  lines.push('4. 达到配额即当选；当选者余额 `V-Q` 按比例 `(V-Q)/V` 对其名下每个票批做加权包容 Gregory 转移，因此原票可能留下已当选人名下的保留分数，并在后续轮次继续乘上精确系数。');
  lines.push('5. 淘汰者全部票值按比例 `1` 转移；偏好中已当选、已淘汰或重复无效候选均跳过，之后没有继续候选时成为耗尽票。');
  lines.push('6. 每轮检查 `所有候选人名下票值 + 耗尽票值 = 纳入计数的原票总数`。');
  lines.push('7. 最低票精确并列会生成稳定 tie key；可按候选人顺序、种子哈希自动裁决，也可保存多个独立人工分支。');
  lines.push('');

  lines.push('## 逐轮结果');
  lines.push('');
  for (const round of result.rounds) {
    lines.push(`### 第 ${round.index} 轮：${round.title ?? round.kind}`);
    lines.push('');
    const rows = parsed.input.candidates.map((c) => [
      c.name,
      round.statusById?.[c.id] === 'elected' ? '当选' : round.statusById?.[c.id] === 'eliminated' ? '淘汰' : '继续',
      `\`${exactString(round.tallies[c.id])}\``,
      `\`${exactString(round.postTallies?.[c.id] ?? round.tallies[c.id])}\``,
    ]);
    lines.push(mdTable(['候选人', '状态', '轮初精确票值', '轮末精确票值'], rows));
    lines.push('');
    if (round.tie) {
      lines.push(`- 并列事件：\`${round.tie.key}\`；并列者：${round.tie.tiedIds.map(name).join('、')}；共同票值 \`${exactString(round.tie.tieValue)}\`；处置：${round.tie.resolution === 'pending' ? '等待分支裁决' : `${round.tie.resolvedBy} → ${name(round.tie.selectedId)}`}${round.resolution?.matchedDecisionKey ? `；轮次漂移后重放决策 \`${round.resolution.matchedDecisionKey}\`` : ''}`);
    }
    for (const batch of round.batches ?? []) {
      lines.push(`- 票批 \`${batch.id}\`：${name(batch.candidateId)}，比例 \`${exactString(batch.ratio)}\`，转移 \`${exactString(batch.amountTransferred)}\`，其中耗尽 \`${exactString(batch.amountExhausted)}\``);
    }
    if (round.conservation) {
      lines.push(`- 守恒：\`${exactString(round.conservation.candidateHeld)} + ${exactString(round.conservation.exhausted)} = ${exactString(round.conservation.heldPlusExhausted)}\` / 应等于 \`${exactString(round.conservation.totalCounted)}\`，${round.conservation.balanced ? '平衡' : '不平衡'}`);
    }
    lines.push('');
  }

  lines.push('## 流向与原票追溯');
  lines.push('');
  lines.push('完整逐笔原票金额见 `flows-entries.csv` 与审计 JSON。点击网页中的候选人可按时间查看使其票值增加或减少的原票。');
  lines.push('');
  return lines.join('\n');
}
