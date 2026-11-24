import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceDraft } from '../js/input.js';
import { getSample } from '../js/samples.js';
import { verifyWithInterpreter } from '../js/compare.js';
import { buildConfirmedReport, reproduceReport, roundsCsv, flowEntriesCsv } from '../js/reporting.js';

test('confirmed report checksum reproduces from immutable snapshot', async () => {
  const sample = getSample('fraction-long-chain');
  const draft = structuredClone(sample.draft);
  const parsed = parseWorkspaceDraft(draft);
  const verification = verifyWithInterpreter(parsed.input, {}, { maxBallots: 100000 });
  const report = await buildConfirmedReport({
    draft,
    parsed,
    branch: { id: 'base', name: '基线', decisions: {} },
    branches: [],
    result: verification.batch,
    verification,
    markdown: '# test',
  });

  assert.match(report.resultChecksum, /^[0-9a-f]{64}$/);
  assert.match(report.auditChecksum, /^[0-9a-f]{64}$/);

  // Mutate the live draft after confirmation; report snapshot must remain independent.
  draft.seats = 1;
  draft.ballotText = 'X1: 甲\n';

  const reproduction = await reproduceReport(report);
  assert.equal(reproduction.ok, true);
  assert.equal(reproduction.parityMatched, true);
  assert.equal(reproduction.actualChecksum, report.resultChecksum);
  assert.equal(reproduction.result.electedIds.length, 5);
});

test('CSV exports contain exact fraction entries and trace rows', () => {
  const sample = getSample('fraction-long-chain');
  const parsed = parseWorkspaceDraft(sample.draft);
  const verification = verifyWithInterpreter(parsed.input, {});
  const rounds = roundsCsv(verification.batch);
  const flows = flowEntriesCsv(verification.batch, parsed.input);
  assert.match(rounds, /r1-surplus-c1|c1/);
  assert.match(flows, /1\/3003/);
  assert.match(flows, /S001/);
});
