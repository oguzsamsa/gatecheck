# gatecheck

Job postings lie in their marketing copy and tell the truth in their structured data.
"100% Remote" and "Work from anywhere" postings are routinely gated to a closed list of
countries — invisible in the prose, deterministic in the ATS's public JSON. gatecheck reads
that JSON directly and sorts postings into **open**, **closed** and **unknown** for one
applicant location.

The goal is not more postings. It is **zero time spent reading postings that were never open
to you.**

> Status: early. The storage model and the first ATS adapter (Ashby) are in place; the
> poller, eligibility rules and Telegram digest are next.

## How it works

```
watchlist ─► BoardSource.fetch ─► validate ─► normalize ─► store + version ─► eligibility ─► digest
             (one per ATS)        (zod)       (LocationClaim)  (content hash)   (deterministic)
```

- **One adapter per ATS.** Each implements `BoardSource` (`src/sources/types.ts`): `fetch`
  validates the payload at the boundary, `normalize` maps it to the shared model. Nothing
  downstream knows ATS-specific fields.
- **Locations are claims, not strings.** Every ATS encodes location differently. All of them
  reduce to `LocationClaim { kind, countryCode | region, city, raw }`, keeping the source
  text of every claim. A claim that can't be resolved is kept, not dropped — it is what
  sends a posting to `unknown` instead of hiding it.
- **Place matching is exact, never substring.** `'turk' in s.lower()` misses "Türkiye";
  substring matching turns "New Mexico" into Mexico and "Boston, MA" into Morocco. Names are
  Unicode-folded and matched whole against a committed CLDR table (`src/geo/`).
- **Postings are versioned.** Each distinct payload is stored with its content hash, so a
  company quietly removing a country or lowering a salary band is detectable.
- **Sources fail independently.** A broken board is recorded in `run_source` with its HTTP
  status and error; the run carries on.

## Polling etiquette

gatecheck reads the same public, unauthenticated endpoints that the companies' own career
pages call, once a day:

- an identifying `User-Agent`, no personal data in it;
- conditional requests (`If-None-Match` / `If-Modified-Since`) — Ashby answers `304` when
  nothing changed;
- bounded retries with jittered exponential backoff, honouring `Retry-After`;
- no posting data is committed or republished; test fixtures are trimmed samples.

| ATS   | Endpoint                                                                 |
| ----- | ------------------------------------------------------------------------ |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true` |

## Development

Requires Node 22.18+ (TypeScript runs natively via type stripping) and pnpm.

```sh
pnpm install
pnpm check                      # typecheck, lint, format, tests
pnpm inspect ashby codeway      # fetch a live board and print the normalized claims
pnpm db:generate                # new migration after editing src/db/schema.ts
```
