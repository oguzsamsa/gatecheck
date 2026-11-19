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
    expect(places('Europe, Middle East and Africa').regions).toEqual(['EMEA']);
  });

  it('does not split country names that contain "and"', () => {
    expect(places('Bosnia & Herzegovina').countries).toEqual(['BA']);
    expect(places('Trinidad and Tobago').countries).toEqual(['TT']);
  });

  it('does not read US state abbreviations as country codes', () => {
    for (const text of ['Boston, MA', 'Denver, CO', 'Chicago, IL', 'San Francisco, CA']) {
      expect(places(text), text).toEqual({ countries: [], regions: [] });
    }
    expect(places('San Francisco, CA, US').countries).toEqual(['US']);
  });

  it('never matches substrings', () => {
    expect(places('New Mexico')).toEqual({ countries: [], regions: [] });
    expect(places('New Jersey')).toEqual({ countries: [], regions: [] });
  });

  it('reports what it could not resolve instead of guessing', () => {
    expect(resolvePlaces('Remote, London UK')).toEqual({
      countries: [],
      regions: [],
      unresolved: ['london uk'],
    });
  });

  it('skips segments the caller already knows the meaning of', () => {
    expect(places('Atlanta, Georgia').countries).toEqual(['GE']);
    expect(resolvePlaces('Atlanta, Georgia', { skip: ['Georgia'] }).countries).toEqual([]);
  });
});
