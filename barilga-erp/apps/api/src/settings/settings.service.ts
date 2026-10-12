import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsDto } from './company.dto';

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

  async setCompany(dto: CompanySettingsDto, actorId: string) {
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
    };
    const json = value as unknown as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key: COMPANY_KEY },
      create: { key: COMPANY_KEY, value: json, updatedById: actorId },
      update: { value: json, updatedById: actorId },
    });
    this.log.log(`Company settings updated by ${actorId}`);
    return this.company();
  }
}
