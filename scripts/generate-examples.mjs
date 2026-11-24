import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseWorkspaceDraft } from '../js/input.js';
import { SAMPLES } from '../js/samples.js';
import { verifyWithInterpreter } from '../js/compare.js';
import { buildAuditExport, checksumResult, flowEntriesCsv, markdownReport, roundsCsv } from '../js/reporting.js';

const outDir = resolve('example-exports');
await mkdir(outDir, { recursive: true });

async function exportSample(sampleId, decisionChoice) {
  const sample = SAMPLES.find((s) => s.id === sampleId);
  const parsed = parseWorkspaceDraft(sample.draft);
  if (!parsed.ok) throw new Error(`${sampleId}: ${parsed.issues.map((i) => i.message).join('; ')}`);

  let decisions = {};
  let first = verifyWithInterpreter(parsed.input, decisions, { maxBallots: 100000 });
  if (first.batch.status === 'tie_pending' && decisionChoice) {
    const tie = first.batch.pendingTie;
    const choice = decisionChoice === 'first' ? tie.options[0] : decisionChoice;
    decisions = { [tie.key]: choice };
  }
  const verification = verifyWithInterpreter(parsed.input, decisions, { maxBallots: 100000 });
  if (!verification.matched) throw new Error(`${sampleId}: interpreter parity failed`);
  const branch = { id: 'example-branch', name: decisionChoice ? '示例裁决分支' : '基线', decisions };
  const checksum = await checksumResult(verification.batch);
  const audit = await buildAuditExport({
    draft: sample.draft,
    parsed,
    branch,
    branches: [branch],
    result: verification.batch,
    verification,
    impact: null,
  });
  const md = markdownReport({ parsed, branch, result: verification.batch, verification, checksum });
  const base = sample.id;

  await writeFile(resolve(outDir, `${base}-audit.json`), JSON.stringify(audit, null, 2));
  await writeFile(resolve(outDir, `${base}-rounds.csv`), `﻿${roundsCsv(verification.batch)}`);
  await writeFile(resolve(outDir, `${base}-flows-entries.csv`), `﻿${flowEntriesCsv(verification.batch, parsed.input)}`);
  await writeFile(resolve(outDir, `${base}-report.md`), md);
  console.log(`exported ${base}: ${verification.batch.status}, checksum ${checksum.slice(0, 16)}…`);
}

await exportSample('tie-three-way', 'first');
await exportSample('fraction-long-chain');
await exportSample('no-valid-preference');
console.log(`Example exports written to ${outDir}`);
