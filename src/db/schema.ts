/**
 * Storage model. Columns are snake_case in SQLite (via drizzle `casing`), camelCase in TS.
 * Timestamps are integer epoch milliseconds.
 *
 * Closed vocabularies that the eligibility logic depends on (claim kind, verdict, statuses)
 * are enforced with CHECK constraints. Open-ended ones (ATS, region) are enforced in
 * TypeScript only, so extending them never needs a table rebuild.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ATS_VALUES,
  COMPENSATION_PERIODS,
  EMPLOYMENT_TYPES,
  LOCATION_KINDS,
} from '../domain/types.ts';
import type { CountryCode } from '../geo/countries.ts';
import { REGIONS } from '../geo/regions.ts';

const timestamp = () => integer({ mode: 'timestamp_ms' });

/** `col IN ('a', 'b', ...)` for a CHECK constraint. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const company = sqliteTable(
  'company',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    ats: text({ enum: ATS_VALUES }).notNull(),
    /** The board identifier the ATS API takes (Ashby: "codeway", "jobs.funnelfox.com"). */
    orgSlug: text().notNull(),
    careersUrl: text(),
    /** Where this company was found: "seed", or an aggregator URL in phase 2. */
    discoveredFrom: text(),
    addedAt: timestamp().notNull(),
  },
  (t) => [uniqueIndex('company_ats_org_slug_uq').on(t.ats, t.orgSlug)],
);

export const posting = sqliteTable(
  'posting',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    companyId: integer()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    atsPostingId: text().notNull(),
    title: text().notNull(),
    url: text().notNull(),
    department: text(),
    employmentType: text({ enum: EMPLOYMENT_TYPES }),
    /** As claimed by the ATS. */
    postedAt: timestamp(),
    /** As observed by us — the ground truth for "new since last run". */
    firstSeenAt: timestamp().notNull(),
    lastSeenAt: timestamp().notNull(),
    /** Set when the posting disappears from its board; cleared if it comes back. */
    closedAt: timestamp(),
  },
  (t) => [
    uniqueIndex('posting_company_ats_id_uq').on(t.companyId, t.atsPostingId),
    index('posting_open_idx').on(t.closedAt),
  ],
);

/**
 * Append-only history of the raw payload, one row per distinct content hash. A new row
 * means the company changed the posting — this is what makes "Türkiye was removed from
 * the location list" or "the salary band dropped" detectable after the fact.
 */
export const postingVersion = sqliteTable(
  'posting_version',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    postingId: integer()
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    fetchedAt: timestamp().notNull(),
    contentHash: text().notNull(),
    payloadJson: text({ mode: 'json' }).notNull(),
  },
  (t) => [index('posting_version_posting_idx').on(t.postingId, t.fetchedAt)],
);

/** Current location claims of a posting (replaced whenever a new version is stored). */
export const locationClaim = sqliteTable(
  'location_claim',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    postingId: integer()
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    kind: text({ enum: LOCATION_KINDS }).notNull(),
    countryCode: text().$type<CountryCode>(),
    region: text({ enum: REGIONS }),
    city: text(),
    raw: text().notNull(),
  },
  (t) => [
    index('location_claim_posting_idx').on(t.postingId),
    check('location_claim_kind_ck', oneOf('kind', LOCATION_KINDS)),
    check('location_claim_country_or_region_ck', sql`country_code IS NULL OR region IS NULL`),
  ],
);

export const compensation = sqliteTable(
  'compensation',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    postingId: integer()
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    min: real(),
    max: real(),
    currency: text(),
    period: text({ enum: COMPENSATION_PERIODS }),
    source: text().notNull(),
  },
  (t) => [index('compensation_posting_idx').on(t.postingId)],
);

export const VERDICTS = ['open', 'closed', 'unknown'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The current verdict per posting; history is reconstructable from posting_version. */
export const eligibility = sqliteTable(
  'eligibility',
  {
    postingId: integer()
      .primaryKey()
      .references(() => posting.id, { onDelete: 'cascade' }),
    verdict: text({ enum: VERDICTS }).notNull(),
    reason: text().notNull(),
    evaluatedAt: timestamp().notNull(),
  },
  () => [check('eligibility_verdict_ck', oneOf('verdict', VERDICTS))],
);

export const RUN_STATUSES = ['running', 'ok', 'partial', 'failed'] as const;

export const run = sqliteTable(
  'run',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    startedAt: timestamp().notNull(),
    finishedAt: timestamp(),
    status: text({ enum: RUN_STATUSES }).notNull(),
  },
  () => [check('run_status_ck', oneOf('status', RUN_STATUSES))],
);

export const RUN_SOURCE_STATUSES = ['ok', 'not_modified', 'error'] as const;

/**
 * One row per company per run. Answers "why didn't I see this posting?" — and doubles as
 * the store for ETag / Last-Modified: the next run replays the last successful row's
 * validators as a conditional request.
 */
export const runSource = sqliteTable(
  'run_source',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: integer()
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    companyId: integer()
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    status: text({ enum: RUN_SOURCE_STATUSES }).notNull(),
    httpStatus: integer(),
    error: text(),
    postingsSeen: integer(),
    etag: text(),
    lastModified: text(),
    startedAt: timestamp().notNull(),
    durationMs: integer().notNull(),
  },
  (t) => [
    index('run_source_company_idx').on(t.companyId, t.startedAt),
    check('run_source_status_ck', oneOf('status', RUN_SOURCE_STATUSES)),
  ],
);

export const notification = sqliteTable(
  'notification',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    postingId: integer()
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    channel: text({ enum: ['telegram'] }).notNull(),
    sentAt: timestamp().notNull(),
  },
  // The dedupe guarantee: a posting is announced at most once per channel.
  (t) => [uniqueIndex('notification_posting_channel_uq').on(t.postingId, t.channel)],
);

/**
 * Companies seen on an aggregator whose board could not be found. Remembered so discovery
 * does not probe the same names every run; retried after a while.
 */
export const discoveryMiss = sqliteTable('discovery_miss', {
  /** Folded company name. */
  nameKey: text().primaryKey(),
  name: text().notNull(),
  lastTriedAt: timestamp().notNull(),
});

export const CHANGE_KINDS = ['locations', 'compensation', 'title', 'verdict'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * What changed between two versions of a posting, in human terms — "removed TR",
 * "EUR 60K–80K → 50K–70K", "open → closed". Announced once (`notified_at`) for postings
 * that were announced before.
 */
export const postingChange = sqliteTable(
  'posting_change',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    postingId: integer()
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    detectedAt: timestamp().notNull(),
    kind: text({ enum: CHANGE_KINDS }).notNull(),
    before: text().notNull(),
    after: text().notNull(),
    notifiedAt: timestamp(),
  },
  (t) => [
    index('posting_change_pending_idx').on(t.notifiedAt),
    check('posting_change_kind_ck', oneOf('kind', CHANGE_KINDS)),
  ],
);

export const FITS = ['strong', 'possible', 'weak'] as const;

/**
 * The model's reading of one version of a posting. Re-run when the posting changes
 * (`content_hash` no longer matches its latest version). `result_json` holds the full
 * structured answer; the draft itself is also written to data/drafts/.
 */
export const analysis = sqliteTable(
  'analysis',
  {
    postingId: integer()
      .primaryKey()
      .references(() => posting.id, { onDelete: 'cascade' }),
    contentHash: text().notNull(),
    model: text().notNull(),
    analyzedAt: timestamp().notNull(),
    fit: text({ enum: FITS }).notNull(),
    summary: text().notNull(),
    /** Claims whose quote was not found in the profile; non-empty means "review first". */
    ungroundedCount: integer().notNull(),
    draftPath: text(),
    resultJson: text({ mode: 'json' }).notNull(),
  },
  () => [check('analysis_fit_ck', oneOf('fit', FITS))],
);
