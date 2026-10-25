import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type AuditDb = { editAudit: { create(args: { data: Prisma.EditAuditUncheckedCreateInput }): Promise<unknown> } };

export type AuditEntry = {
  /** What kind of thing changed (shown as the type in the edits report), e.g. SETTINGS, USER, PAYROLL. */
  entityType: string;
  entityId: string;
  /** One line a person can read: "Кассчин Бат: эрх Кассчин → Салбарын менежер". */
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  actorId: string;
};

const log = new Logger('Audit');

/**
 * Writes one row to the edits report (Засварын түүх). Never stores secrets: callers pass field names and
 * plain values only (a password change is recorded as "нууц үг солив", never the value). A failure to write
 * the audit row is logged, not thrown, so it cannot undo the change it describes.
 */
export async function audit(db: AuditDb, e: AuditEntry) {
  try {
    await db.editAudit.create({
      data: {
        entityType: e.entityType,
        entityId: e.entityId,
        summary: e.summary.slice(0, 500),
        before: (e.before ?? {}) as Prisma.InputJsonValue,
        after: (e.after ?? {}) as Prisma.InputJsonValue,
        reason: e.reason ?? '',
        actorId: e.actorId,
      },
    });
  } catch (err) {
    log.error(`Audit write failed for ${e.entityType} ${e.entityId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The keys whose values differ between two plain objects (JSON comparison). */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
}

/** Mongolian names of the setting fields shown in the edits report. */
const FIELD_MN: Record<string, string> = {
  name: 'нэр',
  regNumber: 'РД',
  address: 'хаяг',
  phone: 'утас',
  email: 'и-мэйл',
  bankAccounts: 'данс',
  invoiceNote: 'нэхэмжлэхийн тэмдэглэл',
  receiptFooter: 'баримтын доод бичиг',
  logoUrl: 'лого',
  watermark: 'усан тэмдэг',
  title: 'гарчиг',
  headerNote: 'дээд текст',
  footerNote: 'доод текст',
  blankBuyer: 'хоосон худалдан авагч',
  blankRows: 'хоосон мөр',
  signatures: 'гарын үсэг',
  stamp: 'тэмдэг',
  showPrices: 'үнэ харуулах',
  kind: 'төрөл',
  isActive: 'идэвхтэй эсэх',
  isDefault: 'үндсэн',
  invoice: 'нэхэмжлэх',
  receipt: 'баримт',
  issueNote: 'зарлагын баримт',
  picklist: 'бэлтгэх хуудас',
  hidden: 'харагдах хэсэг',
};

/** "нэр, РД" from ["name", "regNumber"]. */
export function fieldNames(keys: string[]): string {
  return keys.map((k) => FIELD_MN[k] ?? k).join(', ');
}
