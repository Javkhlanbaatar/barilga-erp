// Search across Cyrillic and Latin ("tsement", "cement", "цемент" all find "Цемент").
// KEEP IN SYNC: apps/web/src/lib/translit.ts must be identical below this line (a test compares them).
// ---------------------------------------------------------------------------------------------------

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'o', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a',
};

/**
 * A loose phonetic key: Mongolian Cyrillic is written in Latin the way people type it (ц→ts, х→h, ө→o, ү→u),
 * common Latin spellings are folded the same way (kh/x→h, c→ts, q→k, w→v, ph→f, ye/yo/yu/ya→e/o/u/a,
 * y→i), doubled letters collapse ("toosgo" = "tosgo") and o/u count as one letter, because ө and ү are
 * typed either way ("undur" = "ondor" = Өндөр). Both the stored text and the typed query go through it, so
 * either alphabet finds the other. Digits are left alone (400 is not 40).
 */
export function searchKey(text: string | null | undefined): string {
  let s = (text ?? '').toLowerCase();
  s = s.replace(/[а-яёөү]/g, (ch) => CYRILLIC[ch] ?? ch);
  s = s
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/kh/g, 'h')
    .replace(/x/g, 'h')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?!h)/g, 'ts')
    .replace(/q/g, 'k')
    .replace(/w/g, 'v')
    .replace(/y([eoua])/g, '$1')
    .replace(/y/g, 'i');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s.replace(/u/g, 'o').replace(/([a-z])\1+/g, '$1');
}

/** True when every word of the query is found in the text, in either alphabet. */
export function matchesSearch(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (text.toLowerCase().includes(q)) return true;
  const key = searchKey(text);
  return searchKey(q)
    .split(' ')
    .filter(Boolean)
    .every((word) => key.includes(word));
}
