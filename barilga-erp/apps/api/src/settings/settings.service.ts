import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { audit, changedKeys, fieldNames } from '../common/audit';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsDto } from './company.dto';
import { DEFAULT_TEMPLATE, DocTemplate, DocTemplatesDto } from './doc-template.dto';
import { Orientation, PaperSize, PRINT_DOCS, PrintDoc, PrintSettingsDto } from './print.dto';

const COMPANY_KEY = 'COMPANY';

export type CompanySettings = {
  name: string;
  regNumber: string;
  address: string;
  phone: string;
  email: string;
  bankAccounts: Array<{ bankName: string; accountNumber: string; accountName: string }>;
  invoiceNote: string;
  receiptFooter: string;
  /** Uploaded logo (/uploads/company/…), empty when none. Changed only through the logo upload. */
  logoUrl: string;
  /** Show the logo as a faint watermark behind invoices and receipts. */
  watermark: boolean;
};

const EMPTY_COMPANY: CompanySettings = {
  name: '',
  regNumber: '',
  address: '',
  phone: '',
  email: '',
  bankAccounts: [],
  invoiceNote: '',
  receiptFooter: '',
  logoUrl: '',
  watermark: true,
};

const PRINT_KEY = 'PRINT';
const DOCS_KEY = 'DOC_TEMPLATES';
const DOC_NAMES: Record<PrintDoc, string> = { invoice: 'Нэхэмжлэх', receipt: 'Баримт', issueNote: 'Зарлагын баримт', picklist: 'Бэлтгэх хуудас' };

export type PrintSettings = Record<PrintDoc, { paper: PaperSize; orientation: Orientation; copies: number }>;

const DEFAULT_PRINT: PrintSettings = {
  invoice: { paper: 'A4', orientation: 'portrait', copies: 1 },
  receipt: { paper: '80MM', orientation: 'portrait', copies: 1 },
  issueNote: { paper: 'A5', orientation: 'landscape', copies: 1 },
  picklist: { paper: 'A4', orientation: 'portrait', copies: 1 },
};

const UNITS_KEY = 'UNITS';
const UNIT_MAX_LENGTH = 16;
const UNITS_MAX = 60;

/** Measuring units offered in the product form until someone saves their own list. */
export const DEFAULT_UNITS = ['ш', 'ширхэг', 'шуудай', 'хуудас', 'кг', 'тн', 'м', 'м²', 'м³', 'л', 'боодол', 'ороомог', 'хайрцаг', 'багц'];

/** Trimmed, empty lines dropped, and the first spelling kept when a unit repeats in any letter case. */
function cleanUnits(list: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const unit = typeof raw === 'string' ? raw.trim() : '';
    const key = unit.toLowerCase();
    if (!unit || seen.has(key)) continue;
    seen.add(key);
    out.push(unit);
  }
  return out;
}

const CATEGORIES_KEY = 'CATEGORIES';
const CATEGORY_MAX_LENGTH = 60;
const CATEGORIES_MAX = 100;

/** Product categories offered in the product form until someone saves their own list (a building-materials shop). */
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

/** 'General' is what a product without a category carries, never a choice of its own. */
/** "General" / «Ерөнхий» means no category. */
const isGeneral = (category: string) => ['general', 'ерөнхий'].includes(category.toLowerCase());

/** Like cleanUnits, and 'General' is dropped too. */
function cleanCategories(list: unknown[]): string[] {
  return cleanUnits(list).filter((c) => !isGeneral(c));
}

@Injectable()
export class SettingsService {
  private readonly log = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seller details for printed documents. Empty fields until an admin fills them in. */
  async company(): Promise<CompanySettings & { configured: boolean }> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: COMPANY_KEY } });
    const value = (row?.value ?? {}) as Partial<CompanySettings>;
    const merged = { ...EMPTY_COMPANY, ...value, bankAccounts: value.bankAccounts ?? [] };
    return { ...merged, configured: Boolean(merged.name) };
  }

  /** Paper size, orientation and copies per printed document; defaults until an admin changes them. */
  async print(): Promise<PrintSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: PRINT_KEY } });
    const saved = (row?.value ?? {}) as Partial<PrintSettings>;
    return Object.fromEntries(
      PRINT_DOCS.map((doc) => [doc, { ...DEFAULT_PRINT[doc], ...(saved[doc] ?? {}) }]),
    ) as PrintSettings;
  }

  async setPrint(dto: PrintSettingsDto, actorId: string) {
    const merged = { ...(await this.print()) };
    for (const doc of PRINT_DOCS) {
      const next = dto[doc];
      if (next) merged[doc] = { paper: next.paper, orientation: next.orientation, copies: next.copies };
    }
    const before = await this.print();
    const json = merged as unknown as Prisma.InputJsonValue;
    await audit(this.prisma, {
      entityType: 'SETTINGS',
      entityId: PRINT_KEY,
      summary: `Хэвлэх тохиргоо: ${fieldNames(changedKeys(before, merged)) || 'өөрчлөлтгүй'}`,
      before,
      after: merged,
      actorId,
    });
    await this.prisma.appSetting.upsert({
      where: { key: PRINT_KEY },
      create: { key: PRINT_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Print settings updated by ${actorId}`);
    return merged;
  }

  async setCompany(dto: CompanySettingsDto, actorId: string) {
    const current = await this.company();
    const value: CompanySettings = {
      name: dto.name,
      regNumber: dto.regNumber ?? '',
      address: dto.address ?? '',
      phone: dto.phone ?? '',
      email: dto.email ?? '',
      bankAccounts: (dto.bankAccounts ?? []).map((b) => ({
        bankName: b.bankName,
        accountNumber: b.accountNumber,
        accountName: b.accountName ?? '',
      })),
      invoiceNote: dto.invoiceNote ?? '',
      receiptFooter: dto.receiptFooter ?? '',
      logoUrl: current.logoUrl,
      watermark: dto.watermark ?? current.watermark,
    };
    return this.saveCompany(value, actorId);
  }

  /** Sets (or with null, removes) the logo printed on documents. */
  async setLogo(logoUrl: string | null, actorId: string) {
    const { configured: _c, ...current } = await this.company();
    this.log.log(`Company logo ${logoUrl ? 'uploaded' : 'removed'} by ${actorId}`);
    return this.saveCompany({ ...current, logoUrl: logoUrl ?? '' }, actorId);
  }

  private async saveCompany(value: CompanySettings, actorId: string) {
    const { configured: _c, ...before } = await this.company();
    const keys = changedKeys(before, value);
    if (keys.length) {
      await audit(this.prisma, {
        entityType: 'SETTINGS',
        entityId: COMPANY_KEY,
        summary: `Компанийн мэдээлэл: ${fieldNames(keys)}`,
        before: Object.fromEntries(keys.map((k) => [k, before[k as keyof CompanySettings]])),
        after: Object.fromEntries(keys.map((k) => [k, value[k as keyof CompanySettings]])),
        actorId,
      });
    }
    const json = value as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: COMPANY_KEY },
      create: { key: COMPANY_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Company settings updated by ${actorId}`);
    return this.company();
  }

  /** Wording and empty spaces of each printed document (built-in defaults until an admin changes them). */
  async documents(): Promise<Record<PrintDoc, DocTemplate>> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: DOCS_KEY } });
    const saved = (row?.value ?? {}) as Partial<Record<PrintDoc, Partial<DocTemplate>>>;
    return Object.fromEntries(PRINT_DOCS.map((d) => [d, { ...DEFAULT_TEMPLATE[d], ...(saved[d] ?? {}) }])) as Record<PrintDoc, DocTemplate>;
  }

  async setDocuments(dto: DocTemplatesDto, actorId: string) {
    const before = await this.documents();
    const merged = await this.documents();
    for (const d of PRINT_DOCS) {
      const next = dto[d];
      if (!next) continue;
      merged[d] = {
        ...merged[d],
        ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)),
        ...(next.signatures ? { signatures: next.signatures.map((x) => x.trim()).filter(Boolean) } : {}),
      } as DocTemplate;
    }
    const changed = PRINT_DOCS.filter((d) => changedKeys(before[d], merged[d]).length);
    if (changed.length) {
      await audit(this.prisma, {
        entityType: 'DOC_TEMPLATE',
        entityId: DOCS_KEY,
        summary: `Баримтын загвар: ${changed.map((d) => `${DOC_NAMES[d]} (${fieldNames(changedKeys(before[d], merged[d]))})`).join('; ')}`,
        before: Object.fromEntries(changed.map((d) => [d, before[d]])),
        after: Object.fromEntries(changed.map((d) => [d, merged[d]])),
        actorId,
      });
    }
    const json = merged as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: DOCS_KEY },
      create: { key: DOCS_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Document templates updated by ${actorId}`);
    return merged;
  }

  /**
   * Measuring units for the product form: the saved list (the defaults until one is saved), then any unit
   * still written on an active product but missing from it, so an old product's unit always shows.
   */
  /**
   * `units`: the shop's list (what the settings page edits). `inUse`: units still written on active products
   * but not on the list (older English ones such as "bag") — offered in the product form, never saved into the list.
   */
  async units(): Promise<{ units: string[]; inUse: string[] }> {
    const saved = await this.savedUnits();
    const rows = await this.prisma.product.findMany({ where: { active: true }, select: { unit: true }, distinct: ['unit'] });
    const listed = new Set(saved);
    const legacy = [...new Set(rows.map((r) => r.unit).filter((u) => u && u.trim() && !listed.has(u)))].sort((a, b) =>
      a.localeCompare(b),
    );
    return { units: saved, inUse: legacy };
  }

  /** Replaces the saved list (the settings page). */
  async setUnits(list: string[], actorId: string) {
    const units = this.validUnits(list);
    const before = await this.savedUnits();
    if (JSON.stringify(before) !== JSON.stringify(units)) {
      const added = units.filter((u) => !before.includes(u));
      const removed = before.filter((u) => !units.includes(u));
      const detail = [added.length ? `нэмсэн ${added.join(', ')}` : '', removed.length ? `хассан ${removed.join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      await audit(this.prisma, {
        entityType: 'SETTINGS',
        entityId: UNITS_KEY,
        summary: `Хэмжих нэгжийн жагсаалт: ${detail || 'дараалал өөрчилсөн'}`,
        before: { units: before },
        after: { units },
        actorId,
      });
    }
    const json = units as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: UNITS_KEY },
      create: { key: UNITS_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Measuring units updated by ${actorId}`);
    return this.units();
  }

  /** Adds one unit to the end of the saved list ('+ шинэ нэгж' in the product form); already there = no change. */
  async addUnit(unit: string, actorId: string) {
    const [clean] = this.validUnits([unit]);
    if (!clean) throw new BadRequestException('Хэмжих нэгжээ оруулна уу / unit is required');
    const saved = await this.savedUnits();
    if (saved.some((u) => u.toLowerCase() === clean.toLowerCase())) return this.units();
    return this.setUnits([...saved, clean], actorId);
  }

  private async savedUnits(): Promise<string[]> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: UNITS_KEY } });
    return Array.isArray(row?.value) ? cleanUnits(row.value) : [...DEFAULT_UNITS];
  }

  private validUnits(list: unknown[]): string[] {
    const units = cleanUnits(list);
    const long = units.find((u) => u.length > UNIT_MAX_LENGTH);
    if (long) throw new BadRequestException(`«${long}»: хэмжих нэгж 16 тэмдэгтээс ихгүй / A unit can be at most 16 characters`);
    if (units.length > UNITS_MAX) throw new BadRequestException('Хэмжих нэгж 60-аас ихгүй / At most 60 units');
    return units;
  }

  /**
   * Product categories for the product form: the saved list (the defaults until one is saved), then any category
   * still written on an active product but missing from it, so an existing product's category always shows.
   */
  /**
   * `categories`: the shop's list (what the settings page edits). `inUse`: categories still written on active
   * products but not on the list — offered in the product form too, never saved into the list by itself.
   */
  async categories(): Promise<{ categories: string[]; inUse: string[] }> {
    const saved = await this.savedCategories();
    const rows = await this.prisma.product.findMany({ where: { active: true }, select: { category: true }, distinct: ['category'] });
    const listed = new Set(saved.map((c) => c.toLowerCase()));
    const legacy: string[] = [];
    for (const row of rows) {
      const category = typeof row.category === 'string' ? row.category.trim() : '';
      if (!category || isGeneral(category) || listed.has(category.toLowerCase())) continue;
      listed.add(category.toLowerCase());
      legacy.push(category);
    }
    return { categories: saved, inUse: legacy.sort((a, b) => a.localeCompare(b)) };
  }

  /** Replaces the saved list (the settings page). Products keep the category they were saved with. */
  async setCategories(list: string[], actorId: string) {
    const categories = this.validCategories(list);
    const before = await this.savedCategories();
    if (JSON.stringify(before) !== JSON.stringify(categories)) {
      const added = categories.filter((c) => !before.includes(c));
      const removed = before.filter((c) => !categories.includes(c));
      const detail = [added.length ? `нэмсэн ${added.join(', ')}` : '', removed.length ? `хассан ${removed.join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      await audit(this.prisma, {
        entityType: 'SETTINGS',
        entityId: CATEGORIES_KEY,
        summary: `Барааны ангиллын жагсаалт: ${detail || 'дараалал өөрчилсөн'}`,
        before: { categories: before },
        after: { categories },
        actorId,
      });
    }
    const json = categories as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: CATEGORIES_KEY },
      create: { key: CATEGORIES_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Product categories updated by ${actorId}`);
    return this.categories();
  }

  /** Adds one category to the end of the saved list ('+ шинэ ангилал' in the product form); already there = no change. */
  async addCategory(category: string, actorId: string) {
    if (isGeneral((category ?? '').trim())) {
      throw new BadRequestException('«General» ангилал болохгүй, тодорхой ангилал бичнэ үү / "General" is not a category');
    }
    const [clean] = this.validCategories([category]);
    if (!clean) throw new BadRequestException('Ангиллаа оруулна уу / category is required');
    const saved = await this.savedCategories();
    if (saved.some((c) => c.toLowerCase() === clean.toLowerCase())) return this.categories();
    return this.setCategories([...saved, clean], actorId);
  }

  private async savedCategories(): Promise<string[]> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: CATEGORIES_KEY } });
    return Array.isArray(row?.value) ? cleanCategories(row.value) : [...DEFAULT_CATEGORIES];
  }

  private validCategories(list: unknown[]): string[] {
    const categories = cleanCategories(list);
    const long = categories.find((c) => c.length > CATEGORY_MAX_LENGTH);
    if (long) throw new BadRequestException(`«${long}»: ангилал 60 тэмдэгтээс ихгүй / A category can be at most 60 characters`);
    if (categories.length > CATEGORIES_MAX) throw new BadRequestException('Ангилал 100-аас ихгүй / At most 100 categories');
    return categories;
  }
}
