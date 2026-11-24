import { Fraction, sumFractions } from './fractions.js';
import { orderedBallots } from './input.js';
import { makeTieKey, resolveTieEvent } from './tie.js';

function tallyFromAccounts(accounts, input) {
  const tallies = Object.fromEntries(input.candidates.map((c) => [c.id, Fraction.zero()]));
  for (const account of accounts.values()) {
    for (const [candidateId, value] of account.holdings.entries()) {
      tallies[candidateId] = tallies[candidateId].add(value);
    }
  }
  return tallies;
}

function nextPreference(ballot, sourceId, statusById) {
  const index = ballot.preferences.indexOf(sourceId);
  for (let i = index + 1; i < ballot.preferences.length; i += 1) {
    const candidateId = ballot.preferences[i];
    if (statusById.get(candidateId) === 'continuing') return candidateId;
  }
  return null;
}

function balance(tallies, exhausted, total, rescindedCount = 0) {
  const held = sumFractions(Object.values(tallies));
  const rescindedValue = Fraction.from(rescindedCount);
  const totalFraction = Fraction.from(total);
  return {
    candidateHeld: held,
    exhausted: Fraction.from(exhausted),
    totalCounted: totalFraction,
    rescindedValue,
    originalTotal: totalFraction.add(rescindedValue),
    balanced: held.add(exhausted).eq(totalFraction),
    fullBalanced: held.add(exhausted).add(rescindedValue).eq(totalFraction.add(rescindedValue)),
  };
}

/**
 * Deliberately separate small-scale reference implementation.
 * It mutates one ballot account at a time instead of using grouped lot state.
 */
export function countElectionInterpreter(input, decisions = {}) {
  const activeBallots = orderedBallots(input).filter((b) => b.status !== 'rescinded');
  const totalCounted = activeBallots.length;
  const rescindedCount = input.ballots.length - activeBallots.length;
  const formalValue = activeBallots.filter((b) => b.valid).length;
  const quota = new Fraction(Math.floor(formalValue / (input.seats + 1)) + 1, 1);

  const statusById = new Map(input.candidates.map((c) => [c.id, 'continuing']));
  const electedIds = [];
  const eliminatedIds = [];
  const rounds = [];
  const flows = [];
  let flowSequence = 0;
  let exhausted = Fraction.zero();

  const accounts = new Map();
  for (const ballot of activeBallots) {
    accounts.set(ballot.id, { ballot, holdings: new Map(), exhausted: Fraction.zero() });
  }

  function makeFlow(round, kind, from, target, ratio, entries) {
    const flow = {
      id: `interp-r${round}-flow-${(flowSequence += 1)}`,
      engine: 'per-ballot-interpreter-v1',
      round,
      kind,
      fromCandidateId: from,
      toCandidateId: target,
      exhausted: target === null,
      ratio: Fraction.from(ratio),
      amount: sumFractions(entries.map((e) => e.amount)),
      entries,
    };
    flows.push(flow);
    return flow;
  }

  const initialGroups = new Map();
  for (const ballot of activeBallots) {
    const account = accounts.get(ballot.id);
    const target = ballot.preferences[0] ?? null;
    if (target) account.holdings.set(target, Fraction.one());
    else {
      account.exhausted = Fraction.one();
      exhausted = exhausted.add(1);
    }
    const key = target ?? 'EXHAUSTED';
    if (!initialGroups.has(key)) initialGroups.set(key, []);
    initialGroups.get(key).push({ ballotId: ballot.id, amount: Fraction.one(), targetCandidateId: target });
  }
  for (const [key, entries] of initialGroups) {
    makeFlow(1, 'initial', null, key === 'EXHAUSTED' ? null : key, Fraction.one(), entries);
  }

  function transfer(round, candidateId, kind, ratio) {
    const groups = new Map();
    for (const ballot of activeBallots) {
      const account = accounts.get(ballot.id);
      const sourceValue = account.holdings.get(candidateId) ?? Fraction.zero();
      if (sourceValue.isZero()) continue;

      const amount = ratio.eq(Fraction.one()) ? sourceValue : sourceValue.mul(ratio);
      const retained = sourceValue.sub(amount);
      if (retained.isZero()) account.holdings.delete(candidateId);
      else account.holdings.set(candidateId, retained);

      const target = nextPreference(ballot, candidateId, statusById);
      if (target) account.holdings.set(target, (account.holdings.get(target) ?? Fraction.zero()).add(amount));
      else {
        account.exhausted = account.exhausted.add(amount);
        exhausted = exhausted.add(amount);
      }

      const key = target ?? 'EXHAUSTED';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ballotId: ballot.id, amount, retainedAmount: retained, targetCandidateId: target });
    }

    const flowIds = [];
    for (const [key, entries] of groups) {
      const target = key === 'EXHAUSTED' ? null : key;
      flowIds.push(makeFlow(round, kind, candidateId, target, ratio, entries).id);
    }
    return flowIds;
  }

  let status = 'running';
  let guard = 0;
  while (status === 'running' && guard < 1000) {
    guard += 1;
    const roundIndex = rounds.length + 1;
    const tallies = tallyFromAccounts(accounts, input);
    const before = balance(tallies, exhausted, totalCounted, rescindedCount);
    const continuingIds = input.candidates.map((c) => c.id).filter((id) => statusById.get(id) === 'continuing');
    const remainingSeats = input.seats - electedIds.length;
    const round = {
      index: roundIndex,
      kind: null,
      tallies,
      postTallies: null,
      electedThisRound: [],
      eliminatedThisRound: [],
      tie: null,
      resolution: null,
      flowIds: [],
      conservationBefore: before,
      conservation: null,
    };

    const standingSurplusIds = electedIds.filter((id) => tallies[id].gt(quota));
    if (standingSurplusIds.length) {
      round.kind = 'surplus-transfer';
      for (const id of standingSurplusIds) {
        const ratio = tallies[id].sub(quota).div(tallies[id]);
        round.flowIds.push(...transfer(roundIndex, id, 'surplus', ratio));
      }
      round.postTallies = tallyFromAccounts(accounts, input);
      round.conservation = balance(round.postTallies, exhausted, totalCounted);
      rounds.push(round);
      continue;
    }

    if (continuingIds.length <= remainingSeats) {
      round.kind = 'acclamation';
      for (const id of continuingIds) {
        statusById.set(id, 'elected');
        electedIds.push(id);
        round.electedThisRound.push(id);
      }
      round.postTallies = tallyFromAccounts(accounts, input);
      round.conservation = balance(round.postTallies, exhausted, totalCounted);
      status = 'complete';
      rounds.push(round);
      break;
    }

    const qualifiers = continuingIds.filter((id) => tallies[id].gte(quota));
    if (qualifiers.length) {
      round.kind = 'election';
      for (const id of qualifiers) {
        statusById.set(id, 'elected');
        electedIds.push(id);
        round.electedThisRound.push(id);
      }
      for (const id of qualifiers) {
        const surplus = tallies[id].sub(quota);
        if (!surplus.isZero()) {
          const ratio = surplus.div(tallies[id]);
          round.flowIds.push(...transfer(roundIndex, id, 'surplus', ratio));
        }
      }
      round.postTallies = tallyFromAccounts(accounts, input);
      round.conservation = balance(round.postTallies, exhausted, totalCounted);
      if (electedIds.length >= input.seats) status = 'complete';
      rounds.push(round);
      if (status === 'complete') break;
      continue;
    }

    const min = continuingIds.reduce((m, id) => (tallies[id].lt(m) ? tallies[id] : m), tallies[continuingIds[0]]);
    const tiedIds = continuingIds.filter((id) => tallies[id].eq(min));
    const tie = {
      key: makeTieKey({ round: roundIndex, kind: 'elimination-minimum', tiedIds, tallies, statusById }),
      round: roundIndex,
      kind: 'elimination-minimum',
      tiedIds,
      tieValue: min,
      options: tiedIds,
    };
    const resolution = resolveTieEvent(tie, input, decisions);
    tie.selectedId = resolution.selectedId;
    tie.resolution = resolution.status;
    tie.resolvedBy = resolution.resolvedBy;
    round.tie = tie;
    round.resolution = resolution;

    if (resolution.status === 'pending') {
      round.kind = 'tie-pending';
      round.postTallies = tallies;
      round.conservation = before;
      status = 'tie_pending';
      rounds.push(round);
      break;
    }

    const eliminatedId = resolution.selectedId;
    statusById.set(eliminatedId, 'eliminated');
    eliminatedIds.push(eliminatedId);
    round.kind = 'elimination';
    round.eliminatedThisRound = [eliminatedId];
    round.flowIds.push(...transfer(roundIndex, eliminatedId, 'elimination', Fraction.one()));
    round.postTallies = tallyFromAccounts(accounts, input);
    round.conservation = balance(round.postTallies, exhausted, totalCounted);
    rounds.push(round);
  }

  return {
    engine: 'per-ballot-interpreter-v1',
    status,
    quota,
    formalValue,
    totalCounted,
    electedIds,
    eliminatedIds,
    finalTallies: tallyFromAccounts(accounts, input),
    exhausted,
    rounds,
    flows,
    processingOrder: activeBallots.map((b) => b.id),
  };
}
