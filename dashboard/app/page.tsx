import Link from 'next/link';
import { facets, lastRun, listPostings } from 'gatecheck/queries';
import { VERDICTS, type Verdict } from 'gatecheck/schema';
import { db } from '../lib/db';
import { relative } from '../lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  // Default view: what is worth reading — open and unknown.
  const chosen = many(params.verdict).filter((v): v is Verdict =>
    (VERDICTS as readonly string[]).includes(v),
  );
  const verdicts: Verdict[] = params.verdict === undefined ? ['open', 'unknown'] : chosen;
  const q = one(params.q).trim();
  const companyId = Number(one(params.company)) || undefined;
  const country = one(params.country).trim();
  const includeClosed = one(params.closed) === '1';
  const page = Math.max(1, Number(one(params.page)) || 1);

  const database = db();
  const { rows, total } = listPostings(database, {
    verdicts,
    q: q || undefined,
    companyId,
    country: country || undefined,
    includeClosed,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const f = facets(database);
  const run = lastRun(database);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const pageHref = (n: number) => {
    const sp = new URLSearchParams();
    for (const v of verdicts) sp.append('verdict', v);
    if (q) sp.set('q', q);
    if (companyId) sp.set('company', String(companyId));
    if (country) sp.set('country', country);
    if (includeClosed) sp.set('closed', '1');
    sp.set('page', String(n));
    return `/?${sp.toString()}`;
  };

  return (
    <>
      <section className="stats">
        {VERDICTS.map((v) => (
          <div className="stat" key={v}>
            <b>{f.verdicts[v]}</b>
            <span className={`badge ${v}`}>{v}</span>
          </div>
        ))}
        <div className="stat">
          <b>{f.companies.length}</b>
          <span>companies watched</span>
        </div>
        {run && (
          <div className="stat">
            <b>{run.status}</b>
            <span>last run {relative(run.startedAt)}</span>
          </div>
        )}
      </section>

      {run && run.errors.length > 0 && (
        <div className="notice">
          {run.errors.length} source{run.errors.length > 1 ? 's' : ''} failed in the last run:{' '}
          {run.errors
            .map((e) => `${e.company} (${e.error ?? `HTTP ${e.httpStatus ?? '?'}`})`)
            .join(', ')}
        </div>
      )}

      <form className="filters" method="get">
        <input type="search" name="q" placeholder="Title or company" defaultValue={q} />
        {VERDICTS.map((v) => (
          <label key={v}>
            <input type="checkbox" name="verdict" value={v} defaultChecked={verdicts.includes(v)} />
            {v}
          </label>
        ))}
        <select name="company" defaultValue={companyId ?? ''}>
          <option value="">All companies</option>
          {f.companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.open})
            </option>
          ))}
        </select>
        <input
          type="text"
          name="country"
          placeholder="Country (TR)"
          size={10}
          defaultValue={country}
        />
        <label>
          <input type="checkbox" name="closed" value="1" defaultChecked={includeClosed} />
          include taken down
        </label>
        <button type="submit">Filter</button>
      </form>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">No postings match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Posting</th>
                <th>Verdict</th>
                <th>Places</th>
                <th>Salary</th>
                <th>Fit</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/postings/${r.id}`}>{r.title}</Link>
                    <div className="sub">
                      {r.company} · {r.ats}
                      {r.closedAt ? ' · taken down' : ''}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${r.verdict ?? 'none'}`}>{r.verdict ?? '—'}</span>
                    {r.reason && <div className="sub">{r.reason}</div>}
                  </td>
                  <td className="sub">{r.places.join(', ') || '—'}</td>
                  <td className="sub">{r.salary ?? '—'}</td>
                  <td className="sub">{r.fit ?? '—'}</td>
                  <td className="sub">{relative(r.firstSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pager">
        <span>
          {total} posting{total === 1 ? '' : 's'}
        </span>
        <span>
          {page > 1 && <Link href={pageHref(page - 1)}>← newer</Link>} page {page} of {pages}{' '}
          {page < pages && <Link href={pageHref(page + 1)}>older →</Link>}
        </span>
      </div>
    </>
  );
}
