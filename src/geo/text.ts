/**
 * Folds free-text place names into a comparable key.
 *
 * Naive lowercasing is how `'turk' in s.lower()` misses "Türkiye": `ü` is not `u`, and
 * Turkish `İ`/`ı` don't round-trip through ASCII case mapping at all. So we decompose,
 * strip combining marks, map the letters that have no decomposition, and reduce
 * punctuation to single spaces.
 */
const NON_DECOMPOSING: Record<string, string> = {
  ı: 'i',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  '&': ' and ',
};

export function foldPlaceText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[ıßøđłæœ&]/g, (ch) => NON_DECOMPOSING[ch] ?? ch)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
