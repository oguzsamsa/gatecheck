# gatecheck

gatecheck watches the job boards of the companies you care about, straight from their ATS,
and catches new postings the day they're published — no aggregator delay, no paywall.

Then it answers the question the posting itself won't: is this actually open to you?
"100% Remote" and "Work from anywhere" postings are routinely gated to a closed list of
countries — invisible in the prose, deterministic in the ATS's public JSON. Every posting is
sorted into **open**, **closed** or **unknown** for your location, and only the ones worth
reading reach you.

On a sample of 16 live boards across Ashby, Greenhouse, Lever and Recruitee (2,032 postings,
November 2026), for an applicant in Türkiye:

| verdict | postings | share |
| ------- | -------: | ----: |
| closed  |    1,923 | 94.6% |
| open    |       73 |  3.6% |
| unknown |       36 |  1.8% |

Nineteen in twenty postings never needed to be read.

## How it works

```mermaid
flowchart LR
  W[watchlist] --> F
  subgraph sources [one adapter per ATS]
    F[fetch<br/>conditional GET] --> V[validate<br/>zod]
    V --> N[normalize<br/>LocationClaim]
  end
  N --> S[(SQLite<br/>posting + versions)]
  S --> E[eligibility<br/>deterministic rules]
  E --> D[Telegram digest]
```

- **One adapter per ATS.** Each implements `BoardSource` (`src/sources/types.ts`): `fetch`
  validates the payload at the boundary and fails loudly on a shape it doesn't know;
  `normalize` maps it to the shared model. Nothing downstream knows ATS-specific fields.
  Adding an ATS to the `Ats` union fails to compile until its adapter is registered.
- **Locations are claims, not strings.** Ashby gives a label plus a postal address,
  Greenhouse a `;`-joined label plus office groups, Lever free-text locations plus an ISO
  code for the first one, Recruitee ISO codes plus a "pick your location" question. All of
  them reduce to `LocationClaim { kind, countryCode | region, city, raw }`
  (`src/sources/claims.ts`), keeping the source text of every claim.
- **Place matching is exact, never substring.** `'turk' in s.lower()` misses "Türkiye";
  substring matching turns "New Mexico" into Mexico and "Boston, MA" into Morocco. Text is
  Unicode-folded and matched as a whole against committed tables: CLDR country names, a
  small region vocabulary, and a curated city gazetteer that leaves out names shared across
  countries (Cambridge, Hyderabad, San Jose).
- **Postings are versioned.** Each distinct payload is stored in `posting_version` with
  its content hash, so a company quietly removing a country or lowering a salary band is
  visible after the fact.
- **Sources fail independently.** A broken board is recorded in `run_source` with its HTTP
  status and error, appears in the digest, and the run carries on — "why didn't I see this
  posting?" is answered by a query, not a guess.

### Eligibility rules

Deterministic, explainable, and biased against false negatives — a wrongly hidden posting
costs far more than one extra to glance at (`src/eligibility/rules.ts`):

1. Collect the posting's location claims. Explicit applicant requirements (e.g. Recruitee's
   mandatory location question) outrank labels.
2. A claim that names your country, or a region that **certainly** covers it → **open**.
3. Anything that can't be judged — a **contested** region ("Europe" for Türkiye), text that
   names no recognisable place, no location at all → **unknown**. Unknown is never
   dismissed; it lands in its own "worth a look" section.
4. Otherwise every claim excludes you → **closed**.

Every verdict carries its reason, e.g. `EMEA covers Türkiye — remote, from "Remote, EMEA"`
or `limited to SE, GB (remote)`. Seniority is never a filter.

## Polling etiquette

gatecheck reads the same public, unauthenticated endpoints that companies' own career pages
call, once a day:

- an identifying `User-Agent` that points here, no personal data in it;
- conditional requests (`If-None-Match` / `If-Modified-Since`); Ashby, Greenhouse and Lever
  answer `304` when nothing changed;
- bounded retries with jittered exponential backoff, honouring `Retry-After`;
- no posting data is committed or republished; test fixtures are trimmed samples.

| ATS        | Endpoint                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| Ashby      | `api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true` |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true`           |
| Lever      | `api.lever.co/v0/postings/{org}?mode=json`                               |
| Recruitee  | `{org}.recruitee.com/api/offers/`                                        |

## Using it

Requires Node 22.18+ (TypeScript runs natively via type stripping) and pnpm.

```sh
pnpm install
cp config.example.json config.json   # your country, watchlist, Telegram bot
pnpm inspect greenhouse gitlab       # preview how a board normalizes, touches nothing
pnpm poll --dry-run                  # poll, evaluate, print the digest instead of sending
pnpm poll                            # the real thing
pnpm launchd install --hour 9        # macOS: run it every morning
```

`config.json` is gitignored. The Telegram token and chat id can also come from
`GATECHECK_TELEGRAM_BOT_TOKEN` / `GATECHECK_TELEGRAM_CHAT_ID`. To get them, create a bot
with [@BotFather](https://t.me/BotFather), send it a message, and read your chat id from
`https://api.telegram.org/bot<token>/getUpdates`.

## Development

```sh
pnpm check         # typecheck, lint, format, tests — what CI runs
pnpm db:generate   # new migration after editing src/db/schema.ts
```

Golden tests run each adapter's real-world fixtures through its fetch path and record both
the normalized output and the verdicts (`test/fixtures/**/__golden__`,
`test/fixtures/verdicts-TR.txt`): reviewing a change to those files is reviewing a change in
behaviour.

## Out of scope

- Applying automatically. Never.
- Multi-user / SaaS. It is a personal tool.
- Republishing posting data.

## License

MIT
