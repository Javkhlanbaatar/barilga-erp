/** Product categories and units as people read them (and the shop's saved lists of both), plus the size / weight checks shared by the product forms. */

import { useCallback, useEffect, useState } from 'react';
import type { Ask } from '@/components/ask-dialog';
import { api } from '@/lib/api';

/** Older built-in categories, stored as English keys (seed data). The forms offer the shop's own list (useCategories). */
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

/** Categories offered until the shop saves its own list (same defaults as the API). */
export const DEFAULT_CATEGORIES = [
  'Дотор засал',
  'Гадна хананы өнгөлгөө',
  'Хуурай холимог',
  'Будаг, лак',
  'Дулаалга',
  'Гипс хавтан, профиль',
  'Цемент, бетон',
  'Хавтанцар',
  'Багаж хэрэгсэл',
  'Бэхэлгээ',
  'Сантехник',
  'Цахилгаан',
  'Бусад',
];

/** A category is 1–60 characters (same rule as the API). */
export const CATEGORY_MAX_LENGTH = 60;

/** The value of the «+ Шинэ ангилал» option in a category <select>. */
export const NEW_CATEGORY = '__new_category__';

/** "General" / «Ерөнхий» means no category. */
export const isNoCategory = (name: string) => ['general', 'ерөнхий'].includes(name.trim().toLowerCase());

/** Why a typed category cannot be used (empty when it can): too long, or "General" / «Ерөнхий», which means none. */
export function categoryProblem(name: string): string {
  const t = name.trim();
  if (t.length > CATEGORY_MAX_LENGTH) return `Ангилал ${CATEGORY_MAX_LENGTH} тэмдэгтээс ихгүй байна`;
  if (t && isNoCategory(t)) return `«${t}» ангилал болохгүй, тодорхой ангилал бичнэ үү`;
  return '';
}

type CategoriesResponse = { categories: string[]; inUse?: string[] };
/** For a product form: the shop's list, then categories still written on products. */
const forForms = (res: CategoriesResponse) => [...res.categories, ...(res.inUse ?? [])];

/**
 * Categories saved by the shop (GET /settings/categories: the saved list, then categories still written on
 * products). Falls back to DEFAULT_CATEGORIES when the server cannot be reached.
 */
export async function loadCategories(): Promise<string[]> {
  try {
    const res = await api<CategoriesResponse>('/settings/categories');
    return res.categories?.length ? forForms(res) : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

/** Adds one category to the saved list (needs the PRODUCT_WRITE right); returns the new list. Throws a Mongolian message. */
export async function addCategory(category: string): Promise<string[]> {
  const res = await api<CategoriesResponse>('/settings/categories', {
    method: 'POST',
    body: JSON.stringify({ category: category.trim() }),
  });
  return forForms(res);
}

/** Replaces the saved list (settings page); returns the list and the in-use extras as the server now gives them. */
export async function saveCategories(categories: string[]): Promise<{ categories: string[]; inUse: string[] }> {
  const res = await api<CategoriesResponse>('/settings/categories', { method: 'PUT', body: JSON.stringify({ categories }) });
  return { categories: res.categories, inUse: res.inUse ?? [] };
}

/**
 * Values for a category <select>, each saved exactly as stored (show them with categoryLabel: an older English key
 * such as "Cement" reads «Цемент»). An old key whose Mongolian name is also on the list is offered once, as the
 * list's name — unless it is the product's own (`current`, always offered so an edit keeps it unchanged).
 */
export function categoryOptions(categories: string[], current?: string | null): string[] {
  const cur = (current ?? '').trim();
  const values = categories.map((c) => c.trim()).filter(Boolean);
  const plain = new Set(values.filter((v) => !(v in CATEGORY_LABEL)).map((v) => v.toLowerCase()));
  const seen = new Set<string>();
  const list: string[] = [];
  for (const v of values) {
    if (isNoCategory(v) || seen.has(v.toLowerCase())) continue;
    if (v in CATEGORY_LABEL && v !== cur && plain.has(CATEGORY_LABEL[v].toLowerCase())) continue;
    seen.add(v.toLowerCase());
    list.push(v);
  }
  if (cur && !isNoCategory(cur)) {
    // The product's own spelling replaces a listed one that differs only in letter case, so the <select> shows it.
    const i = list.findIndex((v) => v.toLowerCase() === cur.toLowerCase());
    if (i < 0) list.push(cur);
    else list[i] = cur;
  }
  return list;
}

/**
 * The saved categories for a form. `addNew(save)` asks for a new category's name (with the page's `ask` dialog)
 * and returns it (null when the person cancels): with `save` (the PRODUCT_WRITE right) it is added to the shop's
 * list, otherwise it is only offered in this form for this product. Throws with a Mongolian message when the
 * server refuses it.
 */
export function useCategories(ask: Ask) {
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);

  useEffect(() => {
    let alive = true;
    void loadCategories().then((list) => alive && setCategories(list));
    return () => {
      alive = false;
    };
  }, []);

  const addNew = useCallback(
    async (save: boolean): Promise<string | null> => {
      const answer = await ask({
        title: 'Шинэ ангилал',
        intro: save ? 'Дэлгүүрийн ангиллын жагсаалтад нэмэгдэнэ.' : 'Зөвхөн энэ барааны ангилал болно (жагсаалтад нэмэх эрх алга).',
        fields: [{ key: 'name', label: `Ангиллын нэр (${CATEGORY_MAX_LENGTH} тэмдэгт хүртэл)`, placeholder: 'жишээ: Шал, Дээврийн материал', maxLength: CATEGORY_MAX_LENGTH }],
        confirmText: save ? 'Нэмэх' : 'Сонгох',
        validate: (v) => (v.name ? categoryProblem(v.name) : 'Ангиллын нэрээ бичнэ үү'),
      });
      const name = answer?.name ?? '';
      if (!name) return null;
      if (!save) {
        setCategories((list) => (list.some((c) => c.toLowerCase() === name.toLowerCase()) ? list : [...list, name]));
        return name;
      }
      const list = await addCategory(name);
      setCategories(list);
      // The server keeps the first spelling when the category was already there in another letter case.
      return list.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
    },
    [ask],
  );

  return { categories, addNew };
}

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

/** A unit is 1–16 characters (same rule as the API). */
export const UNIT_MAX_LENGTH = 16;

/** The value of the «+ Шинэ нэгж» option in a unit <select>. */
export const NEW_UNIT = '__new_unit__';

/**
 * Units saved by the shop (GET /settings/units: the saved list, then units still written on products).
 * Falls back to the built-in UNITS when the server cannot be reached.
 */
export async function loadUnits(): Promise<string[]> {
  try {
    const res = await api<{ units: string[]; inUse?: string[] }>('/settings/units');
    return res.units?.length ? [...res.units, ...(res.inUse ?? [])] : UNITS;
  } catch {
    return UNITS;
  }
}

/** Adds one unit to the saved list (needs the PRODUCT_WRITE right); returns the new list. Throws a Mongolian message. */
export async function addUnit(unit: string): Promise<string[]> {
  const res = await api<{ units: string[]; inUse?: string[] }>('/settings/units', { method: 'POST', body: JSON.stringify({ unit: unit.trim() }) });
  return [...res.units, ...(res.inUse ?? [])];
}

/** Replaces the saved list (settings page); returns the list and the in-use extras as the server now gives them. */
export async function saveUnits(units: string[]): Promise<{ units: string[]; inUse: string[] }> {
  const res = await api<{ units: string[]; inUse?: string[] }>('/settings/units', { method: 'PUT', body: JSON.stringify({ units }) });
  return { units: res.units, inUse: res.inUse ?? [] };
}

/**
 * Options for a unit <select>: the saved units in Mongolian (older English units such as "bag" read as
 * "шуудай", so they are not offered twice), plus `current` when a product still carries one not on the list.
 */
export function unitOptions(units: string[], current?: string | null): string[] {
  const list = [...new Set(units.map((u) => unitLabel(u)).filter(Boolean))];
  const c = (current ?? '').trim();
  return c && !list.some((u) => u.toLowerCase() === c.toLowerCase()) ? [...list, c] : list;
}

/**
 * The saved units for a form. `addNew()` asks for a new unit's name (with the page's `ask` dialog), saves it and
 * returns it (null when the person cancels); it throws with a Mongolian message when the server refuses it.
 */
export function useUnits(ask: Ask) {
  const [units, setUnits] = useState<string[]>(UNITS);

  useEffect(() => {
    let alive = true;
    void loadUnits().then((list) => alive && setUnits(list));
    return () => {
      alive = false;
    };
  }, []);

  const addNew = useCallback(async (): Promise<string | null> => {
    const answer = await ask({
      title: 'Шинэ хэмжих нэгж',
      fields: [{ key: 'unit', label: `Нэгжийн нэр (${UNIT_MAX_LENGTH} тэмдэгт хүртэл)`, placeholder: 'жишээ: боодол, рулон, багц', maxLength: UNIT_MAX_LENGTH }],
      confirmText: 'Нэмэх',
      validate: (v) => (!v.unit ? 'Нэгжийн нэрээ бичнэ үү' : v.unit.length > UNIT_MAX_LENGTH ? `Хэмжих нэгж ${UNIT_MAX_LENGTH} тэмдэгтээс ихгүй байна` : ''),
    });
    const unit = answer?.unit ?? '';
    if (!unit) return null;
    const list = await addUnit(unit);
    setUnits(list);
    // The server keeps the first spelling when the unit was already there in another letter case.
    return list.find((u) => u.toLowerCase() === unit.toLowerCase()) ?? unit;
  }, [ask]);

  return { units, addNew };
}

type Num = number | string | null | undefined;

/** A number as typed on a phone: "0,5" and "0.5" are both 0.5, spaces are ignored; NaN when empty or not a number. */
export function parseDecimal(v: Num): number {
  if (typeof v === 'number') return v;
  const raw = String(v ?? '').replace(/\s+/g, '');
  // "1,200" could be a thousand and two hundred or one point two: refuse it so the form asks for "1200" or "1.2"
  // instead of guessing (a stock count must never be read wrong). "0,125" can only be a decimal.
  if (/^-?[1-9]\d{0,2}(,\d{3})+$/.test(raw) || (raw.match(/,/g) ?? []).length > 1) return NaN;
  const s = raw.replace(',', '.');
  if (!s || !/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
  return Number(s);
}

/** Length × width × height in m³ (6 decimals), or null until all three are above 0. */
export function volumeFrom(lengthM: Num, widthM: Num, heightM: Num): number | null {
  const [l, w, h] = [lengthM, widthM, heightM].map((v) => parseDecimal(v));
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
