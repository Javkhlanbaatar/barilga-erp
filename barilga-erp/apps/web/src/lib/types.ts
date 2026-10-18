import { matchesSearch } from './translit';
export type Role = 'ADMIN' | 'SUPER_MANAGER' | 'MANAGER' | 'BORLUULAGCH' | 'ACHIGCH_BELTGEGCH';

export type AuthUser = {
  id: string;
  email?: string | null;
  username?: string;
  name: string;
  fullName?: string;
  role: Role;
  isActive?: boolean;
  /** Warehouse/shop the user is assigned to (null/undefined = not assigned). */
  warehouseId?: string | null;
};

export type WarehouseKind = 'SHOP' | 'WAREHOUSE';
export const WAREHOUSE_KIND_LABEL: Record<WarehouseKind, string> = { SHOP: 'Дэлгүүр', WAREHOUSE: 'Агуулах' };

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  isActive: boolean;
  isDefault: boolean;
  kind?: WarehouseKind;
  /** Admin listing only: who works here and which branch managers oversee it. */
  users?: Array<{ id: string; fullName: string; role: Role }>;
  managers?: Array<{ user: { id: string; fullName: string; role: Role } }>;
};

export type StaffUser = {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  name?: string;
  phone?: string | null;
  role: Role;
  isActive: boolean;
  active?: boolean;
  warehouseId?: string | null;
  warehouse?: { id: string; code: string; name: string } | null;
  /** Branch manager: further warehouses they oversee. */
  managedWarehouses?: Array<{ id: string; code: string; name: string }>;
  createdAt: string;
  updatedAt?: string;
};

export type Zone = {
  id: string;
  code: string;
  nameMn: string;
  nameEn: string;
  description: string;
  baseDeliveryFeeMnt: number;
  nightDiscountApplies: boolean;
  active: boolean;
};

export type Vehicle = {
  id: string;
  code: string;
  nameMn: string;
  nameEn: string;
  maxWeightKg: number;
  maxLengthM: number;
  maxVolumeM3: number;
};

export type Product = {
  id: string;
  sku: string;
  /** Scanned at the till: manufacturer code or an in-store 200… EAN-13. */
  barcode?: string | null;
  nameMn: string;
  nameEn: string;
  unit: string;
  priceMnt: number;
  weightKg: number;
  lengthM: number;
  volumeM3: number;
  stockQty: number;
  minStockLevel?: number;
  imageUrl?: string | null;
  description?: string | null;
  category?: string;
  active?: boolean;
  /** Items handed over with every unit (e.g. a hardener with resin paint). */
  companions?: Companion[] | null;
};

export type Companion = { name: string; qtyPerUnit: number; unit: string };

/** "Хатаагч × 2 ш" lines for a quantity of a product with companions. */
export function companionLines(companions: Companion[] | null | undefined, quantity: number) {
  return (companions ?? []).map((c) => {
    const n = Math.round(c.qtyPerUnit * quantity * 1000) / 1000;
    return `${c.name} × ${n.toLocaleString('mn-MN', { maximumFractionDigits: 3 })} ${c.unit}`;
  });
}

export function productMatchesQuery(
  p: { sku?: string; nameMn?: string; nameEn?: string; description?: string | null; barcode?: string | null },
  q: string,
) {
  if (p.barcode && p.barcode === q.trim()) return true;
  // Same rule as the server's product search: either alphabet, any case.
  return matchesSearch([p.sku, p.nameMn, p.nameEn, p.description ?? ''].join(' '), q);
}

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'NEGATIVE_STOCK';

export type StockItem = {
  id: string;
  sku: string;
  nameMn: string;
  nameEn: string;
  unit: string;
  active: boolean;
  stockQty: number;
  minStockLevel: number;
  imageUrl?: string | null;
  description?: string | null;
  category?: string;
  priceMnt?: number;
  weightKg?: number;
  lengthM?: number;
  volumeM3?: number;
  lowStock: boolean;
  status: StockStatus;
  /** Quantity per warehouse (the stockQty above is the selected warehouse, or the total). */
  warehouses?: Array<{ warehouseId: string; code: string; name: string; quantity: number }>;
};

export type StockMovement = {
  id: string;
  type: 'OPENING' | 'SALE' | 'RETURN' | 'RECEIPT' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'ADJUSTMENT' | 'RECONCILE';
  quantityDelta: number | string;
  balanceAfter: number | string;
  refType?: string | null;
  refId?: string | null;
  reason?: string | null;
  createdAt: string;
  product?: { sku: string; nameMn: string; unit: string };
  warehouse?: { code: string; name: string };
  actor?: { fullName: string } | null;
};

export type StockReport = {
  warehouseId?: string | null;
  warehouses?: Array<{ id: string; code: string; name: string; isDefault: boolean }>;
  items: StockItem[];
  summary: {
    total: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    negativeStock?: number;
  };
};

export type ReconciliationReport = {
  products: StockItem[];
  lines: Array<{
    orderId: string;
    orderNumber: string;
    orderStatus: string;
    customerName: string;
    orderItemId: string;
    productId: string;
    sku: string;
    nameMn: string;
    remainingQty: number;
    unitPrice: number;
    amountMnt: number;
    currentStock: number;
  }>;
  summary: { negativeProducts: number; unassignedLines: number };
};

export function productStockStatus(p: { stockQty: number; minStockLevel?: number }): StockStatus {
  const qty = Number(p.stockQty);
  const min = Number(p.minStockLevel ?? 0);
  if (qty < 0) return 'NEGATIVE_STOCK';
  if (qty === 0) return 'OUT_OF_STOCK';
  if (qty <= min) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export type PaymentSplit = {
  id: string;
  method?: string;
  provider?: string;
  status: string;
  amountMnt: number;
  qpayInvoiceId?: string | null;
  qpayQrText?: string | null;
  qpayQrImage?: string | null;
};

export type Order = {
  id: string;
  orderNumber: string;
  status: 'PENDING_PAYMENT' | 'READY_FOR_LOADING' | 'COMPLETED' | 'CANCELLED';
  customerName: string;
  customerPhone: string;
  warehouse?: { id: string; code: string; name: string } | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  deliveryMethod: string;
  timeCondition: string;
  unloadingRequested: boolean;
  assignedVehicle?: string | null;
  driverName?: string | null;
  vehicleNumber?: string | null;
  driverPhone?: string | null;
  trackingToken?: string | null;
  totalWeightKg: number;
  maxLengthM: number;
  totalVolumeM3: number;
  subtotalMnt: number;
  deliveryFeeMnt: number;
  unloadingFeeMnt: number;
  timeAdjustmentMnt: number;
  totalMnt: number;
  feesOverridden: boolean;
  zone: Zone;
  items: Array<{
    id: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    sourceType?: 'INTERNAL' | 'EXTERNAL_SUPPLIER';
    supplierName?: string | null;
    /** Picking checklist: when and by whom this line was ticked as prepared. */
    pickedAt?: string | null;
    pickedBy?: { id: string; fullName: string } | null;
    product: Product;
  }>;
  returns?: Array<{
    id: string;
    reason: string;
    refundAmount: number;
    refundMethod: 'CASH' | 'QPAY' | 'CARD' | 'TRANSFER' | 'CREDIT';
    /** Cash and debt refunds are done at once; card and transfer ones until a manager marks them sent. */
    refundStatus?: 'PENDING_PAYOUT' | 'PAID_OUT';
    refundAccount?: string | null;
    paidOutAt?: string | null;
    createdAt: string;
    ebarimtRefundId?: string | null;
    ebarimtStatus?: string | null;
    items: Array<{ quantity: number; lineRefund: number; orderItemId: string }>;
  }>;
  supplierPayables?: Array<{
    id: string;
    supplierName: string;
    amountMnt: number;
    quantity: number;
    status: string;
  }>;
  stockReconciliations?: Array<{
    id: string;
    supplierName: string;
    quantityRestored: number;
    stockBefore: number;
    stockAfter: number;
    amountMnt: number;
    reason?: string | null;
    createdAt: string;
    actor: { name?: string; fullName?: string; role: string };
  }>;
  payments?: PaymentSplit[];
  payment?: PaymentSplit | null;
  feeOverrides?: Array<{
    id: string;
    reason: string;
    previousTotal: number;
    newTotal: number;
    createdAt: string;
    actor: { name?: string; fullName?: string; role: string };
  }>;
  createdAt?: string;
  createdBy: { name?: string; fullName?: string; role: string };
  completedBy?: { name?: string; fullName?: string; role: string } | null;
  completedAt?: string | null;
  preparedBy?: { id?: string; name?: string; fullName?: string; role: string } | null;
  preparedById?: string | null;
  preparedAt?: string | null;
  /** Set when someone pressed «Би бэлдье» (or ticked the first line). */
  pickingStartedAt?: string | null;
  pickingStartedBy?: { id: string; fullName: string } | null;
  billType?: 'CITIZEN' | 'COMPANY';
  customerRegNumber?: string | null;
  receiptId?: string | null;
  lottery?: string | null;
  qrCode?: string | null;
  ebarimtStatus?: 'NOT_ISSUED' | 'PENDING' | 'ISSUED' | 'FAILED';
  ebarimtError?: string | null;
  ebarimtIssuedAt?: string | null;
};

export function ebarimtStatusLabel(status?: string | null) {
  if (status === 'ISSUED') return 'Амжилттай';
  if (status === 'FAILED') return 'Амжилтгүй';
  if (status === 'PENDING') return 'Хүлээгдэж байна';
  return 'Олгоогүй';
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Төлбөр хүлээж буй',
  READY_FOR_LOADING: 'Бэлтгэх / ачихад бэлэн',
  COMPLETED: 'Олгосон',
  CANCELLED: 'Цуцалсан',
};

export const VEHICLE_LABEL: Record<string, string> = {
  PORTER: 'Porter (≤1.5t)',
  DUMP: 'Dump (≤5t)',
  MANIPULATOR: 'Manipulator (≤10t)',
};

export const DELIVERY_LABEL: Record<string, string> = {
  OUR_DELIVERY: 'Манай хүргэлт',
  DELIVERY: 'Манай хүргэлт',
  SELF_PICKUP: 'Өөрөө авна',
  CUSTOMER_DRIVER: 'Харилцагчийн жолооч',
};

export function isHiredTransport(method?: string | null) {
  return method === 'OUR_DELIVERY' || method === 'DELIVERY';
}

export type DailyReport = {
  range: { startDate: string; endDate: string; startAt: string; endAt: string; timeZone: string };
  cashier: { id: string; name: string; fullName?: string; username?: string; email: string | null } | null;
  totals: {
    revenueMnt: number;
    cashMnt: number;
    qpayMnt: number;
    cardMnt: number;
    transferMnt?: number;
    pendingMnt: number;
    deliveryFeesMnt: number;
    unloadingFeesMnt: number;
    refundsMnt?: number;
    netRevenueMnt?: number;
    orderCount: number;
  };
  refunds?: {
    totalMnt: number;
    cashMnt: number;
    qpayMnt: number;
    cardMnt: number;
    count: number;
  };
  payments: Array<{
    method: 'CASH' | 'QPAY' | 'CARD' | 'TRANSFER';
    grossMnt?: number;
    paidMnt: number;
    pendingMnt: number;
    paidCount: number;
  }>;
  logistics: {
    deliveryFeesMnt: number;
    unloadingFeesMnt: number;
    timeAdjustmentMnt: number;
  };
  topProducts: Array<{
    productId: string;
    sku: string;
    nameMn: string;
    nameEn: string;
    quantity: number;
    amountMnt: number;
  }>;
  ordersByStatus: {
    COMPLETED: number;
    PENDING_PAYMENT: number;
    READY_FOR_LOADING: number;
    CANCELLED: number;
  };
  ebarimt?: {
    issued: number;
    failed: number;
    pending: number;
    receipts: Array<{
      orderNumber: string;
      lottery: string | null;
      receiptId: string | null;
      billType: string;
      totalMnt: number;
    }>;
  };
};

export type Attendance = {
  id: string;
  userId: string;
  checkIn: string;
  checkOut: string | null;
  status: 'ON_TIME' | 'LATE' | 'OVERTIME';
  notes?: string | null;
  user?: { id: string; fullName: string; username: string; role: Role };
};

export type AttendanceBoard = {
  timeZone: string;
  date: string;
  staff: Array<{
    id: string;
    fullName: string;
    username: string;
    role: Role;
    open: Attendance | null;
  }>;
  recent: Attendance[];
};

export type PayrollSettings = {
  defaultBaseMnt: Record<Role, number>;
  ticketBonusMnt: number;
  salesCommissionPct: number;
  prorateByAttendance: boolean;
  workDaysPerWeek: number;
  socialInsurancePct: number;
  incomeTaxPct: number;
};

export type PayrollRow = {
  id: string;
  userId: string;
  periodMonth: string;
  baseSalary: number;
  customBase: boolean;
  earnedBase: number;
  workedDays: number;
  workingDays: number;
  ticketCount: number;
  ticketBonus: number;
  salesAmountMnt: number;
  salesBonus: number;
  adjustmentsMnt: number;
  bonusMnt: number;
  deductionMnt: number;
  grossSalary: number;
  socialInsuranceMnt: number;
  incomeTaxMnt: number;
  netSalary: number;
  status: 'DRAFT' | 'PAID';
  paidAt: string | null;
  adjustments: Array<{ id: string; amountMnt: number; reason: string; createdAt: string; by: string }>;
  user: { id: string; fullName: string; username: string; role: Role; isActive?: boolean };
};

export type PayrollReport = {
  periodMonth: string;
  timeZone: string;
  /** PAYROLL_FORMULA module: false = pay is base salary + bonuses − deductions entered by hand. */
  formula: boolean;
  settings: PayrollSettings;
  workingDays: number;
  totals: { base: number; bonus: number; deduction: number; gross: number; net: number; insurance: number; tax: number; paid: number; unpaid: number };
  rows: PayrollRow[];
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Админ',
  SUPER_MANAGER: 'Ерөнхий менежер',
  MANAGER: 'Салбарын менежер',
  BORLUULAGCH: 'Кассчин',
  ACHIGCH_BELTGEGCH: 'Агуулах',
};

// ───────── Phase 2B: customers, transfers, gathering, module switches ─────────

export type CustomerType = 'INDIVIDUAL' | 'COMPANY';

export type Customer = {
  id: string;
  type: CustomerType;
  name: string;
  phone: string;
  regNumber: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  priceListId?: string | null;
  /** What the partner is to us (managers set these). */
  buysFromUs?: boolean;
  creditAllowed?: boolean;
  sellsToUs?: boolean;
  barterContract?: string | null;
};

export type CustomerDetail = Customer & {
  priceList?: { id: string; name: string } | null;
  stats: { completedOrders: number; completedTotalMnt: number };
  recentOrders: Array<{ id: string; orderNumber: string; status: Order['status']; totalMnt: number; createdAt: string }>;
  /** Goods released on account and not yet paid for. */
  credit?: { owedMnt: number; orders: Array<{ orderId: string; orderNumber: string; totalMnt: number; owedMnt: number; createdAt: string }> };
};

export type PriceList = { id: string; name: string; notes: string | null; isActive: boolean; productCount?: number; customerCount?: number };

export type TransferStatus = 'REQUESTED' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';

type WarehouseRef = { id: string; code: string; name: string };
type PersonRef = { id: string; fullName: string } | null;

export type StockTransfer = {
  id: string;
  transferNumber: string;
  status: TransferStatus;
  fromWarehouse: WarehouseRef;
  toWarehouse: WarehouseRef;
  notes: string | null;
  order: { id: string; orderNumber: string } | null;
  requestedBy?: PersonRef;
  requestedAt?: string | null;
  sentBy: PersonRef;
  sentAt: string | null;
  hasShortage?: boolean;
  receivedBy: PersonRef;
  receivedAt: string | null;
  cancelledBy: PersonRef;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: Array<{
    id: string;
    quantity: string | number;
    requestedQty?: string | number | null;
    receivedQty?: string | number | null;
    shortageReason?: string | null;
    product: { id: string; sku: string; nameMn: string; unit: string };
  }>;
};

export type GatherPlan = {
  orderId: string;
  orderNumber: string;
  status: Order['status'];
  dispatchWarehouse: WarehouseRef;
  complete: boolean;
  lines: Array<{
    product: { id: string; sku?: string; nameMn?: string; unit?: string };
    needed: number;
    atDispatch: number;
    inTransit: number;
    toGather: number;
    unavailable: number;
  }>;
  transfers: Array<{ from?: WarehouseRef; items: Array<{ product: { id: string; sku?: string; nameMn?: string }; quantity: number }> }>;
};

export type FeatureKey =
  | 'CUSTOMERS'
  | 'STOCK_TRANSFERS'
  | 'STOCK_RECEIPTS'
  | 'PICKING'
  | 'WAREHOUSE_REPORT'
  | 'DELIVERY'
  | 'UNLOADING'
  | 'CREDIT_SALES'
  | 'PRICE_LISTS'
  | 'PARTNER_ACCOUNTS'
  | 'HR'
  | 'PAYROLL_FORMULA'
  | 'CASH_SESSIONS'
  | 'INVOICES'
  | 'EBARIMT'
  | 'ONLINE_SHOP';

export type FeatureSwitch = {
  key: FeatureKey;
  nameMn: string;
  enabled: boolean;
  isDefault: boolean;
  /** Not used by this business for now: always off and hidden from the module page. */
  dormant?: boolean;
  updatedAt: string | null;
};

/** Wording and empty spaces of one printed document (Админ → Компанийн мэдээлэл → Баримтын загвар). */
export type DocTemplate = {
  title: string;
  headerNote: string;
  footerNote: string;
  blankBuyer: boolean;
  blankRows: number;
  signatures: string[];
  stamp: boolean;
  showPrices: boolean;
  /** Optional parts switched off in the template editor (e.g. "cashier", "watermark"). */
  hidden: string[];
};
export type PrintDocKey = 'invoice' | 'receipt' | 'issueNote' | 'picklist';

/** Seller details printed on invoices and receipts (admin settings). */
export type CompanySettings = {
  name: string;
  regNumber: string;
  address: string;
  phone: string;
  email: string;
  bankAccounts: Array<{ bankName: string; accountNumber: string; accountName: string }>;
  invoiceNote: string;
  receiptFooter: string;
  /** Uploaded logo path (/uploads/company/…), '' when none. */
  logoUrl?: string;
  /** Print the logo faintly behind invoices and receipts. */
  watermark?: boolean;
  configured: boolean;
};

export type StockReceipt = {
  id: string;
  receiptNumber: string;
  warehouse: { id: string; code: string; name: string };
  supplierName: string;
  supplierInvoiceNo: string | null;
  supplierCustomer?: { id: string; name: string } | null;
  notes: string | null;
  receivedBy: { id: string; fullName: string } | null;
  receivedAt: string;
  items: Array<{
    id: string;
    quantity: string | number;
    unitCostMnt: number | null;
    product: { id: string; sku: string; nameMn: string; unit: string };
  }>;
};

export type WarehouseReport = {
  range: { startDate: string; endDate: string; timeZone: string };
  warehouse: { id: string; code: string; name: string } | null;
  lines: Array<{
    productId: string;
    sku: string;
    nameMn: string;
    unit: string;
    category: string;
    opening: number;
    receipts: number;
    transfersIn: number;
    transfersOut: number;
    sales: number;
    returns: number;
    adjustments: number;
    closing: number;
    minStockLevel: number;
    lowStock: boolean;
    valueAtPriceMnt: number;
    valueAtCostMnt: number | null;
  }>;
  totals: {
    products: number;
    receipts: number;
    transfersIn: number;
    transfersOut: number;
    sales: number;
    returns: number;
    adjustments: number;
    valueAtPriceMnt: number;
    lowStock: number;
  };
  inTransit: Array<{
    id: string;
    transferNumber: string;
    from: string;
    to: string;
    sentAt: string;
    items: Array<{ sku: string; nameMn: string; unit: string; quantity: number }>;
  }>;
};

/** Two-way partner account (харилцагчийн тооцоо). net > 0: they owe us; net < 0: we owe them. */
export type AccountStatement = {
  customer: { id: string; name: string; barterContract: string | null };
  receivableMnt: number;
  payableMnt: number;
  netMnt: number;
  lines: Array<{
    at: string;
    kind: 'ON_ACCOUNT' | 'PAID_BY_THEM' | 'RETURNED' | 'PURCHASE' | 'PAYMENT_TO_PARTNER' | 'OFFSET' | 'ADJUSTMENT';
    description: string;
    effectMnt: number;
    balanceMnt: number;
    orderId?: string;
    entryId?: string;
    editable?: boolean;
  }>;
};

export type InvoiceState = 'DRAFT' | 'SENT' | 'VIEWED' | 'PARTIAL' | 'OVERDUE' | 'PAID' | 'CANCELLED';

export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = {
  DRAFT: 'Илгээгээгүй',
  SENT: 'Илгээсэн',
  VIEWED: 'Харилцагч нээсэн',
  PARTIAL: 'Хэсэгчлэн төлсөн',
  OVERDUE: 'Хугацаа хэтэрсэн',
  PAID: 'Төлөгдсөн',
  CANCELLED: 'Цуцалсан',
};

export type Invoice = {
  id: string;
  invoiceNumber: string;
  orderId: string;
  customerId: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  dueDate: string | null;
  note: string | null;
  lastSentVia: string | null;
  sentAt: string | null;
  sendCount: number;
  viewedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  publicPath: string;
  /** Only on the single-order read, for building the link. */
  token?: string;
  paidMnt: number;
  owedMnt: number;
  state: InvoiceState;
  order: { id: string; orderNumber: string; status: string; totalMnt: number; customerName: string; customerPhone: string; createdAt: string };
  customer: { id: string; name: string; email: string | null } | null;
  createdBy: { id: string; fullName: string } | null;
};
