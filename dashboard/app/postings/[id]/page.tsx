import Link from 'next/link';
import { notFound } from 'next/navigation';
import { postingDetail } from 'gatecheck/queries';
import { db } from '../../../lib/db';
import { formatDate } from '../../../lib/format';

export const dynamic = 'force-dynamic';

interface StoredAnalysis {
  fit_summary?: string;
  location_signals?: { quote: string; reading: string }[];
  claims_rejected?: { claim: string; reason: string }[];
  draft?: string;
}

export default async function PostingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = postingDetail(db(), Number(id));
  if (!p) notFound();
  const a = p.analysis;
  const result = (a?.resultJson ?? null) as StoredAnalysis | null;

  return (
    <>
      <p>
        <Link href="/">← all postings</Link>
      </p>
      <h1 style={{ marginBottom: 4 }}>{p.title}</h1>
      <p className="sub" style={{ marginTop: 0 }}>
        {p.company} · {p.ats}/{p.org} · <a href={p.url}>open posting ↗</a>
      </p>

      <section className="card">
        <h2>
          Verdict <span className={`badge ${p.verdict ?? 'none'}`}>{p.verdict ?? '—'}</span>
        </h2>
        <p style={{ margin: 0 }}>{p.reason ?? 'Not evaluated yet.'}</p>
      </section>

      <section className="card">
        <h2>Location claims</h2>
        {p.claims.length === 0 ? (
          <p className="sub">None stated.</p>
        ) : (
          <ul>
            {p.claims.map((c) => (
              <li key={c.id}>
                <b>{c.countryCode ?? c.region ?? 'unresolved'}</b> {c.city ? `(${c.city}) ` : ''}
                <span className="sub">
                  {c.kind.replace('_', ' ')} · from “{c.raw}”
                </span>
              </li>
            ))}
          </ul>
        )}
        {p.compensation.length > 0 && <p>Salary: {p.compensation.join(', ')}</p>}
        <p className="sub" style={{ marginBottom: 0 }}>
          {[p.department, p.employmentType?.replace('_', ' ')].filter(Boolean).join(' · ')}
          {' · '}posted {formatDate(p.postedAt)} · first seen {formatDate(p.firstSeenAt)} · last
          seen {formatDate(p.lastSeenAt)}
          {p.closedAt ? ` · taken down ${formatDate(p.closedAt)}` : ''}
        </p>
      </section>

      {a && result && (
        <section className="card">
          <h2>
            Analysis: fit {a.fit}
            {a.ungroundedCount > 0 && (
              <span className="badge unknown" style={{ marginLeft: 8 }}>
                {a.ungroundedCount} unbacked claim{a.ungroundedCount > 1 ? 's' : ''}
              </span>
            )}
          </h2>
          <p>{result.fit_summary}</p>
          {result.location_signals && result.location_signals.length > 0 && (
            <ul>
              {result.location_signals.map((s, i) => (
                <li key={i}>
                  <span className="sub">{s.reading.replaceAll('_', ' ')}:</span> “{s.quote}”
                </li>
              ))}
            </ul>
          )}
          {result.claims_rejected && result.claims_rejected.length > 0 && (
            <>
              <p className="sub">Left out of the draft:</p>
              <ul>
                {result.claims_rejected.map((c, i) => (
                  <li key={i}>
                    {c.claim} <span className="sub">— {c.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.draft && (
            <>
              <p className="sub">Draft ({a.model}, never sent automatically):</p>
              <pre className="draft">{result.draft}</pre>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>History</h2>
        {p.changes.length > 0 && (
          <ul>
            {p.changes.map((c) => (
              <li key={c.id}>
                {formatDate(c.detectedAt)} · <b>{c.kind}</b>: {c.before} → {c.after}
              </li>
            ))}
          </ul>
        )}
        <p className="sub" style={{ marginBottom: 0 }}>
          {p.versions.length} stored version{p.versions.length === 1 ? '' : 's'}:{' '}
          {p.versions
            .map((v) => `${formatDate(v.fetchedAt)} (${v.contentHash.slice(0, 8)})`)
            .join(', ')}
        </p>
      </section>
    </>
  );
}
