import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';

export type QpayInvoiceResult = {
  invoiceId: string;
  qrText: string;
  qrImage: string;
  raw: unknown;
  mock: boolean;
};

export type QpayCheckResult = {
  paid: boolean;
  /** Money the provider reports as PAID for the invoice; null when it cannot be determined. */
  paidAmountMnt: number | null;
  raw: unknown;
};

/**
 * Production must never silently fall back to local QPay invoices. Keep the error limited to
 * variable names so credentials cannot leak into logs or startup reports.
 */
export function assertProductionQpayConfig(config: ConfigService): void {
  const env = (config.get<string>('NODE_ENV') ?? '').trim().toLowerCase();
  if (env !== 'production') return;

  const problems: string[] = [];
  const mock = (config.get<string>('QPAY_MOCK') ?? '').trim().toLowerCase();
  if (mock !== 'false') problems.push('QPAY_MOCK must be false');

  for (const key of ['QPAY_USERNAME', 'QPAY_PASSWORD', 'QPAY_INVOICE_CODE', 'QPAY_CALLBACK_URL']) {
    if (!(config.get<string>(key) ?? '').trim()) problems.push(`${key} is required`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid production QPay configuration: ${problems.join(', ')}`);
  }
}

/**
 * Reads the paid amount out of a `/payment/check` response.
 * Field names (`rows[].payment_status`, `rows[].payment_amount`, `paid_amount`) are the ones this adapter
 * already relied on; they have NOT been verified against the official QPay documentation or a live response.
 * Fails closed: an unparseable PAID row yields null, which never confirms a payment.
 */
export function extractPaidAmountMnt(data: unknown): number | null {
  const body = (data ?? {}) as { rows?: unknown; paid_amount?: unknown };
  const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
  const paidRows = rows.filter((row) => String(row?.payment_status ?? '').toUpperCase() === 'PAID');
  if (paidRows.length > 0) {
    let sum = 0;
    for (const row of paidRows) {
      const amount = Number(row.payment_amount ?? row.paid_amount);
      if (!Number.isFinite(amount)) return null;
      sum += amount;
    }
    return sum;
  }
  const top = Number(body.paid_amount);
  if (Number.isFinite(top) && top > 0) return top;
  return 0;
}

/**
 * QPay v2 merchant API adapter.
 * QPAY_MOCK=true (or missing credentials) generates a local invoice so POS can run without merchant keys.
 */
@Injectable()
export class QpayClient {
  private readonly log = new Logger(QpayClient.name);
  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    assertProductionQpayConfig(config);
    this.http = axios.create({
      baseURL: this.config.get<string>('QPAY_BASE_URL') ?? 'https://merchant.qpay.mn/v2',
      timeout: 15_000,
    });
  }

  isMock(): boolean {
    const mock = this.config.get<string>('QPAY_MOCK');
    const user = this.config.get<string>('QPAY_USERNAME');
    return mock === 'true' || !user;
  }

  async createInvoice(params: {
    senderInvoiceNo: string;
    amount: number;
    description: string;
    callbackUrl: string;
  }): Promise<QpayInvoiceResult> {
    if (this.isMock()) {
      const invoiceId = `MOCK-${params.senderInvoiceNo}`;
      this.log.warn(`QPay mock invoice ${invoiceId} for ${params.amount} MNT`);
      return {
        invoiceId,
        qrText: `qpay://pay?invoice=${invoiceId}&amount=${params.amount}`,
        qrImage: this.placeholderQr(invoiceId),
        raw: { mock: true, ...params },
        mock: true,
      };
    }

    try {
      const token = await this.authenticate();
      const { data } = await this.http.post(
        '/invoice',
        {
          invoice_code: this.config.getOrThrow<string>('QPAY_INVOICE_CODE'),
          sender_invoice_no: params.senderInvoiceNo,
          invoice_receiver_code: 'terminal',
          invoice_description: params.description,
          amount: params.amount,
          callback_url: params.callbackUrl,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!data?.invoice_id) {
        throw new InternalServerErrorException('QPay invoice response missing invoice_id');
      }
      this.log.log(`QPay invoice ${data.invoice_id} created for ${params.senderInvoiceNo}`);
      return {
        invoiceId: data.invoice_id,
        qrText: data.qr_text,
        qrImage: data.qr_image,
        raw: data,
        mock: false,
      };
    } catch (err) {
      this.rethrow('createInvoice', err);
    }
  }

  /**
   * Ask QPay whether `invoiceId` is paid. This is the only place a payment may be confirmed:
   * `paid` is true only when the provider reports PAID money of at least `expectedAmountMnt`
   * on that exact invoice. Mock mode never confirms (use simulate-paid in development).
   */
  async checkPayment(invoiceId: string, expectedAmountMnt: number): Promise<QpayCheckResult> {
    if (this.isMock()) {
      return { paid: false, paidAmountMnt: null, raw: { mock: true, invoiceId } };
    }
    try {
      const token = await this.authenticate();
      const { data } = await this.http.post(
        '/payment/check',
        { object_type: 'INVOICE', object_id: invoiceId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const paidAmountMnt = extractPaidAmountMnt(data);
      const paid = paidAmountMnt !== null && paidAmountMnt >= expectedAmountMnt;
      if (!paid && paidAmountMnt === null) {
        this.log.warn(`QPay check for ${invoiceId}: paid amount could not be determined from the response`);
      } else if (!paid && paidAmountMnt > 0) {
        this.log.warn(
          `QPay check for ${invoiceId}: provider paid ${paidAmountMnt} < expected ${expectedAmountMnt}; not confirming`,
        );
      }
      return { paid, paidAmountMnt, raw: data };
    } catch (err) {
      this.rethrow('checkPayment', err);
    }
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.token;
    }
    const username = this.config.getOrThrow<string>('QPAY_USERNAME');
    const password = this.config.getOrThrow<string>('QPAY_PASSWORD');
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    const { data } = await this.http.post(
      '/auth/token',
      { grant_type: 'client_credentials' },
      { headers: { Authorization: `Basic ${basic}` } },
    );
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token!;
  }

  private rethrow(op: string, err: unknown): never {
    const ax = err as AxiosError;
    const detail = ax.response?.data ?? ax.message ?? String(err);
    this.log.error(`QPay ${op} failed: ${JSON.stringify(detail)}`);
    throw new InternalServerErrorException(`QPay ${op} failed`);
  }

  private placeholderQr(id: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
      <rect width="100%" height="100%" fill="#111"/>
      <text x="50%" y="45%" fill="#f5c518" text-anchor="middle" font-size="16">QPay MOCK</text>
      <text x="50%" y="62%" fill="#fff" text-anchor="middle" font-size="10">${id}</text>
    </svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
}
