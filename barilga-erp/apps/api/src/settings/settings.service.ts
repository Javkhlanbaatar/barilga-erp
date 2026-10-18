import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

export type PrintSettings = Record<PrintDoc, { paper: PaperSize; orientation: Orientation; copies: number }>;

const DEFAULT_PRINT: PrintSettings = {
  invoice: { paper: 'A4', orientation: 'portrait', copies: 1 },
  receipt: { paper: '80MM', orientation: 'portrait', copies: 1 },
  issueNote: { paper: 'A5', orientation: 'landscape', copies: 1 },
  picklist: { paper: 'A4', orientation: 'portrait', copies: 1 },
};

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
    const json = merged as unknown as Prisma.InputJsonValue;
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
    const json = merged as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: DOCS_KEY },
      create: { key: DOCS_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Document templates updated by ${actorId}`);
    return merged;
  }
}
