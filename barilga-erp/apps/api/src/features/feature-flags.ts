/**
 * Every module that can be switched off, with its built-in default. Only list a key here once the server
 * actually enforces it (a guarded controller or an explicit check) — a switch that hides nothing is a lie.
 *
 * `dormant` modules are not used by this business for now: they are always off, hidden from the module page,
 * and cannot be switched on from the UI. Their code stays so they can be revived by removing the flag here.
 */
export const FEATURES = {
  CUSTOMERS: { default: true, nameMn: 'Харилцагчийн бүртгэл' },
  STOCK_TRANSFERS: { default: true, nameMn: 'Агуулах хоорондын шилжүүлэг ба захиалга цуглуулах' },
  STOCK_RECEIPTS: { default: true, nameMn: 'Бараа орлого (нийлүүлэгчээс)' },
  PICKING: { default: true, nameMn: 'Агуулахын бэлтгэлийн чеклист' },
  WAREHOUSE_REPORT: { default: true, nameMn: 'Агуулахын тайлан' },
  CREDIT_SALES: { default: true, nameMn: 'Дараа төлөхөөр олгох (зээл)' },
  PRICE_LISTS: { default: true, nameMn: 'Харилцагчийн үнийн жагсаалт (өртөг, бартер г.м.)' },
  PARTNER_ACCOUNTS: { default: true, nameMn: 'Харилцагчийн тооцоо (авлага, өглөг, хасалт)' },
  HR: { default: true, nameMn: 'Ирц ба цалин' },
  PAYROLL_FORMULA: {
    default: false,
    nameMn: 'Цалингийн автомат томьёо (захиалга тутмын урамшуулал, борлуулалтын %, НДШ, ХХОАТ)',
  },
  CASH_SESSIONS: { default: true, nameMn: 'Касс нээх/хаах (бэлэн мөнгө авахад касс нээлттэй байх)' },
  INVOICES: { default: true, nameMn: 'Нэхэмжлэх илгээх ба бүртгэл' },
  DELIVERY: { default: false, dormant: true, nameMn: 'Хүргэлт (бүс, хүргэлтийн төлбөр, машин, жолооч)' },
  UNLOADING: { default: false, dormant: true, nameMn: 'Буулгалтын үйлчилгээ (хураамжтай)' },
  EBARIMT: { default: false, dormant: true, nameMn: 'И-баримт (POSAPI-аар ERP-ээс автоматаар гаргах)' },
  ONLINE_SHOP: { default: false, dormant: true, nameMn: 'Онлайн захиалга (нийтийн сайт)' },
} as const;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}

export function isDormant(key: FeatureKey): boolean {
  return 'dormant' in FEATURES[key] && FEATURES[key].dormant === true;
}
