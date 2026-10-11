/**
 * Every module that can be switched off, with its built-in default. Only list a key here once the server
 * actually enforces it (a guarded controller or an explicit check) — a switch that hides nothing is a lie.
 */
export const FEATURES = {
  CUSTOMERS: { default: true, nameMn: 'Харилцагчийн бүртгэл' },
  STOCK_TRANSFERS: { default: true, nameMn: 'Агуулах хоорондын шилжүүлэг' },
} as const;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}
