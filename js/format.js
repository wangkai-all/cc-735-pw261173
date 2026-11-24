import { Fraction } from './fractions.js';
import { exactString } from './compare.js';

export function fmtExact(value) {
  if (value === undefined || value === null) return '—';
  return exactString(value);
}

export function fmtDecimal(value, digits = 6) {
  try {
    return Fraction.from(value).toDecimal(digits);
  } catch {
    return '—';
  }
}

export function fmtFraction(value, digits = 6) {
  const exact = fmtExact(value);
  if (exact === '—' || exact.includes('/') === false) return exact;
  return `${exact} ≈ ${fmtDecimal(value, digits)}`;
}

export function candidateName(inputOrResult, id) {
  if (!id) return '耗尽票池';
  const candidate = inputOrResult?.candidates?.find?.((c) => c.id === id);
  return candidate ? candidate.name : id;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  // Prevent spreadsheet formula execution when a fictional ballot/reference starts with an operator.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function downloadTextFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
