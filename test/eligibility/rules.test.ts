import { describe, expect, it } from 'vitest';
import type { LocationClaim } from '../../src/domain/types.ts';
import { regionCovers } from '../../src/eligibility/regions.ts';
import { decide } from '../../src/eligibility/rules.ts';
import type { CountryCode } from '../../src/geo/countries.ts';
import type { Region } from '../../src/geo/regions.ts';

const claim = (over: Partial<LocationClaim>): LocationClaim => ({
  kind: 'remote_region',
  countryCode: null,
  region: null,
  city: null,
  raw: 'x',
  ...over,
});
const country = (code: CountryCode, over: Partial<LocationClaim> = {}) =>
  claim({ countryCode: code, raw: code, ...over });
const region = (r: Region, over: Partial<LocationClaim> = {}) =>
  claim({ region: r, raw: r, ...over });

describe('decide', () => {
  it('opens when the applicant country is listed, among others', () => {
    expect(decide([country('PL'), country('TR'), country('RS')], 'TR')).toEqual({
      verdict: 'open',
      reason: 'Türkiye listed — remote, from "TR"',
    });
  });

  it('opens on a region that certainly covers the applicant', () => {
    expect(decide([region('EMEA')], 'TR').verdict).toBe('open');
    expect(decide([region('WORLDWIDE')], 'BR').verdict).toBe('open');
    expect(decide([region('EU')], 'DE').verdict).toBe('open');
  });

  it('treats an office in the applicant country as open', () => {
    expect(decide([country('TR', { kind: 'office', city: 'Istanbul' })], 'TR')).toEqual({
      verdict: 'open',
      reason: 'Türkiye listed (Istanbul) — office, from "TR"',
    });
  });

  it('closes on a closed list that excludes the applicant', () => {
    expect(decide([country('ES', { kind: 'office' }), country('US')], 'TR')).toEqual({
      verdict: 'closed',
      reason: 'limited to ES, US (office, remote)',
    });
    expect(decide([region('EU'), region('NORTH_AMERICA')], 'TR').verdict).toBe('closed');
  });

  it('is unknown, never closed, for a contested region', () => {
    expect(decide([region('EUROPE')], 'TR')).toEqual({
      verdict: 'unknown',
      reason: 'EUROPE may or may not include Türkiye',
    });
  });

  it('is unknown when any claim is unresolved, even next to excluding ones', () => {
    const decision = decide([country('US'), claim({ raw: 'Remote' })], 'TR');
    expect(decision).toEqual({
      verdict: 'unknown',
      reason: '"Remote" names no place we recognise',
    });
  });

  it('is unknown when the posting states no location', () => {
    expect(decide([], 'TR').verdict).toBe('unknown');
  });

  it('lets explicit applicant requirements override location labels', () => {
    const claims = [
      country('TR', { kind: 'office' }),
      country('NL', { kind: 'applicant_requirement' }),
    ];
    expect(decide(claims, 'TR').verdict).toBe('closed');
  });
});

describe('regionCovers', () => {
  it.each<[Region, CountryCode, string]>([
    ['EMEA', 'TR', 'yes'],
    ['EUROPE', 'TR', 'contested'],
    ['EUROPE', 'DE', 'yes'],
    ['EUROPE', 'CY', 'yes'],
    ['EU', 'TR', 'no'],
    ['EU', 'GB', 'no'],
    ['MENA', 'TR', 'contested'],
    ['NORTH_AMERICA', 'MX', 'contested'],
    ['AMERICAS', 'MX', 'yes'],
    ['APAC', 'IN', 'yes'],
    ['WORLDWIDE', 'XK', 'yes'],
  ])('%s covers %s: %s', (r, c, expected) => {
    expect(regionCovers(r, c)).toBe(expected);
  });
});
