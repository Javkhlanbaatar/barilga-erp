/**
 * In-store barcodes. EAN-13 numbers starting with 200–299 are reserved by GS1 for internal use, so they can
 * never clash with a manufacturer's code. Ours are 200 + a 9-digit running number + the check digit.
 */
export const IN_STORE_PREFIX = '200';

/** The EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];
}

type BarcodeDb = {
  product: {
    findFirst(args: {
      where: { barcode: { startsWith: string } };
      orderBy: { barcode: 'desc' };
      select: { barcode: true };
    }): Promise<{ barcode: string | null } | null>;
  };
};

/** The next free in-store barcode (running number after the highest one issued so far). */
export async function nextInStoreBarcode(db: BarcodeDb, skip = 0): Promise<string> {
  const last = await db.product.findFirst({
    where: { barcode: { startsWith: IN_STORE_PREFIX } },
    orderBy: { barcode: 'desc' },
    select: { barcode: true },
  });
  const lastNo = last?.barcode && /^\d{13}$/.test(last.barcode) ? Number(last.barcode.slice(3, 12)) : 0;
  const first12 = `${IN_STORE_PREFIX}${String(lastNo + 1 + skip).padStart(9, '0')}`;
  return first12 + ean13CheckDigit(first12);
}

/** Codes are stored without spaces; letters are kept (some suppliers use Code 128 with letters). */
export function normalizeBarcode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').replace(/\s+/g, '');
  return code ? code : null;
}
