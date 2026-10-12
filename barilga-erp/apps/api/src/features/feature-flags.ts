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
  CREDIT_SALES: { default: true, nameMn: 'Дараа төлөхөөр олгох (зээл)' },
  PRICE_LISTS: { default: true, nameMn: 'Харилцагчийн үнийн жагсаалт (өртөг, бартер г.м.)' },
  PARTNER_ACCOUNTS: { default: true, nameMn: 'Харилцагчийн тооцоо (авлага, өглөг, хасалт)' },
  HR: { default: true, nameMn: 'Ирц ба цалин' },
  CASH_SESSIONS: { default: true, nameMn: 'Касс нээх/хаах (бэлэн мөнгө авахад касс нээлттэй байх)' },
  INVOICES: { default: true, nameMn: 'Нэхэмжлэх илгээх ба бүртгэл' },
  EBARIMT: { default: false, nameMn: 'И-баримт (POSAPI-аар ERP-ээс автоматаар гаргах)' },
  ONLINE_SHOP: { default: true, nameMn: 'Онлайн захиалга (нийтийн сайт)' },
} as const;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}
