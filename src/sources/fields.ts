import type { CompensationPeriod, EmploymentType } from '../domain/types.ts';

/** Free-text commitment ("Full-time", "Permanent", "fulltime_fixed_term") → employment type. */
export function employmentTypeFromText(text: string | null | undefined): EmploymentType | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/intern|werkstudent|working student/.test(t)) return 'internship';
  if (/contract|freelance|contractor/.test(t)) return 'contract';
  if (/part.?time/.test(t)) return 'part_time';
  if (/temp|fixed.?term/.test(t)) return 'temporary';
  if (/full.?time|permanent/.test(t)) return 'full_time';
  return null;
}

/** "per-year-salary", "1 YEAR", "month" → period. */
export function periodFromText(text: string | null | undefined): CompensationPeriod | null {
  const m = text?.toLowerCase().match(/year|annual|month|week|day|hour/);
  if (!m) return null;
  return m[0] === 'annual' ? 'year' : (m[0] as CompensationPeriod);
}

/** Numbers that some ATSes serialise as strings ("3000"). */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
