/**
 * Every module that can be switched off, with its built-in default. Only list a key here once the server
 * actually enforces it (a guarded controller or an explicit check) — a switch that hides nothing is a lie.
 */
export const FEATURES = {
  CUSTOMERS: { default: true, nameMn: 'Харилцагчийн бүртгэл' },
  STOCK_TRANSFERS: { default: true, nameMn: 'Агуулах хоорондын шилжүүлэг ба захиалга цуглуулах' },
  STOCK_RECEIPTS: { default: true, nameMn: 'Бараа орлого (нийлүүлэгчээс)' },
  PICKING: { default: true, nameMn: 'Агуулахын бэлтгэлийн чеклист' },
  WAREHOUSE_REPORT: { default: true, nameMn: 'Агуулахын тайлан' },
  DELIVERY: { default: false, nameMn: 'Хүргэлт (бүс, хүргэлтийн төлбөр, машин, жолооч)' },
  UNLOADING: { default: false, nameMn: 'Буулгалтын үйлчилгээ (хураамжтай)' },
  CREDIT_SALES: { default: true, nameMn: 'Зарлагаар олгох (дараа төлөх)' },
  PRICE_LISTS: { default: true, nameMn: 'Харилцагчийн үнийн жагсаалт (өртөг, бартер г.м.)' },
  PARTNER_ACCOUNTS: { default: true, nameMn: 'Харилцагчийн тооцоо (авлага, өглөг, хасалт)' },
  HR: { default: true, nameMn: 'Ирц ба цалин' },
  ONLINE_SHOP: { default: true, nameMn: 'Онлайн захиалга (нийтийн сайт)' },
} as const;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}
