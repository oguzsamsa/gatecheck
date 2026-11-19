import { describe, expect, it } from 'vitest';
import { resolvePlaces } from '../../src/geo/resolve.ts';
import { foldPlaceText } from '../../src/geo/text.ts';

describe('foldPlaceText', () => {
  it.each(['Türkiye', 'TÜRKİYE', 'türkiye', 'Turkiye'])('folds %s to "turkiye"', (input) => {
    expect(foldPlaceText(input)).toBe('turkiye');
  });

  it('folds dotted and dotless i', () => {
    expect(foldPlaceText('İSTANBUL')).toBe('istanbul');
    expect(foldPlaceText('Diyarbakır')).toBe('diyarbakir');
  });

  it('reduces punctuation to single spaces', () => {
    expect(foldPlaceText('  Remote — (EMEA) ')).toBe('remote emea');
    expect(foldPlaceText('Bosnia & Herzegovina')).toBe('bosnia and herzegovina');
  });
});

describe('resolvePlaces', () => {
  const places = (text: string) => {
    const { countries, regions } = resolvePlaces(text);
    return { countries, regions };
  };

  it.each(['Türkiye', 'Turkey', 'TÜRKİYE', 'Remote (Turkey)', 'Remote in Türkiye'])(
    'recognises %s as TR',
    (text) => {
      expect(places(text)).toEqual({ countries: ['TR'], regions: [] });
    },
  );

  it('reads every place in a delimited list', () => {
    expect(places('US | EU')).toEqual({ countries: ['US'], regions: ['EU'] });
    expect(places('Remote (US or Canada)')).toEqual({ countries: ['US', 'CA'], regions: [] });
    expect(places('Yerevan, Armenia')).toEqual({ countries: ['AM'], regions: [] });
  });

  it('recognises regions', () => {
    expect(places('Remote, EMEA').regions).toEqual(['EMEA']);
    expect(places('Remote, Global').regions).toEqual(['WORLDWIDE']);
    expect(places('Work from anywhere').regions).toEqual(['WORLDWIDE']);
    expect(places('Anywhere in the world').regions).toEqual(['WORLDWIDE']);
    // Alan's Ashby label: "anywhere" here narrows to the countries, it does not widen.
    const alan = places('Anywhere in France, Belgium, Spain [Europe, Europe, European Union]');
    expect(alan.regions).not.toContain('WORLDWIDE');
    expect(alan.countries).toEqual(['FR', 'BE', 'ES']);
    expect(places('Anywhere in Europe').regions).toEqual(['EUROPE']);
    expect(places('Europe, Middle East and Africa').regions).toEqual(['EMEA']);
  });

  it('does not split country names that contain "and"', () => {
    expect(places('Bosnia & Herzegovina').countries).toEqual(['BA']);
    expect(places('Trinidad and Tobago').countries).toEqual(['TT']);
  });

  it('does not read US state abbreviations as country codes', () => {
    for (const text of ['Boston, MA', 'Denver, CO', 'Chicago, IL', 'San Francisco, CA']) {
      expect(places(text), text).toEqual({ countries: ['US'], regions: [] });
    }
    expect(places('Springfield, IL')).toEqual({ countries: [], regions: [] });
  });

  it('recognises gazetteer cities with their country', () => {
    expect(resolvePlaces('Dublin').cities).toEqual([{ country: 'IE', name: 'Dublin' }]);
    expect(resolvePlaces('İSTANBUL (Hybrid)').cities).toEqual([
      { country: 'TR', name: 'Istanbul' },
    ]);
    expect(resolvePlaces('Bangalore').cities).toEqual([{ country: 'IN', name: 'Bengaluru' }]);
    expect(places('Washington, D.C.').countries).toEqual(['US']);
    expect(places('UAE, Dubai').countries).toEqual(['AE']);
  });

  it('leaves city names shared across countries unresolved', () => {
    for (const text of ['Cambridge', 'Hyderabad', 'San Jose', 'Valencia']) {
      expect(places(text), text).toEqual({ countries: [], regions: [] });
    }
  });

  it('never matches substrings', () => {
    expect(places('New Mexico')).toEqual({ countries: [], regions: [] });
    expect(places('New Jersey')).toEqual({ countries: [], regions: [] });
  });

  it('reports what it could not resolve instead of guessing', () => {
    expect(resolvePlaces('Remote, Springfield')).toEqual({
      countries: [],
      regions: [],
      cities: [],
      unresolved: ['springfield'],
    });
    expect(resolvePlaces('N/A').unresolved).toEqual([]);
  });

  it('reads a segment whose every word is a place on its own', () => {
    expect(resolvePlaces('Remote, London UK').cities).toEqual([{ country: 'GB', name: 'London' }]);
    expect(places('US-NYC').countries).toEqual(['US']);
    expect(places('Remote, KSA').countries).toEqual(['SA']);
    // …but never part of one: "Jersey" is a country, "City" is not a place.
    expect(places('Jersey City')).toEqual({ countries: [], regions: [] });
  });

  it('skips segments the caller already knows the meaning of', () => {
    expect(places('Atlanta, Georgia').countries).toEqual(['US', 'GE']);
    expect(resolvePlaces('Atlanta, Georgia', { skip: ['Georgia'] }).countries).toEqual(['US']);
  });
});
