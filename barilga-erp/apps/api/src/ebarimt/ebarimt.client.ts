import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { randomBytes } from 'crypto';

export type EbarimtReceiptItem = {
  name: string;
  barCode: string;
  classificationCode: string;
  measureUnit: string;
  qty: number;
  unitPrice: number;
  totalAmount: number;
  totalVAT: number;
  totalCityTax: number;
};

export type EbarimtSendInput = {
  orderNumber: string;
  totalAmount: number;
  totalVAT: number;
  totalCityTax: number;
  billType: 'CITIZEN' | 'COMPANY';
  customerRegNumber?: string | null;
  customerName: string;
  items: EbarimtReceiptItem[];
  payments: Array<{ code: string; paidAmount: number }>;
};

export type EbarimtSendResult = {
  receiptId: string;
  lottery: string;
  qrData: string;
  mock: boolean;
  raw: unknown;
};

@Injectable()
export class EbarimtClient {
  private readonly log = new Logger(EbarimtClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get<string>('EBARIMT_POSAPI_URL') ?? 'http://localhost:7080',
      timeout: 12_000,
    });
  }

  isMock() {
    const mock = this.config.get<string>('EBARIMT_MOCK');
    return mock !== 'false';
  }

  merchantTin() {
    return this.config.get<string>('EBARIMT_MERCHANT_TIN') ?? '0000000';
  }

  async sendReceipt(input: EbarimtSendInput): Promise<EbarimtSendResult> {
    const body = this.buildPosapiBody(input);
    if (this.isMock()) {
      const receiptId = `EB-${input.orderNumber}-${Date.now().toString(36).toUpperCase()}`;
      const lottery = this.mockLottery();
      const qrData = JSON.stringify({
        id: receiptId,
        lottery,
        amount: input.totalAmount,
        tin: this.merchantTin(),
      });
      this.log.warn(`E-Barimt MOCK receipt ${receiptId} lottery=${lottery} for ${input.orderNumber}`);
      return { receiptId, lottery, qrData, mock: true, raw: { mock: true, body } };
    }

    const { data } = await this.http.put('/rest/receipt', body);
    const receiptId = String(data?.id ?? data?.receiptId ?? '');
    const lottery = String(data?.lottery ?? '');
    const qrData = String(data?.qrData ?? data?.qr ?? '');
    if (!receiptId) {
      throw new Error('POSAPI response missing receipt id');
    }
    this.log.log(`E-Barimt receipt ${receiptId} lottery=${lottery} for ${input.orderNumber}`);
    return { receiptId, lottery, qrData, mock: false, raw: data };
  }

  async returnReceipt(input: {
    orderNumber: string;
    receiptId?: string | null;
    amount: number;
    items: Array<{ name: string; qty: number; unitPrice: number; totalAmount: number }>;
  }): Promise<EbarimtSendResult> {
    if (this.isMock()) {
      const receiptId = `RF-${input.orderNumber}-${Date.now().toString(36).toUpperCase()}`;
      const lottery = this.mockLottery();
      this.log.warn(`E-Barimt MOCK refund ${receiptId} amount=${input.amount} for ${input.orderNumber}`);
      return {
        receiptId,
        lottery,
        qrData: JSON.stringify({ id: receiptId, type: 'RETURN', amount: input.amount }),
        mock: true,
        raw: { mock: true, originalReceiptId: input.receiptId, items: input.items },
      };
    }
    const { data } = await this.http.post('/rest/receipt/return', {
      id: input.receiptId,
      orderNumber: input.orderNumber,
      totalAmount: input.amount,
      items: input.items,
    });
    const receiptId = String(data?.id ?? data?.receiptId ?? '');
    if (!receiptId) throw new Error('POSAPI refund response missing receipt id');
    return {
      receiptId,
      lottery: String(data?.lottery ?? ''),
      qrData: String(data?.qrData ?? data?.qr ?? ''),
      mock: false,
      raw: data,
    };
  }

  buildPosapiBody(input: EbarimtSendInput) {
    const isCompany = input.billType === 'COMPANY';
    return {
      totalAmount: input.totalAmount,
      totalVAT: input.totalVAT,
      totalCityTax: input.totalCityTax,
      districtCode: this.config.get<string>('EBARIMT_DISTRICT_CODE') ?? '24',
      branchNo: this.config.get<string>('EBARIMT_BRANCH_NO') ?? '001',
      posNo: this.config.get<string>('EBARIMT_POS_NO') ?? '10000001',
      merchantTin: this.merchantTin(),
      type: isCompany ? 'B2B_RECEIPT' : 'B2C_RECEIPT',
      customerTin: isCompany ? input.customerRegNumber : null,
      customerName: isCompany ? input.customerName : null,
      consumerNo: isCompany ? null : undefined,
      items: input.items.map((item) => ({
        name: item.name,
        barCode: item.barCode,
        barCodeType: 'UNDEFINED',
        classificationCode: item.classificationCode,
        taxProductCode: '',
        measureUnit: item.measureUnit,
        qty: item.qty,
        unitPrice: item.unitPrice,
        totalAmount: item.totalAmount,
        totalVAT: item.totalVAT,
        totalCityTax: item.totalCityTax,
      })),
      payments: input.payments.map((p) => ({
        code: p.code,
        exchangeCode: 'MNT',
        paidAmount: p.paidAmount,
        status: 'PAID',
      })),
    };
  }

  private mockLottery() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const a = letters[randomBytes(1)[0] % letters.length];
    const b = letters[randomBytes(1)[0] % letters.length];
    const n = (100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)).toString();
    return `${a}${b}${n}`;
  }
}
