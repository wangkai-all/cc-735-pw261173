import { Fraction } from './fractions.js';
import { countElectionBatch } from './counter.js';
import { countElectionInterpreter } from './interpreter.js';
import { canonicalStringify } from './hash.js';

export function exactString(value) {
  if (value instanceof Fraction) return value.toString();
  if (value == null) return '0';
  if (typeof value === 'object') {
    if (typeof value.$f === 'string') return value.$f;
    if ('n' in value && 'd' in value) return new Fraction(BigInt(value.n), BigInt(value.d)).toString();
  }
  return new Fraction(value).toString();
}

function tallySignature(tallies) {
  return Object.fromEntries(Object.entries(tallies ?? {}).map(([id, value]) => [id, exactString(value)]).sort(([a], [b]) => a.localeCompare(b)));
}

function flowSignature(flow) {
  const entries = (flow.entries ?? [])
    .map((entry) => [entry.ballotId, exactString(entry.amount)])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return {
    round: flow.round,
    kind: flow.kind,
    from: flow.fromCandidateId ?? null,
    to: flow.toCandidateId ?? null,
    exhausted: Boolean(flow.exhausted),
    ratio: exactString(flow.ratio),
    amount: exactString(flow.amount),
    entries,
  };
}

export function resultSemanticSignature(result) {
  return {
    engineStatus: result.status,
    quota: exactString(result.quota),
    formalValue: result.formalValue,
    totalCounted: result.totalCounted,
    electedIds: [...(result.electedIds ?? [])],
    eliminatedIds: [...(result.eliminatedIds ?? [])],
    exhausted: exactString(result.exhausted),
    finalTallies: tallySignature(result.finalTallies),
    rounds: (result.rounds ?? []).map((round) => ({
      index: round.index,
      kind: round.kind,
      electedThisRound: [...(round.electedThisRound ?? [])],
      eliminatedThisRound: [...(round.eliminatedThisRound ?? [])],
      tallies: tallySignature(round.tallies),
      postTallies: round.postTallies ? tallySignature(round.postTallies) : null,
      tieKey: round.tie?.key ?? null,
      tieStatus: round.tie?.resolution ?? null,
      tieSelected: round.tie?.selectedId ?? round.resolution?.selectedId ?? null,
      balanced: round.conservation?.balanced ?? null,
      candidateHeld: round.conservation ? exactString(round.conservation.candidateHeld) : null,
      exhaustedValue: round.conservation ? exactString(round.conservation.exhausted) : null,
    })),
    flows: (result.flows ?? []).map(flowSignature).sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b))),
  };
}

function diffValues(a, b, path = '$', differences = []) {
  if (differences.length >= 30) return differences;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (String(a) !== String(b)) differences.push({ path, a: String(a), b: String(b) });
    return differences;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) differences.push({ path, a, b });
    return differences;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      differences.push({ path: `${path}.length`, a: Array.isArray(a) ? a.length : typeof a, b: Array.isArray(b) ? b.length : typeof b });
      return differences;
    }
    for (let i = 0; i < a.length; i += 1) diffValues(a[i], b[i], `${path}[${i}]`, differences);
    return differences;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!(key in a)) differences.push({ path: `${path}.${key}`, a: undefined, b: b[key] });
    else if (!(key in b)) differences.push({ path: `${path}.${key}`, a: a[key], b: undefined });
    else diffValues(a[key], b[key], `${path}.${key}`, differences);
  }
  return differences;
}

export function compareResults(batchResult, interpreterResult) {
  const a = resultSemanticSignature(batchResult);
  const b = resultSemanticSignature(interpreterResult);
  const differences = diffValues(a, b);
  return { matched: differences.length === 0, differences, batchSignature: a, interpreterSignature: b };
}

export function verifyWithInterpreter(input, decisions = {}, options = {}) {
  const maxBallots = options.maxBallots ?? 240;
  const batch = countElectionBatch(input, decisions);
  const activeCount = input.ballots.filter((b) => b.status !== 'rescinded').length;
  if (activeCount > maxBallots) {
    return { ran: false, matched: null, reason: `active ballot count ${activeCount} > ${maxBallots}`, batch, interpreter: null, differences: [] };
  }
  const interpreter = countElectionInterpreter(input, decisions);
  const comparison = compareResults(batch, interpreter);
  const conservationOk = batch.rounds.every((r) => r.conservation?.balanced !== false) && batch.finalConservation?.balanced;
  return { ran: true, ...comparison, conservationOk, batch, interpreter };
}

export function roundFingerprint(round) {
  if (!round) return null;
  return canonicalStringify({
    index: round.index,
    kind: round.kind,
    electedThisRound: round.electedThisRound,
    eliminatedThisRound: round.eliminatedThisRound,
    tallies: tallySignature(round.tallies),
    postTallies: round.postTallies ? tallySignature(round.postTallies) : null,
    tieKey: round.tie?.key ?? null,
    tieSelected: round.tie?.selectedId ?? null,
    flows: (round.flowIds ?? []),
  });
}

/**
 * Find first exact stage/round changed between two counts on related inputs.
 * Stage 0 captures quota/formal electorate changes before the first count.
 */
export function findEarliestAffectedRound(oldResult, newResult) {
  const setupChanges = [];
  for (const key of ['quota', 'formalValue', 'totalCounted', 'status']) {
    const rawA = oldResult?.[key];
    const rawB = newResult?.[key];
    const a = key === 'status' ? String(rawA ?? '') : exactString(rawA);
    const b = key === 'status' ? String(rawB ?? '') : exactString(rawB);
    if (a !== b) setupChanges.push({ key, before: a, after: b });
  }

  const maxRounds = Math.max(oldResult?.rounds?.length ?? 0, newResult?.rounds?.length ?? 0);
  for (let i = 0; i < maxRounds; i += 1) {
    const oldRound = oldResult?.rounds?.[i];
    const newRound = newResult?.rounds?.[i];
    if (!oldRound || !newRound) {
      return {
        earliestRound: i + 1,
        stage: 'round',
        reason: !oldRound ? `新结果多出第 ${i + 1} 轮` : `旧结果多出第 ${i + 1} 轮`,
        setupChanges,
      };
    }

    // Compare semantic tallies rather than generated flow IDs.
    const oldSig = resultSemanticSignature({ rounds: [oldRound], flows: oldResult.flows?.filter((f) => f.round === oldRound.index) });
    const newSig = resultSemanticSignature({ rounds: [newRound], flows: newResult.flows?.filter((f) => f.round === newRound.index) });
    const differences = diffValues(oldSig, newSig).filter((d) => !d.path.includes('engineStatus') && !d.path.includes('quota') && !d.path.includes('formalValue') && !d.path.includes('totalCounted'));
    if (differences.length > 0) {
      return { earliestRound: oldRound.index, stage: 'round', reason: `第 ${oldRound.index} 轮精确票型/流向首次不同`, differences: differences.slice(0, 12), setupChanges };
    }
  }

  if (setupChanges.length > 0) {
    return { earliestRound: 0, stage: 'setup', reason: '配额或计票选票总数在初始阶段已变化', setupChanges };
  }
  return { earliestRound: null, stage: 'none', reason: '两轮计数没有可观察差异', setupChanges };
}
