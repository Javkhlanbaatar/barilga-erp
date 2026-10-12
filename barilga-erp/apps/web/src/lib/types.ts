export type Role = 'ADMIN' | 'MANAGER' | 'BORLUULAGCH' | 'ACHIGCH_BELTGEGCH';

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

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  isActive: boolean;
  isDefault: boolean;
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
};

export function productMatchesQuery(
  p: { sku?: string; nameMn?: string; nameEn?: string; description?: string | null },
  q: string,
) {
  const term = q.trim().toLowerCase();
  if (!term) return true;
  return [p.sku, p.nameMn, p.nameEn, p.description].some((value) =>
    (value ?? '').toLowerCase().includes(term),
  );
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
    refundMethod: 'CASH' | 'QPAY' | 'CARD';
    /** PENDING_PAYOUT until money is actually handed back; no payout flow exists yet. */
    refundStatus?: 'PENDING_PAYOUT' | 'PAID_OUT';
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

export const VEHICLE_LABEL: Record<string, string> = {
  PORTER: 'Porter (≤1.5t)',
  DUMP: 'Dump (≤5t)',
  MANIPULATOR: 'Manipulator (≤10t)',
};

export const DELIVERY_LABEL: Record<string, string> = {
  OUR_DELIVERY: 'Hired transport',
  DELIVERY: 'Hired transport',
  SELF_PICKUP: 'Self pickup',
  CUSTOMER_DRIVER: 'Customer driver',
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
    method: 'CASH' | 'QPAY' | 'CARD';
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

export type PayrollReport = {
  periodMonth: string;
  timeZone: string;
  rates: { ticketBonusMnt: number; salesCommissionBps: number; baseSalary: Record<Role, number> };
  rows: Array<{
    id: string;
    userId: string;
    periodMonth: string;
    baseSalary: number;
    fulfillmentBonus: number;
    netSalary: number;
    status: 'DRAFT' | 'PAID';
    ticketCount: number;
    salesAmountMnt: number;
    ticketBonus: number;
    salesBonus: number;
    user: { id: string; fullName: string; username: string; role: Role };
  }>;
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Админ',
  MANAGER: 'Менежер',
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
};

export type CustomerDetail = Customer & {
  stats: { completedOrders: number; completedTotalMnt: number };
  recentOrders: Array<{ id: string; orderNumber: string; status: Order['status']; totalMnt: number; createdAt: string }>;
};

export type TransferStatus = 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';

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
  sentBy: PersonRef;
  sentAt: string;
  receivedBy: PersonRef;
  receivedAt: string | null;
  cancelledBy: PersonRef;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: Array<{ id: string; quantity: string | number; product: { id: string; sku: string; nameMn: string; unit: string } }>;
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
  | 'UNLOADING'
  | 'HR'
  | 'ONLINE_SHOP';

export type FeatureSwitch = {
  key: FeatureKey;
  nameMn: string;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: string | null;
};

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
  configured: boolean;
};

export type StockReceipt = {
  id: string;
  receiptNumber: string;
  warehouse: { id: string; code: string; name: string };
  supplierName: string;
  supplierInvoiceNo: string | null;
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
