/** Product categories and units as people read them, plus the size / weight checks shared by the product forms. */

/** Built-in categories (stored as English keys; staff may also type their own). */
export const CATEGORIES = ['General', 'Cement', 'Steel', 'Masonry', 'Aggregates', 'Wood', 'Hardware', 'Other'];

export const CATEGORY_LABEL: Record<string, string> = {
  General: 'Ерөнхий',
  Cement: 'Цемент',
  Steel: 'Төмөр',
  Masonry: 'Тоосго, блок',
  Aggregates: 'Дүүргэгч',
  Wood: 'Мод',
  Hardware: 'Төмөр хэрэгсэл, багаж',
  Other: 'Бусад',
};

/** Category as shown: the built-in English keys in Mongolian, anything typed by staff as typed. */
export const categoryLabel = (c?: string | null) => CATEGORY_LABEL[c ?? 'General'] ?? c ?? 'Ерөнхий';

/** Typing "Цемент" saves the existing "Cement" category instead of starting a second one. */
export const categoryKey = (label: string) => {
  const t = label.trim();
  return Object.entries(CATEGORY_LABEL).find(([, l]) => l.toLowerCase() === t.toLowerCase())?.[0] ?? (t || 'General');
};

/** Units saved in English (seed data, older products) and their Mongolian names. */
export const UNIT_LABEL: Record<string, string> = {
  pcs: 'ш',
  piece: 'ш',
  bag: 'шуудай',
  bar: 'ширхэг',
  sheet: 'хуудас',
  kg: 'кг',
  t: 'тн',
  ton: 'тн',
  m: 'м',
  m2: 'м²',
  m3: 'м³',
  'm³': 'м³',
  'm²': 'м²',
  l: 'л',
};

/** Units offered when a product is registered (the Mongolian names above). */
export const UNITS = [...new Set(Object.values(UNIT_LABEL))];

/** Unit as shown: English units in Mongolian, anything else unchanged. */
export const unitLabel = (unit?: string | null) => (unit ? (UNIT_LABEL[unit.trim().toLowerCase()] ?? unit) : '');

type Num = number | string | null | undefined;

/** Length × width × height in m³ (6 decimals), or null until all three are above 0. */
export function volumeFrom(lengthM: Num, widthM: Num, heightM: Num): number | null {
  const [l, w, h] = [lengthM, widthM, heightM].map((v) => Number(v));
  if (!(l > 0 && w > 0 && h > 0)) return null;
  return Math.round(l * w * h * 1_000_000) / 1_000_000;
}

/** After a length, width or height change: the volume follows when all three are known (it can still be typed over). */
export function withVolume<T extends { lengthM: string; widthM: string; heightM: string; volumeM3: string }>(d: T): T {
  const v = volumeFrom(d.lengthM, d.widthM, d.heightM);
  return v === null ? d : { ...d, volumeM3: String(v) };
}

/** What still has to be filled in for a product, in Mongolian ("ангилал", "жин", "урт", "эзлэхүүн"). */
export function missingInfo(p: { category?: string | null; weightKg?: Num; lengthM?: Num; volumeM3?: Num }): string[] {
  const missing: string[] = [];
  const category = (p.category ?? '').trim();
  if (!category || category === 'General') missing.push('ангилал');
  if (!(Number(p.weightKg) > 0)) missing.push('жин');
  if (!(Number(p.lengthM) > 0)) missing.push('урт');
  if (!(Number(p.volumeM3) > 0)) missing.push('эзлэхүүн');
  return missing;
}
