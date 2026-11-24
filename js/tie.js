import { Fraction } from './fractions.js';
import { canonicalStringify, fnv1a } from './hash.js';

export function makeTieKey({ round, kind, tiedIds, tallies, statusById }) {
  // The key identifies the human-meaningful tie event (round, kind, exact tied
  // candidate set). It intentionally does not hash tallies so a decision can be
  // replayed after a disputed ballot is removed when the same tie recurs.
  return `r${round}-${kind}-${[...tiedIds].sort().join('_')}`;
}

function seededIndex(seed, key, length) {
  const hex = fnv1a(`${seed}:${key}`);
  return Number(BigInt(`0x${hex}`) % BigInt(length));
}

/**
 * Resolve an exact tie event. User branch decisions always win.
 * This function never inspects decimal approximations of vote values.
 */
export function resolveTieEvent(tie, input, decisions = {}) {
  const tiedIds = [...tie.tiedIds];
  const sortedTiedIds = [...tiedIds].sort();
  const decision = decisions[tie.key];

  const decisionChoice = (value) => {
    const chosen = typeof value === 'object' && value !== null
      ? value.choice ?? value.selectedId ?? value.decision ?? value.choices?.[0]
      : value;
    return chosen && tiedIds.includes(chosen) ? chosen : null;
  };

  const exactChoice = decisionChoice(decision);
  if (exactChoice) {
    return { tie, status: 'resolved', selectedId: exactChoice, selectedIds: [exactChoice], resolvedBy: 'branch-decision' };
  }

  // After rescinding a ballot, the same exact candidate set/minimum event can
  // move to an earlier or later round. Replay a unique kind+candidate-set
  // decision while ignoring the round prefix. Ambiguous historical matches stay pending.
  const eventSuffix = `${tie.kind}-${sortedTiedIds.join('_')}`;
  const replayChoices = new Set();
  let replayFromKey = null;
  for (const [key, value] of Object.entries(decisions ?? {})) {
    if (key === tie.key || !/^r\d+-/.test(key)) continue;
    const keySuffix = key.replace(/^r\d+-/, '');
    if (keySuffix !== eventSuffix) continue;
    const choice = decisionChoice(value);
    if (choice) {
      replayChoices.add(choice);
      replayFromKey ??= key;
    }
  }
  if (replayChoices.size === 1) {
    const selectedId = [...replayChoices][0];
    return {
      tie,
      status: 'resolved',
      selectedId,
      selectedIds: [selectedId],
      resolvedBy: 'branch-decision-round-replay',
      matchedDecisionKey: replayFromKey,
    };
  }

  if (input.tiePolicy === 'manual') {
    return { tie, status: 'pending', selectedId: null, selectedIds: [], resolvedBy: null };
  }

  if (input.tiePolicy === 'candidate-order') {
    const order = input.tieBreakOrder?.length ? input.tieBreakOrder : input.candidates.map((c) => c.id);
    const selectedId = tiedIds.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    return { tie, status: 'resolved', selectedId, selectedIds: [selectedId], resolvedBy: 'candidate-order' };
  }

  if (input.tiePolicy === 'seeded') {
    const sorted = [...tiedIds].sort();
    const idx = seededIndex(input.tieSeed, tie.key, sorted.length);
    return { tie, status: 'resolved', selectedId: sorted[idx], selectedIds: [sorted[idx]], resolvedBy: 'seeded-hash' };
  }

  return { tie, status: 'pending', selectedId: null, selectedIds: [], resolvedBy: null };
}
