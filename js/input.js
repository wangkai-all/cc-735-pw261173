import { fnv1a } from './hash.js';

export const ALGORITHM_VERSION = 'wig-stv-exact-v1';
export const ALGORITHM_NAME = '精确分数加权包容 Gregory 可转移票算法';

export const DEFAULT_DRAFT = Object.freeze({
  title: '虚构排序选票计数实验室',
  seats: 2,
  candidateText: '',
  ballotText: '',
  duplicatePreference: 'first', // first | invalid-ballot
  tiePolicy: 'manual', // manual | candidate-order | seeded
  tieSeed: 'audit-seed-2026',
  ballotOrder: 'input', // input | id | reverse | seeded
  orderSeed: 'ballot-order',
  statusById: {},
});

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function splitPreferences(text) {
  return String(text ?? '')
    .split(/\s*(?:>|→|⟩|,|，|、|;|；|\||\t|\n)\s*/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseCandidateLines(candidateText) {
  const lines = String(candidateText ?? '').split(/\r?\n/);
  const candidates = [];
  const issues = [];
  const seenNames = new Map();
  const seenIds = new Set();

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    let id;
    let name;
    const idNameMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,31})\s*[|=:：]\s*(.+)$/);
    if (idNameMatch) {
      id = idNameMatch[1];
      name = idNameMatch[2].trim();
    } else {
      name = line;
      id = `c${candidates.length + 1}`;
    }

    if (!name) {
      issues.push({ severity: 'error', code: 'empty_candidate', message: `第 ${lineNo} 行候选人为空` });
      return;
    }
    if (seenNames.has(name)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_candidate_name',
        message: `候选人名称“${name}”重复（第 ${lineNo} 行与第 ${seenNames.get(name)} 行）`,
      });
    }
    if (seenIds.has(id)) {
      issues.push({ severity: 'error', code: 'duplicate_candidate_id', message: `候选人 ID “${id}”重复` });
    }
    seenNames.set(name, lineNo);
    seenIds.add(id);
    candidates.push({ id, name, lineNo });
  });

  if (candidates.length === 0) {
    issues.push({ severity: 'error', code: 'no_candidates', message: '至少需要一名候选人' });
  }
  return { candidates, issues };
}

export function parseWorkspaceDraft(draft = {}) {
  const merged = { ...DEFAULT_DRAFT, ...draft };
  const { candidates, issues: candidateIssues } = parseCandidateLines(merged.candidateText);
  const issues = [...candidateIssues];

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const byName = new Map(candidates.map((c) => [c.name.toLowerCase(), c]));
  const resolveCandidate = (ref) => {
    const token = String(ref).trim();
    return byId.get(token) ?? byName.get(token.toLowerCase()) ?? null;
  };

  const lines = String(merged.ballotText ?? '').split(/\r?\n/);
  const ballots = [];
  const usedBallotIds = new Set();
  let autoNumber = 0;

  lines.forEach((rawLine, lineIndex) => {
    const lineNo = lineIndex + 1;
    const rawLineTrimmed = rawLine.trim();
    if (!rawLineTrimmed || rawLineTrimmed.startsWith('#')) return;

    let statedId = null;
    let preferenceText = rawLineTrimmed;
    const idMatch = rawLineTrimmed.match(/^([^:：]{1,40})\s*[:：]\s*(.*)$/);
    if (idMatch && /^[A-Za-z0-9_\-一-龥][A-Za-z0-9_\-一-龥]{0,39}$/.test(idMatch[1].trim())) {
      statedId = idMatch[1].trim();
      preferenceText = idMatch[2] ?? '';
    }

    autoNumber += 1;
    let id = statedId ?? `B${String(autoNumber).padStart(3, '0')}`;
    if (usedBallotIds.has(id)) {
      let suffix = 2;
      const original = id;
      while (usedBallotIds.has(`${original}-${suffix}`)) suffix += 1;
      issues.push({ severity: 'warning', code: 'duplicate_ballot_id', message: `选票编号 ${original} 重复，已改为 ${original}-${suffix}` });
      id = `${original}-${suffix}`;
    }
    usedBallotIds.add(id);

    const rawPreferences = splitPreferences(preferenceText).filter((token) => token !== '.' && token !== '（空白）' && token !== '(空白)' && token !== 'EMPTY');
    const preferences = [];
    const knownSeen = new Set();
    const duplicateRefs = [];
    const unknownRefs = [];

    for (const ref of rawPreferences) {
      const candidate = resolveCandidate(ref);
      if (!candidate) {
        unknownRefs.push(ref);
        continue;
      }
      if (knownSeen.has(candidate.id)) {
        duplicateRefs.push(candidate.id);
        continue;
      }
      knownSeen.add(candidate.id);
      preferences.push(candidate.id);
    }

    let effectivePreferences = preferences;
    let duplicateInvalidated = false;
    if (merged.duplicatePreference === 'invalid-ballot' && duplicateRefs.length > 0) {
      effectivePreferences = [];
      duplicateInvalidated = true;
      issues.push({ severity: 'warning', code: 'duplicate_invalid_ballot', ballotId: id, message: `${id} 含重复候选，按配置整张票无有效偏好` });
    } else if (duplicateRefs.length > 0) {
      issues.push({ severity: 'info', code: 'duplicate_ignored', ballotId: id, message: `${id} 的重复候选只保留首次出现` });
    }
    if (unknownRefs.length > 0) {
      issues.push({ severity: 'warning', code: 'unknown_preference', ballotId: id, message: `${id} 有无法识别的候选：${unknownRefs.join('、')}` });
    }

    const meta = merged.statusById?.[id] ?? {};
    const status = meta.status === 'rescinded' ? 'rescinded' : 'active';
    ballots.push({
      id,
      row: ballots.length + 1,
      lineNo,
      rawText: rawLineTrimmed,
      statedId: Boolean(statedId),
      rawPreferences,
      preferences: effectivePreferences,
      normalizedPreferences: preferences,
      duplicateRefs,
      unknownRefs,
      duplicateInvalidated,
      valid: effectivePreferences.length > 0,
      status,
      disputed: Boolean(meta.disputed),
      disputeReason: meta.disputeReason ?? '',
      rescindReason: meta.rescindReason ?? '',
      statusUpdatedAt: meta.updatedAt ?? null,
    });
  });

  if (ballots.length === 0) {
    issues.push({ severity: 'error', code: 'no_ballots', message: '至少需要一张选票；空票可写成 B001:' });
  }

  const seats = Number(merged.seats);
  if (!Number.isInteger(seats) || seats < 1) {
    issues.push({ severity: 'error', code: 'bad_seats', message: '席位必须是大于 0 的整数' });
  } else if (candidates.length > 0 && seats >= candidates.length) {
    issues.push({ severity: 'error', code: 'too_many_seats', message: '为体现淘汰与转移，席位应少于候选人数' });
  }

  const fatal = issues.some((issue) => issue.severity === 'error');
  const input = {
    schemaVersion: 'traceable-stv-input-v1',
    algorithmVersion: ALGORITHM_VERSION,
    algorithmName: ALGORITHM_NAME,
    title: merged.title || '未命名虚构选举',
    seats,
    candidates,
    ballots,
    duplicatePreference: merged.duplicatePreference,
    tiePolicy: merged.tiePolicy,
    tieSeed: merged.tieSeed || 'traceable-stv',
    tieBreakOrder: candidates.map((c) => c.id),
    ballotOrder: merged.ballotOrder,
    orderSeed: merged.orderSeed || 'ballots',
    createdAt: merged.createdAt ?? null,
  };

  return {
    ok: !fatal,
    fatal,
    issues,
    input,
    stats: {
      ballotCount: ballots.length,
      activeCount: ballots.filter((b) => b.status === 'active').length,
      rescindedCount: ballots.filter((b) => b.status === 'rescinded').length,
      validCount: ballots.filter((b) => b.status === 'active' && b.valid).length,
      noValidCount: ballots.filter((b) => b.status === 'active' && !b.valid).length,
      candidateCount: candidates.length,
    },
  };
}

export function orderedBallotIds(input) {
  const active = input.ballots.filter((b) => b.status !== 'rescinded');
  let sorted;
  switch (input.ballotOrder) {
    case 'id':
      sorted = [...active].sort((a, b) => naturalCompare(a.id, b.id) || a.row - b.row);
      break;
    case 'reverse':
      sorted = [...active].sort((a, b) => b.row - a.row);
      break;
    case 'seeded': {
      sorted = [...active].sort((a, b) => {
        const ha = fnv1a(`${input.orderSeed}:${a.id}`);
        const hb = fnv1a(`${input.orderSeed}:${b.id}`);
        return ha < hb ? -1 : ha > hb ? 1 : a.row - b.row;
      });
      break;
    }
    case 'input':
    default:
      sorted = [...active].sort((a, b) => a.row - b.row);
  }
  return sorted.map((b) => b.id);
}

export function orderedBallots(input) {
  const byId = new Map(input.ballots.map((b) => [b.id, b]));
  return orderedBallotIds(input).map((id) => byId.get(id));
}
