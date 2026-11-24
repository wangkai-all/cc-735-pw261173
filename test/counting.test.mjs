import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceDraft } from '../js/input.js';
import { SAMPLES } from '../js/samples.js';
import { verifyWithInterpreter, findEarliestAffectedRound } from '../js/compare.js';
import { countElectionBatch } from '../js/counter.js';

function parsedSample(id) {
  const sample = SAMPLES.find((s) => s.id === id);
  const parsed = parseWorkspaceDraft(sample.draft);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues, null, 2));
  return parsed;
}

test('every built-in sample matches the independent per-ballot interpreter exactly', () => {
  for (const sample of SAMPLES) {
    const parsed = parseWorkspaceDraft(sample.draft);
    assert.equal(parsed.ok, true, `${sample.id}: ${JSON.stringify(parsed.issues)}`);
    const verification = verifyWithInterpreter(parsed.input, {}, { maxBallots: 100000 });
    assert.equal(verification.ran, true);
    assert.deepEqual(verification.differences.slice(0, 5), [], `${sample.id} parity differences`);
    assert.equal(verification.matched, true, sample.id);
    assert.equal(verification.conservationOk, true, sample.id);
  }
});

test('three-way exact tie creates independent branches with different winners', () => {
  const parsed = parsedSample('tie-three-way');
  const pending = countElectionBatch(parsed.input, {});
  assert.equal(pending.status, 'tie_pending');
  assert.equal(pending.pendingTie.tiedIds.length, 3);
  assert.ok(pending.pendingTie.tieValue.eq?.(2) ?? pending.pendingTie.tieValue.toString() === '2');

  const key = pending.pendingTie.key;
  const [b, c, d] = pending.pendingTie.options;
  const branchB = verifyWithInterpreter(parsed.input, { [key]: b });
  const branchC = verifyWithInterpreter(parsed.input, { [key]: c });
  const branchD = verifyWithInterpreter(parsed.input, { [key]: d });

  assert.equal(branchB.matched, true);
  assert.equal(branchC.matched, true);
  assert.equal(branchD.matched, true);
  assert.ok(branchB.batch.electedIds.includes(c));
  assert.ok(branchC.batch.electedIds.includes(b));
  assert.equal(branchD.batch.status, 'tie_pending');

  // Re-running base remains pending: selecting a branch cannot overwrite it.
  const baseAgain = countElectionBatch(parsed.input, {});
  assert.equal(baseAgain.status, 'tie_pending');
  assert.equal(baseAgain.pendingTie.key, key);
});

test('duplicate preferences keep first occurrence by default and remain traceable', () => {
  const parsed = parsedSample('duplicate-candidates');
  const d01 = parsed.input.ballots.find((b) => b.id === 'D01');
  assert.deepEqual(d01.preferences, ['c1', 'c2', 'c3']);
  assert.ok(d01.duplicateRefs.length >= 2);
  assert.ok(parsed.issues.some((i) => i.code === 'duplicate_ignored'));

  const verification = verifyWithInterpreter(parsed.input, {});
  assert.equal(verification.matched, true);
  assert.equal(verification.conservationOk, true);
});

test('blank, dot-only and unknown-candidate ballots become exact exhausted votes', () => {
  const parsed = parsedSample('no-valid-preference');
  assert.equal(parsed.stats.noValidCount, 4);
  const result = countElectionBatch(parsed.input, {});
  assert.equal(result.exhausted.toString(), '4');
  assert.equal(result.finalConservation.balanced, true);
  assert.equal(result.finalConservation.totalCounted.toString(), '10');
});

test('long fraction chain reaches 1/3003 on one original ballot', () => {
  const parsed = parsedSample('fraction-long-chain');
  const verification = verifyWithInterpreter(parsed.input, {});
  assert.equal(verification.matched, true);
  const result = verification.batch;
  assert.equal(result.quota.toString(), '10');
  assert.equal(result.electedIds.length, 5);

  const l001Entries = result.flows
    .flatMap((flow) => flow.entries.map((entry) => ({ flow, entry })))
    .filter(({ entry }) => entry.ballotId === 'S001');
  const amounts = l001Entries.map(({ entry }) => entry.amount.toString());
  assert.ok(amounts.includes('1/3003'), `expected 1/3003 in ${amounts.join(', ')}`);

  const finalFlow = result.flows.find((flow) => flow.entries.some((e) => e.ballotId === 'S001' && e.amount.toString() === '1/3003'));
  assert.equal(finalFlow.toCandidateId, 'c6');
});

test('rescinding a ballot identifies an affected round and preserves exact conservation', () => {
  const parsed = parsedSample('tie-three-way');
  const key = countElectionBatch(parsed.input, {}).pendingTie.key;
  const before = countElectionBatch(parsed.input, { [key]: 'c2' });

  const rescindedInput = {
    ...parsed.input,
    ballots: parsed.input.ballots.map((b) => (b.id === 'T05' ? { ...b, status: 'rescinded' } : b)),
  };
  const afterVerification = verifyWithInterpreter(rescindedInput, { [key]: 'c2' }, { maxBallots: 100000 });
  assert.equal(afterVerification.matched, true);
  const impact = findEarliestAffectedRound(before, afterVerification.batch);
  assert.ok(impact.earliestRound === 1 || impact.earliestRound === 2);
  assert.equal(afterVerification.batch.finalConservation.balanced, true);
  assert.equal(afterVerification.batch.totalCounted, 9);
});

test('rescinding an early ballot replays a decision when the same tie moves to round 1', () => {
  const parsed = parsedSample('tie-three-way');
  const oldKey = countElectionBatch(parsed.input, {}).pendingTie.key;
  assert.equal(oldKey, 'r2-elimination-minimum-c2_c3_c4');

  const rescindedInput = {
    ...parsed.input,
    ballots: parsed.input.ballots.map((b) => (b.id === 'T01' ? { ...b, status: 'rescinded' } : b)),
  };
  const verification = verifyWithInterpreter(rescindedInput, { [oldKey]: 'c2' }, { maxBallots: 100000 });
  assert.equal(verification.matched, true);

  const firstTieRound = verification.batch.rounds.find((round) => round.tie?.key === 'r1-elimination-minimum-c2_c3_c4');
  assert.ok(firstTieRound);
  assert.equal(firstTieRound.resolution.status, 'resolved');
  assert.equal(firstTieRound.resolution.selectedId, 'c2');
  assert.equal(firstTieRound.resolution.resolvedBy, 'branch-decision-round-replay');
  assert.equal(firstTieRound.resolution.matchedDecisionKey, oldKey);
  assert.deepEqual(firstTieRound.eliminatedThisRound, ['c2']);
});

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random small elections pass batch/interpreter parity and conservation', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const random = mulberry32(seed);
    const candidateCount = 3 + Math.floor(random() * 4);
    const seats = 1 + Math.floor(random() * (candidateCount - 1));
    const candidates = Array.from({ length: candidateCount }, (_, i) => `候选${String.fromCodePoint(0x7532 + i)}`);
    const ballotCount = 8 + Math.floor(random() * 28);
    const lines = [];
    for (let i = 0; i < ballotCount; i += 1) {
      let prefs = [...candidates];
      for (let j = prefs.length - 1; j > 0; j -= 1) {
        const k = Math.floor(random() * (j + 1));
        [prefs[j], prefs[k]] = [prefs[k], prefs[j]];
      }
      prefs = prefs.slice(0, 1 + Math.floor(random() * candidateCount));
      if (random() < 0.08) prefs = [];
      if (random() < 0.12 && prefs.length > 1) prefs.splice(1, 0, prefs[0]);
      lines.push(`R${seed}-${i}: ${prefs.join(' > ')}`);
    }
    const parsed = parseWorkspaceDraft({
      seats,
      candidateText: candidates.join('\n'),
      ballotText: lines.join('\n'),
      tiePolicy: 'candidate-order',
      duplicatePreference: 'first',
    });
    assert.equal(parsed.ok, true, `seed ${seed}: ${JSON.stringify(parsed.issues)}`);
    const verification = verifyWithInterpreter(parsed.input, {}, { maxBallots: 100000 });
    assert.equal(verification.matched, true, `seed ${seed}: ${JSON.stringify(verification.differences.slice(0, 8))}`);
    assert.equal(verification.conservationOk, true, `seed ${seed} conservation`);
  }
});
