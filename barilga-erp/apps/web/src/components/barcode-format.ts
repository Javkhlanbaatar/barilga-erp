/** A valid EAN-13 (manufacturer or our in-store 200… codes) prints as EAN-13; anything else as Code 128. */
export function barcodeFormat(code: string) {
  if (!/^\d{13}$/.test(code)) return 'CODE128';
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]) ? 'EAN13' : 'CODE128';
}
