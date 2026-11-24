import { Fraction, sumFractions } from './fractions.js';
import { orderedBallots } from './input.js';
import { makeTieKey, resolveTieEvent } from './tie.js';

const EXHAUSTED = null;

function candidateMap(input) {
  return new Map(input.candidates.map((c) => [c.id, c]));
}

function emptyTallies(input) {
  return Object.fromEntries(input.candidates.map((c) => [c.id, Fraction.zero()]));
}

function computeTalliesFromLots(lots, input) {
  const tallies = emptyTallies(input);
  for (const lot of lots) {
    if (lot.exhausted || !lot.candidateId || lot.value.isZero()) continue;
    tallies[lot.candidateId] = tallies[lot.candidateId].add(lot.value);
  }
  return tallies;
}

function nextContinuingPreference(ballot, sourceCandidateId, statusById) {
  const startIndex = ballot.preferences.indexOf(sourceCandidateId);
  if (startIndex < 0) return null;
  for (let i = startIndex + 1; i < ballot.preferences.length; i += 1) {
    const id = ballot.preferences[i];
    if (statusById.get(id) === 'continuing') return id;
  }
  return EXHAUSTED;
}

function conservationSnapshot(tallies, exhausted, totalCounted, rescindedCount = 0) {
  const candidateHeld = sumFractions(Object.values(tallies));
  const exhaustedValue = Fraction.from(exhausted);
  const total = Fraction.from(totalCounted);
  const rescindedValue = Fraction.from(rescindedCount);
  const heldPlusExhausted = candidateHeld.add(exhaustedValue);
  const originalTotal = total.add(rescindedValue);
  const fullSum = heldPlusExhausted.add(rescindedValue);
  return {
    totalCounted: total,
    candidateHeld,
    exhausted: exhaustedValue,
    heldPlusExhausted,
    balanced: heldPlusExhausted.eq(total),
    discrepancy: heldPlusExhausted.sub(total),
    rescindedValue,
    originalTotal,
    fullSum,
    fullBalanced: fullSum.eq(originalTotal),
  };
}

/**
 * Batch/lot implementation of the exact WIG-STV count.
 * It keeps transfer lots and grouped target flows for audit tracing.
 */
export function countElectionBatch(input, decisions = {}) {
  if (!input?.candidates?.length) throw new Error('没有候选人，无法计数');
  if (!Array.isArray(input.ballots)) throw new Error('选票数据无效');

  const candidatesById = candidateMap(input);
  const activeBallots = orderedBallots(input).filter((b) => b.status !== 'rescinded');
  const ballotById = new Map(input.ballots.map((b) => [b.id, b]));
  const formalBallots = activeBallots.filter((b) => b.valid);
  const totalCounted = activeBallots.length;
  const rescindedCount = input.ballots.length - activeBallots.length;
  const formalValue = formalBallots.length;

  // Droop quota as an exact integer: floor(V/(S+1)) + 1.
  const quota = new Fraction(Math.floor(formalValue / (input.seats + 1)) + 1, 1);

  const statusById = new Map(input.candidates.map((c) => [c.id, 'continuing']));
  const electedIds = [];
  const eliminatedIds = [];
  const lots = [];
  const flows = [];
  const rounds = [];
  let exhausted = Fraction.zero();
  let lotSequence = 0;
  let flowSequence = 0;

  const newLotId = (ballotId) => `lot-${ballotId}-${(lotSequence += 1)}`;
  const newFlowId = (round) => `r${round}-flow-${(flowSequence += 1)}`;

  function addFlow({ round, kind, fromCandidateId, toCandidateId, ratio, entries, sourceBatchId }) {
    const amount = sumFractions(entries.map((e) => e.amount));
    const flow = {
      id: newFlowId(round),
      round,
      kind,
      sourceBatchId: sourceBatchId ?? null,
      fromCandidateId: fromCandidateId ?? null,
      toCandidateId: toCandidateId ?? null,
      exhausted: toCandidateId === EXHAUSTED,
      ratio: Fraction.from(ratio ?? Fraction.one()),
      amount,
      entryCount: entries.length,
      entries: entries.map((entry) => ({ ...entry, amount: Fraction.from(entry.amount) })),
    };
    flows.push(flow);
    return flow;
  }

  // Initial preference distribution. Empty/no-valid ballots become exhausted.
  const initialGroups = new Map();
  for (const ballot of activeBallots) {
    const target = ballot.preferences[0] ?? EXHAUSTED;
    const key = target ?? 'EXHAUSTED';
    if (!initialGroups.has(key)) initialGroups.set(key, []);
    const lotId = target ? newLotId(ballot.id) : null;
    initialGroups.get(key).push({
      ballotId: ballot.id,
      sourceLotId: null,
      childLotId: lotId,
      amount: Fraction.one(),
      targetCandidateId: target,
    });
    if (target) {
      lots.push({ id: lotId, ballotId: ballot.id, candidateId: target, value: Fraction.one(), parentLotId: null, depth: 0, exhausted: false });
    }
  }

  const initialBatch = {
    id: 'batch-initial',
    round: 1,
    type: 'initial-distribution',
    candidateId: null,
    totalVotes: new Fraction(activeBallots.length),
    quota: null,
    surplus: null,
    ratio: Fraction.one(),
    flowIds: [],
    amountTransferred: Fraction.zero(),
    amountExhausted: Fraction.zero(),
  };

  for (const [key, entries] of initialGroups) {
    const target = key === 'EXHAUSTED' ? EXHAUSTED : key;
    const flow = addFlow({ round: 1, kind: 'initial', fromCandidateId: null, toCandidateId: target, ratio: Fraction.one(), entries, sourceBatchId: initialBatch.id });
    initialBatch.flowIds.push(flow.id);
    if (target === EXHAUSTED) exhausted = exhausted.add(flow.amount);
  }
  initialBatch.amountExhausted = flows.filter((f) => f.kind === 'initial' && f.exhausted).reduce((a, f) => a.add(f.amount), Fraction.zero());

  function transferFromCandidate({ round, candidateId, kind, ratio, batchId, totalVotes, surplus }) {
    const sourceLots = lots.filter((lot) => !lot.exhausted && lot.candidateId === candidateId && !lot.value.isZero());
    const groups = new Map();
    let transferredTotal = Fraction.zero();
    let exhaustedThisAction = Fraction.zero();

    for (const sourceLot of sourceLots) {
      const sourceValueBefore = sourceLot.value;
      const amount = ratio.eq(Fraction.one()) ? sourceValueBefore : sourceValueBefore.mul(ratio);
      if (amount.isZero()) continue;

      sourceLot.value = sourceLot.value.sub(amount);
      const ballot = ballotById.get(sourceLot.ballotId);
      const target = nextContinuingPreference(ballot, candidateId, statusById);
      const key = target ?? 'EXHAUSTED';
      const childLotId = newLotId(sourceLot.ballotId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        ballotId: sourceLot.ballotId,
        sourceLotId: sourceLot.id,
        childLotId,
        sourceValueBefore,
        amount,
        retainedAmount: sourceLot.value,
        targetCandidateId: target,
      });
      transferredTotal = transferredTotal.add(amount);

      if (target) {
        lots.push({
          id: childLotId,
          ballotId: sourceLot.ballotId,
          candidateId: target,
          value: amount,
          parentLotId: sourceLot.id,
          depth: sourceLot.depth + 1,
          exhausted: false,
        });
      }
    }

    const flowIds = [];
    for (const [key, entries] of groups) {
      const target = key === 'EXHAUSTED' ? EXHAUSTED : key;
      const flow = addFlow({ round, kind, fromCandidateId: candidateId, toCandidateId: target, ratio, entries, sourceBatchId: batchId });
      flowIds.push(flow.id);
      if (target === EXHAUSTED) {
        exhausted = exhausted.add(flow.amount);
        exhaustedThisAction = exhaustedThisAction.add(flow.amount);
        for (const entry of entries) {
          lots.push({
            id: `exhaust-${entry.childLotId}`,
            ballotId: entry.ballotId,
            candidateId: null,
            value: entry.amount,
            parentLotId: entry.sourceLotId,
            depth: 999,
            exhausted: true,
          });
        }
      }
    }

    const batch = {
      id: batchId,
      round,
      type: kind === 'surplus' ? 'surplus-transfer' : 'elimination-transfer',
      candidateId,
      totalVotes: Fraction.from(totalVotes),
      quota: quota ? Fraction.from(quota) : null,
      surplus: surplus === undefined || surplus === null ? null : Fraction.from(surplus),
      ratio: Fraction.from(ratio),
      flowIds,
      amountTransferred: transferredTotal,
      amountExhausted: exhaustedThisAction,
    };
    return batch;
  }

  let status = 'running';
  let pendingTie = null;
  let guard = 0;

  while (status === 'running' && guard < 1000) {
    guard += 1;
    const roundIndex = rounds.length + 1;
    const tallies = computeTalliesFromLots(lots, input);
    const conservationBefore = conservationSnapshot(tallies, exhausted, totalCounted, rescindedCount);
    const continuingIds = input.candidates.map((c) => c.id).filter((id) => statusById.get(id) === 'continuing');
    const remainingSeats = input.seats - electedIds.length;

    const round = {
      index: roundIndex,
      kind: null,
      title: '',
      tallies,
      postTallies: null,
      quota,
      statusById: Object.fromEntries(statusById),
      continuingIds,
      remainingSeats,
      electedThisRound: [],
      eliminatedThisRound: [],
      tie: null,
      resolution: null,
      batches: [],
      flowIds: [],
      conservationBefore,
      conservation: null,
      processingOrder: roundIndex === 1 ? orderedBallots(input).map((b) => b.id) : undefined,
    };

    if (!conservationBefore.balanced) {
      throw new Error(`第 ${roundIndex} 轮动作前票值不守恒：差异 ${conservationBefore.discrepancy.toString()}`);
    }

    // Previously elected candidates can receive later transfers; clear their exact surplus first.
    const standingSurplusIds = electedIds.filter((id) => tallies[id].gt(quota));
    if (standingSurplusIds.length > 0) {
      round.kind = 'surplus-transfer';
      round.title = `转移已当选候选人后来新增的余额：${standingSurplusIds.map((id) => candidatesById.get(id).name).join('、')}`;
      for (const id of standingSurplusIds) {
        const totalVotes = tallies[id];
        const surplus = totalVotes.sub(quota);
        const ratio = surplus.div(totalVotes);
        const batchId = `r${roundIndex}-surplus-${id}`;
        const batch = transferFromCandidate({ round: roundIndex, candidateId: id, kind: 'surplus', ratio, batchId, totalVotes, surplus });
        round.batches.push(batch);
        round.flowIds.push(...batch.flowIds);
      }
      round.postTallies = computeTalliesFromLots(lots, input);
      round.conservation = conservationSnapshot(round.postTallies, exhausted, totalCounted, rescindedCount);
      if (!round.conservation.balanced) throw new Error(`第 ${roundIndex} 轮余额转移后不守恒`);
      rounds.push(round);
      continue;
    }

    // If remaining continuing candidates exactly fill remaining seats, elect all.
    if (continuingIds.length <= remainingSeats) {
      round.kind = 'acclamation';
      round.title = '继续候选人数不超过剩余席位，全体当选';
      for (const id of continuingIds) {
        statusById.set(id, 'elected');
        electedIds.push(id);
        round.electedThisRound.push(id);
      }
      status = 'complete';
      round.postTallies = computeTalliesFromLots(lots, input);
      round.statusById = Object.fromEntries(statusById);
      round.conservation = conservationSnapshot(round.postTallies, exhausted, totalCounted, rescindedCount);
      rounds.push(round);
      break;
    }

    const qualifiers = continuingIds.filter((id) => tallies[id].gte(quota));
    if (qualifiers.length > 0) {
      round.kind = 'election';
      round.title = `${qualifiers.map((id) => candidatesById.get(id).name).join('、')} 达到精确 Droop 配额并当选`;
      for (const id of qualifiers) {
        statusById.set(id, 'elected');
        electedIds.push(id);
        round.electedThisRound.push(id);
      }
      round.statusById = Object.fromEntries(statusById);

      // Simultaneous election: ratios are based on this round's pre-transfer tallies.
      for (const id of qualifiers) {
        const totalVotes = tallies[id];
        const surplus = totalVotes.sub(quota);
        if (surplus.isZero()) {
          round.batches.push({
            id: `r${roundIndex}-surplus-${id}`,
            round: roundIndex,
            type: 'surplus-transfer',
            candidateId: id,
            totalVotes,
            quota,
            surplus: Fraction.zero(),
            ratio: Fraction.zero(),
            flowIds: [],
            amountTransferred: Fraction.zero(),
            amountExhausted: Fraction.zero(),
          });
          continue;
        }
        const ratio = surplus.div(totalVotes);
        const batchId = `r${roundIndex}-surplus-${id}`;
        const batch = transferFromCandidate({ round: roundIndex, candidateId: id, kind: 'surplus', ratio, batchId, totalVotes, surplus });
        round.batches.push(batch);
        round.flowIds.push(...batch.flowIds);
      }

      if (electedIds.length >= input.seats) status = 'complete';
      round.postTallies = computeTalliesFromLots(lots, input);
      round.conservation = conservationSnapshot(round.postTallies, exhausted, totalCounted, rescindedCount);
      if (!round.conservation.balanced) throw new Error(`第 ${roundIndex} 轮当选/余额转移后不守恒`);
      rounds.push(round);
      if (status === 'complete') break;
      continue;
    }

    // No candidate reached quota: eliminate an exact minimum-vote candidate.
    const minValue = continuingIds.reduce((min, id) => (tallies[id].lt(min) ? tallies[id] : min), tallies[continuingIds[0]]);
    const tiedIds = continuingIds.filter((id) => tallies[id].eq(minValue));
    const tie = {
      key: makeTieKey({ round: roundIndex, kind: 'elimination-minimum', tiedIds, tallies, statusById }),
      round: roundIndex,
      kind: 'elimination-minimum',
      kindLabel: '最低票淘汰并列',
      tiedIds,
      tieValue: minValue,
      chooseCount: 1,
      options: tiedIds,
    };
    const resolution = resolveTieEvent(tie, input, decisions);
    tie.resolution = resolution.status;
    tie.resolvedBy = resolution.resolvedBy;
    tie.selectedId = resolution.selectedId;
    round.tie = tie;
    round.resolution = resolution;

    if (resolution.status === 'pending') {
      round.kind = 'tie-pending';
      round.title = `第 ${roundIndex} 轮最低票精确并列，等待保存裁决分支`;
      round.postTallies = tallies;
      round.conservation = conservationBefore;
      pendingTie = tie;
      status = 'tie_pending';
      rounds.push(round);
      break;
    }

    const eliminatedId = resolution.selectedId;
    statusById.set(eliminatedId, 'eliminated');
    eliminatedIds.push(eliminatedId);
    round.kind = 'elimination';
    round.title = `淘汰 ${candidatesById.get(eliminatedId).name}，全部票值按精确分数转移`;
    round.eliminatedThisRound = [eliminatedId];
    round.statusById = Object.fromEntries(statusById);

    const batchId = `r${roundIndex}-elimination-${eliminatedId}`;
    const batch = transferFromCandidate({
      round: roundIndex,
      candidateId: eliminatedId,
      kind: 'elimination',
      ratio: Fraction.one(),
      batchId,
      totalVotes: tallies[eliminatedId],
      surplus: null,
    });
    round.batches.push(batch);
    round.flowIds.push(...batch.flowIds);
    round.postTallies = computeTalliesFromLots(lots, input);
    round.conservation = conservationSnapshot(round.postTallies, exhausted, totalCounted, rescindedCount);
    if (!round.conservation.balanced) throw new Error(`第 ${roundIndex} 轮淘汰转移后不守恒`);
    rounds.push(round);
  }

  if (guard >= 1000) throw new Error('计数轮次超过安全上限');

  const finalTallies = computeTalliesFromLots(lots, input);
  const finalConservation = conservationSnapshot(finalTallies, exhausted, totalCounted, rescindedCount);

  return {
    engine: 'batch-lot-exact-v1',
    algorithmVersion: input.algorithmVersion,
    status,
    pendingTie,
    title: input.title,
    seats: input.seats,
    quota,
    formalValue,
    totalCounted,
    counts: {
      ballots: input.ballots.length,
      activeBallots: activeBallots.length,
      rescindedBallots: input.ballots.length - activeBallots.length,
      formalBallots: formalBallots.length,
      noValidBallots: activeBallots.length - formalBallots.length,
    },
    candidateIds: input.candidates.map((c) => c.id),
    candidates: input.candidates,
    electedIds,
    eliminatedIds,
    finalTallies,
    exhausted,
    finalConservation,
    rounds,
    flows,
    initialBatch,
    lots: lots.filter((lot) => !lot.exhausted),
    processingOrder: orderedBallots(input).map((b) => b.id),
    decisions,
    tiePolicy: input.tiePolicy,
    ballotOrder: input.ballotOrder,
  };
}
