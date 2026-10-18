'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CashDrawerBar } from '@/components/cash-drawer';
import { PosLookup } from '@/components/pos-lookup';
import { Shell } from '@/components/shell';
import { api, tugrik } from '@/lib/api';
import { CustomerPicker } from '@/components/customer-picker';
import { ProductImage } from '@/components/product-image';
import { useFeatures } from '@/lib/features';
import { AuthUser, Customer, Product, StockReport, VEHICLE_LABEL, Warehouse, Zone, companionLines, productMatchesQuery, productStockStatus } from '@/lib/types';
import { POS_ROLES, TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';

type PaymentMethod = 'QPAY' | 'CASH' | 'CARD' | 'TRANSFER' | 'CREDIT' | 'CONTRACT' | 'INVOICE';
type DeliveryType = 'OUR_DELIVERY' | 'SELF_PICKUP' | 'CUSTOMER_DRIVER';
/** A sale put on hold (хүлээлгэсэн): kept in this browser for this cashier until it is resumed or the day ends. */
type HeldSale = {
  id: string;
  at: string;
  label: string;
  lines: Array<{ productId: string; quantity: number; sourceType: 'INTERNAL' | 'EXTERNAL_SUPPLIER'; supplierName: string }>;
  customer: Customer | null;
  customerName: string;
  customerPhone: string;
};

const heldKey = (userId: string) => `pos_held_${userId}`;
const todayUb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date());

function readHeld(userId: string): HeldSale[] {
  try {
    const all = JSON.parse(localStorage.getItem(heldKey(userId)) ?? '[]') as HeldSale[];
    // Yesterday's held carts are dropped: prices and stock may have changed.
    return all.filter((h) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ulaanbaatar' }).format(new Date(h.at)) === todayUb());
  } catch {
    return [];
  }
}

function writeHeld(userId: string, held: HeldSale[]) {
  try {
    localStorage.setItem(heldKey(userId), JSON.stringify(held));
  } catch {
    // private window: holds last only for this page
  }
}

type CartLine = {
  product: Product;
  quantity: number;
  sourceType: 'INTERNAL' | 'EXTERNAL_SUPPLIER';
  supplierName: string;
};

type Quote = {
  /** Name of the customer's price list when one applied; null = retail prices. */
  priceList?: string | null;
  /** The price each line will be sold at. */
  lines?: Array<{ productId: string; unitPrice: number; lineTotal: number }>;
  breakdown: {
    assignedVehicle: string | null;
    subtotalMnt: number;
    deliveryFeeMnt: number;
    unloadingFeeMnt: number;
    timeAdjustmentMnt: number;
    totalMnt: number;
  };
};

function chipClass(active: boolean, activeCls: string) {
  return `py-2 px-1 text-xs font-medium rounded-lg border transition ${
    active ? activeCls : 'bg-slate-800 text-slate-300 border-slate-700'
  }`;
}

export default function CheckoutPOS() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // '' = let the server pick (my own warehouse, else the default one). Only sent when someone chooses.
  const [warehouseChoice, setWarehouseChoice] = useState('');
  const [myWarehouseId, setMyWarehouseId] = useState<string | null>(null);
  // Cashiers assigned to a warehouse can only sell from it; admin/manager may pick any.
  const [warehouseLocked, setWarehouseLocked] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  // The last single payment method this cashier used (cash until they pick another).
  const [paymentMethod, setPaymentMethodState] = useState<PaymentMethod>('CASH');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('pos_pay_method');
      if (saved === 'QPAY' || saved === 'CARD' || saved === 'TRANSFER') setPaymentMethodState(saved);
    } catch {
      // private window: start with cash
    }
  }, []);
  const setPaymentMethod = (m: PaymentMethod) => {
    setPaymentMethodState(m);
    try {
      if (m === 'CASH' || m === 'QPAY' || m === 'CARD' || m === 'TRANSFER') localStorage.setItem('pos_pay_method', m);
    } catch {
      // private window: not remembered
    }
  };
  const [paymentMode, setPaymentMode] = useState<'SINGLE' | 'SPLIT'>('SINGLE');
  const [splitCash, setSplitCash] = useState(0);
  const [splitCard, setSplitCard] = useState(0);
  const [splitQpay, setSplitQpay] = useState(0);
  const [splitCredit, setSplitCredit] = useState(0);
  const [splitTransfer, setSplitTransfer] = useState(0);
  const [splitContract, setSplitContract] = useState(0);
  const [splitInvoice, setSplitInvoice] = useState(0);
  /** What we owe the selected supply/barter partner — the most a contract sale can take. */
  const [partnerPayable, setPartnerPayable] = useState<number | null>(null);
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('SELF_PICKUP');
  const [zoneId, setZoneId] = useState('');
  const [time, setTime] = useState('STANDARD');
  const [isUnloading, setIsUnloading] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [billType, setBillType] = useState<'CITIZEN' | 'COMPANY'>('CITIZEN');
  const [customerRegNumber, setCustomerRegNumber] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const features = useFeatures();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanCode, setScanCode] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [scanFlash, setScanFlash] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  const productsRef = useRef<Product[]>([]);
  const cartAddRef = useRef<(p: Product) => void>(() => undefined);
  const holdRef = useRef<() => void>(() => undefined);
  const scanBuffer = useRef('');
  const [userId, setUserId] = useState('');
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [showHeld, setShowHeld] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [cashRefresh, setCashRefresh] = useState(0);

  const ourDelivery = deliveryType === 'OUR_DELIVERY';
  const selectedZone = zones.find((z) => z.id === zoneId);
  const lowStockProducts = products.filter((p) => productStockStatus(p) !== 'IN_STOCK');

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const role = raw ? (JSON.parse(raw) as AuthUser).role : null;
    const uid = raw ? (JSON.parse(raw) as AuthUser).id : '';
    setUserId(uid);
    if (uid) setHeld(readHeld(uid));
    if (!hasRole(role, POS_ROLES)) {
      router.replace(homeForRole(role));
      return;
    }
    const mine = (raw ? (JSON.parse(raw) as AuthUser).warehouseId : null) ?? null;
    setMyWarehouseId(mine);
    // Staff sell from their own shop; the general manager and admin may pick any (a branch manager picks among theirs; the API checks).
    setWarehouseLocked(!!mine && !hasRole(role, TOP_ROLES) && role !== 'MANAGER');
    api<Warehouse[]>('/inventory/warehouses')
      .then(setWarehouses)
      .catch(() => undefined);
    api<Zone[]>('/zones').then((z) => {
      setZones(z);
      if (z[0]) setZoneId(z[0].id);
    });
  }, [router]);

  // Load the full active catalog once. Search only filters the grid, so the barcode
  // scanner (which reads productsRef) still resolves any SKU while a search is active.
  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const role = raw ? (JSON.parse(raw) as AuthUser).role : null;
    if (!hasRole(role, POS_ROLES)) return;
    // Stock shown is the quantity in the warehouse this order will be taken from.
    const stockWarehouse = warehouseChoice || myWarehouseId || warehouses.find((w) => w.isDefault)?.id || '';
    Promise.all([
      api<Product[]>('/products'),
      stockWarehouse
        ? api<StockReport>(`/inventory/stock?warehouseId=${stockWarehouse}`).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([list, stock]) => {
        const qty = new Map((stock?.items ?? []).map((i) => [i.id, i.stockQty]));
        setProducts(list.map((p) => ({ ...p, stockQty: qty.get(p.id) ?? p.stockQty })));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Бараа ачаалж чадсангүй');
      });
  }, [warehouseChoice, myWarehouseId, warehouses]);

  const items = useMemo(
    () =>
      cart
        .filter((c) => c.quantity > 0)
        .map((c) => ({
          productId: c.product.id,
          quantity: c.quantity,
          sourceType: c.sourceType,
          supplierName: c.sourceType === 'EXTERNAL_SUPPLIER' ? c.supplierName || 'Өөр дэлгүүр' : undefined,
        })),
    [cart],
  );

  const unloadingOffered = features.enabled('UNLOADING');
  useEffect(() => {
    // Without delivery (or with the unloading service switched off) these options do not apply.
    if (!ourDelivery || !unloadingOffered) setIsUnloading(false);
    if (!ourDelivery) setTime('STANDARD');
  }, [ourDelivery, unloadingOffered]);

  useEffect(() => {
    if (!cart.length || (ourDelivery && !zoneId)) {
      setQuote(null);
      return;
    }
    setError('');
    api<Quote>('/orders/quote', {
      method: 'POST',
      body: JSON.stringify({
        zoneId: ourDelivery ? zoneId : undefined,
        deliveryMethod: deliveryType,
        timeCondition: time,
        unloadingRequested: ourDelivery && isUnloading,
        items,
        customerId: customer?.id,
      }),
    })
      .then(setQuote)
      .catch((err: unknown) => {
        setQuote(null);
        setError(err instanceof Error ? err.message : 'Тооцоо амжилтгүй');
      });
  }, [zoneId, deliveryType, time, isUnloading, ourDelivery, items, cart, customer]);

  function add(p: Product) {
    setCart((prev) => {
      const found = prev.find((l) => l.product.id === p.id);
      if (found) return prev.map((l) => (l.product.id === p.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { product: p, quantity: 1, sourceType: 'INTERNAL', supplierName: '' }];
    });
  }

  productsRef.current = products;
  cartAddRef.current = add;

  function applyScan(raw: string) {
    const code = raw.trim();
    if (!code) return;
    const match =
      productsRef.current.find((p) => p.barcode === code) ??
      productsRef.current.find((p) => p.sku.toLowerCase() === code.toLowerCase()) ??
      (productsRef.current.filter((p) => productMatchesQuery(p, code)).length === 1
        ? productsRef.current.find((p) => productMatchesQuery(p, code))
        : undefined);
    if (!match) {
      setError(`Ийм баркод / SKU-тай бараа алга: ${code}`);
      setScanFlash('');
      return;
    }
    cartAddRef.current(match);
    setError('');
    setScanFlash(`Нэмэгдлээ: ${match.sku} — ${match.nameMn}`);
    window.setTimeout(() => setScanFlash(''), 2500);
    setScanCode('');
    scanRef.current?.focus();
  }

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'F2') {
        e.preventDefault();
        setLookupOpen(true);
        return;
      }
      if (e.key === 'F8') {
        e.preventDefault();
        holdRef.current();
        return;
      }
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (inField && el !== scanRef.current) return;
      if (el === scanRef.current) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        applyScan(scanBuffer.current);
        scanBuffer.current = '';
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        scanBuffer.current += e.key;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const b = quote?.breakdown;
  const totalMnt = b?.totalMnt ?? 0;
  // Credit only for a customer a manager allowed; contract only for a supply/barter partner we owe money to.
  const creditOffered = features.enabled('CREDIT_SALES') && !!customer?.creditAllowed;
  const contractPartner = !!customer && (!!customer.sellsToUs || !!customer.barterContract);
  const contractOffered = features.enabled('PARTNER_ACCOUNTS') && contractPartner && (partnerPayable ?? 0) > 0;
  const deliveryOffered = features.enabled('DELIVERY');
  const invoiceOffered = features.enabled('INVOICES');
  const splitSum = splitCash + splitCard + splitQpay + splitTransfer + splitCredit + splitContract + splitInvoice;
  const linePrice = new Map((quote?.lines ?? []).map((l) => [l.productId, l]));
  const splitOk = paymentMode === 'SPLIT' && totalMnt > 0 && splitSum === totalMnt && splitSum > 0;

  function paymentsPayload() {
    if (paymentMode === 'SPLIT') {
      return [
        { method: 'CASH' as const, amount: splitCash, status: 'PAID' },
        { method: 'CARD' as const, amount: splitCard, status: 'PAID' },
        { method: 'QPAY' as const, amount: splitQpay, status: 'PENDING' },
        { method: 'TRANSFER' as const, amount: splitTransfer, status: 'PAID' },
        { method: 'CREDIT' as const, amount: splitCredit, status: 'PENDING' },
        { method: 'CONTRACT' as const, amount: splitContract, status: 'PAID' },
        { method: 'INVOICE' as const, amount: splitInvoice, status: 'PENDING' },
      ].filter((p) => p.amount > 0);
    }
    return [{ method: paymentMethod, amount: totalMnt, status: paymentMethod === 'QPAY' || paymentMethod === 'CREDIT' || paymentMethod === 'INVOICE' ? 'PENDING' : 'PAID' }];
  }

  /** Picking a registered customer fills the order snapshot (still editable); a company also sets the E-Barimt РД. */
  function pickCustomer(c: Customer | null) {
    setCustomer(c);
    setPartnerPayable(null);
    if (paymentMethod === 'CREDIT' || paymentMethod === 'CONTRACT') setPaymentMethod('CASH');
    setSplitCredit(0);
    setSplitContract(0);
    if (!c) {
      // Unlinking clears what the customer filled in, so the next sale cannot go out under their name or РД.
      setCustomerName('');
      setCustomerPhone('');
      setAddress('');
      setBillType('CITIZEN');
      setCustomerRegNumber('');
      return;
    }
    if ((c.sellsToUs || c.barterContract) && features.enabled('PARTNER_ACCOUNTS')) {
      api<{ payableMnt: number }>(`/accounts/${c.id}`)
        .then((st) => setPartnerPayable(st.payableMnt))
        .catch(() => setPartnerPayable(null));
    }
    setCustomerName(c.name);
    setCustomerPhone(c.phone);
    if (c.type === 'COMPANY' && c.regNumber) {
      setBillType('COMPANY');
      setCustomerRegNumber(c.regNumber);
    }
    if (c.address && !address) setAddress(c.address);
  }

  /** Puts the current cart aside so the next customer can be served; resume it later from the list. */
  function holdSale() {
    if (!cart.length || !userId) return;
    const label = customer?.name || customerName.trim() || `${cart.length} бараа · ${tugrik(quote?.breakdown.totalMnt ?? 0)}`;
    const entry: HeldSale = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      label,
      lines: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity, sourceType: l.sourceType, supplierName: l.supplierName })),
      customer,
      customerName,
      customerPhone,
    };
    const next = [entry, ...readHeld(userId)];
    writeHeld(userId, next);
    setHeld(next);
    setCart([]);
    pickCustomer(null);
    setScanFlash(`Хүлээлгэлээ: ${label}`);
  }

  function resumeSale(h: HeldSale) {
    if (cart.length && !window.confirm('Одоогийн сагсыг хүлээлгээд сонгосныг нээх үү?')) return;
    if (cart.length) holdSale();
    const rest = readHeld(userId).filter((x) => x.id !== h.id);
    writeHeld(userId, rest);
    setHeld(rest);
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = h.lines.filter((l) => byId.has(l.productId)).map((l) => ({ ...l, product: byId.get(l.productId)! }));
    setCart(lines);
    if (h.customer) pickCustomer(h.customer);
    setCustomerName(h.customerName);
    setCustomerPhone(h.customerPhone);
    setShowHeld(false);
    if (lines.length < h.lines.length) setError('Зарим бараа идэвхгүй болсон тул сагснаас хасагдлаа');
  }

  function dropHeld(id: string) {
    const rest = readHeld(userId).filter((x) => x.id !== id);
    writeHeld(userId, rest);
    setHeld(rest);
  }

  holdRef.current = holdSale;

  async function handleCheckout() {
    setBusy(true);
    setError('');
    try {
      const order = await api<{ id: string }>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: warehouseChoice || undefined,
          zoneId: ourDelivery ? zoneId : undefined,
          deliveryType: ourDelivery ? 'DELIVERY' : deliveryType,
          deliveryMethod: deliveryType,
          timeCondition: time,
          isUnloading: ourDelivery && isUnloading,
          unloadingRequested: ourDelivery && isUnloading,
          items,
          customerId: customer?.id,
          // A walk-in sale needs no name; the order still shows who it was for when one was typed.
          customerName: customerName.trim() || 'Энгийн харилцагч',
          customerPhone: customerPhone.trim(),
          deliveryAddress: address,
          billType,
          customerRegNumber: billType === 'COMPANY' ? customerRegNumber : undefined,
          payments: paymentsPayload(),
        }),
      });
      setCashRefresh((n) => n + 1);
      router.push(`/orders/${order.id}?new=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Захиалга үүсгэж чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  const usesQpay = paymentMode === 'SPLIT' ? splitQpay > 0 : paymentMethod === 'QPAY';
  // On account (зарлагаар): goods leave now, the customer pays later; only for a registered customer.
  const usesCredit = paymentMode === 'SPLIT' ? splitCredit > 0 : paymentMethod === 'CREDIT';
  const contractAmount = paymentMode === 'SPLIT' ? splitContract : paymentMethod === 'CONTRACT' ? totalMnt : 0;
  const contractOk = contractAmount === 0 || (contractOffered && contractAmount <= (partnerPayable ?? 0) && !(paymentMode === 'SPLIT' && splitCredit > 0));
  const confirmLabel = usesQpay
    ? paymentMode === 'SPLIT'
      ? `Баталгаажуулах + QPay ${tugrik(splitQpay)}`
      : 'Захиалга баталгаажуулах + QPay'
    : paymentMethod === 'CREDIT' && paymentMode === 'SINGLE'
      ? 'Дараа төлөхөөр олгох (зээл)'
      : paymentMethod === 'CONTRACT' && paymentMode === 'SINGLE'
      ? 'Гэрээгээр олгох (өглөгөөс хасна)'
      : paymentMethod === 'INVOICE' && paymentMode === 'SINGLE'
      ? 'Нэхэмжлэх үүсгэх (шилжүүлэг хүлээнэ)'
      : `Захиалга баталгаажуулах (${paymentMethod === 'CASH' ? 'Бэлэн мөнгө' : paymentMethod === 'CARD' ? 'Карт' : paymentMethod === 'TRANSFER' ? 'Шилжүүлэг' : 'хувааж'})`;
  const usesInvoice = paymentMode === 'SPLIT' ? splitInvoice > 0 : paymentMethod === 'INVOICE';
  // Why the button is disabled, in words, so the cashier is never left guessing.
  const missing: string[] = [];
  if (!cart.length) missing.push('бараа нэмнэ үү');
  else if (!quote) missing.push('үнэ тооцоолж байна…');
  if (usesInvoice && !customerName.trim()) missing.push('нэхэмжлэхэд харилцагчийн нэр бичнэ үү');
  if (ourDelivery && (!customerName.trim() || !customerPhone.trim())) missing.push('хүргэлтэд нэр, утас бичнэ үү');
  if (paymentMode === 'SPLIT' && !splitOk) missing.push('хуваасан дүн нийт дүнтэй тэнцэх ёстой');
  if (usesCredit && !(creditOffered && customer)) missing.push('дараа төлөх эрхтэй харилцагч сонгоно уу');
  if (!contractOk) missing.push('гэрээгээр олгох дүн өглөгөөс хэтэрсэн');
  if (billType === 'COMPANY' && !/^[0-9A-Za-z]{7,12}$/.test(customerRegNumber.trim())) missing.push('байгууллагын РД (7–12 тэмдэгт)');
  const canSubmit = !busy && missing.length === 0;

  return (
    <Shell>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-bold text-amber-500">Борлуулагч — Шинэ захиалга</h2>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost text-sm" onClick={() => setLookupOpen(true)}>
                Лавлах (F2)
              </button>
              <button type="button" className="btn-ghost text-sm" disabled={!cart.length} onClick={holdSale}>
                Хүлээлгэх (F8)
              </button>
              {held.length > 0 && (
                <button type="button" className="btn-primary text-sm" onClick={() => setShowHeld((v) => !v)}>
                  Хүлээлгэсэн ({held.length})
                </button>
              )}
            </div>
          </div>
          {features.enabled('CASH_SESSIONS') && <CashDrawerBar refreshKey={cashRefresh} />}
          {showHeld && held.length > 0 && (
            <ul className="divide-y divide-slate-800 rounded-xl border border-slate-700 text-sm">
              {held.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>
                    <b>{h.label}</b>{' '}
                    <span className="text-xs text-slate-400">
                      · {h.lines.length} бараа · {new Intl.DateTimeFormat('mn-MN', { timeZone: 'Asia/Ulaanbaatar', hour: '2-digit', minute: '2-digit' }).format(new Date(h.at))}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className="btn-primary text-xs" onClick={() => resumeSale(h)}>
                      Нээх
                    </button>
                    <button type="button" className="btn-ghost text-xs" onClick={() => dropHeld(h.id)}>
                      Устгах
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {lookupOpen && <PosLookup products={products} onClose={() => setLookupOpen(false)} onAdd={(p) => add(p)} />}
          {warehouses.length > 1 && (
            <div className="text-xs text-slate-400">
              {warehouseLocked ? (
                <p>
                  Агуулах:{' '}
                  <span className="font-semibold text-slate-200">
                    {warehouses.find((w) => w.id === myWarehouseId)?.name ?? '—'}
                  </span>
                </p>
              ) : (
                <label className="block">
                  Агуулах / дэлгүүр (үлдэгдэл эндээс хасагдана)
                  <select className="mt-1 block min-w-[240px]" value={warehouseChoice} onChange={(e) => setWarehouseChoice(e.target.value)}>
                    <option value="">
                      Миний / анхдагч: {warehouses.find((w) => w.id === (myWarehouseId ?? ''))?.name ?? warehouses.find((w) => w.isDefault)?.name ?? '—'}
                    </option>
                    {warehouses
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({w.code})
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <label className="block text-xs text-slate-400">
            Нэр, тайлбар, SKU-гаар хайх
            <input
              className="mt-1 w-full"
              value={searchQuery}
              autoComplete="off"
              placeholder="жишээ: суурь, цемент, CEM-42"
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyScan(scanCode);
            }}
          >
            <label className="flex-1 min-w-[220px] text-xs text-slate-400">
              Баркод / SKU уншигч
              <input
                ref={scanRef}
                className="mt-1 w-full"
                value={scanCode}
                autoComplete="off"
                placeholder="Уншуулах эсвэл SKU бичээд Enter дарна"
                onChange={(e) => setScanCode(e.target.value)}
              />
            </label>
            <button type="submit" className="btn-ghost mt-5">
              Нэмэх
            </button>
          </form>
          {scanFlash && <p className="text-emerald-400 text-sm">{scanFlash}</p>}
          {lowStockProducts.length > 0 && (
            <div className="rounded-xl border border-amber-700 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
              Дуусч буй бараа: <b>{lowStockProducts.length}</b>{' '}
              <a href="/inventory" className="underline">
                үлдэгдэл харах
              </a>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {products.filter((p) => productMatchesQuery(p, searchQuery)).map((p) => {
              const status = productStockStatus(p);
              return (
              <button
                key={p.id}
                type="button"
                onClick={() => add(p)}
                className="p-4 bg-slate-900 border border-slate-800 rounded-xl text-left cursor-pointer hover:border-amber-500 transition overflow-hidden"
              >
                <ProductImage src={p.imageUrl} alt={p.nameMn} className="h-28 w-full rounded-lg mb-3" />
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">{p.sku}</p>
                  {status !== 'IN_STOCK' && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                        status === 'OUT_OF_STOCK' ? 'bg-red-800 text-red-100' : 'bg-amber-700 text-amber-100'
                      }`}
                    >
                      {status === 'OUT_OF_STOCK' ? 'Дууссан' : 'Дуусч буй'}
                    </span>
                  )}
                </div>
                <h3 className="font-semibold text-sm">{p.nameMn}</h3>
                {(p.companions ?? []).length > 0 && (
                  <p className="text-[11px] text-amber-300">+ {p.companions!.map((c) => c.name).join(', ')} дагалдана</p>
                )}
                {p.description && <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{p.description}</p>}
                <p className="text-amber-400 font-bold mt-2">
                  {tugrik(p.priceMnt)} / {p.unit}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  {Number(p.weightKg)}кг · үлдэгдэл {Number(p.stockQty)}
                </p>
              </button>
              );
            })}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-4 shadow-xl">
          <h3 className="text-lg font-bold border-b border-slate-800 pb-2">Сагс & Тооцоо</h3>

          {cart.length === 0 && <p className="text-slate-500 text-sm">Бараа сонгоно уу.</p>}
          {cart.map((l) => (
            <div key={l.product.id} className="space-y-1 border-b border-slate-800 pb-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {l.product.nameMn}
                  {companionLines(l.product.companions, l.quantity).map((c) => (
                    <span key={c} className="block text-[11px] text-amber-300">+ {c}</span>
                  ))}
                  {linePrice.get(l.product.id) && linePrice.get(l.product.id)!.unitPrice !== l.product.priceMnt && (
                    <span className="block text-[11px] text-emerald-300">
                      {tugrik(linePrice.get(l.product.id)!.unitPrice)} <span className="line-through text-slate-500">{tugrik(l.product.priceMnt)}</span>
                    </span>
                  )}
                </span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  className="w-20 bg-slate-950 border border-slate-700 rounded-lg p-1 text-sm"
                  value={l.quantity}
                  onChange={(e) => setCart((prev) => prev.map((x) => (x.product.id === l.product.id ? { ...x, quantity: Number(e.target.value) } : x)))}
                  // Leaving the field at 0 (or empty) removes the line instead of silently dropping it.
                  onBlur={() => setCart((prev) => prev.filter((x) => !(x.product.id === l.product.id && !(x.quantity > 0))))}
                />
                <button type="button" className="text-red-400" onClick={() => setCart((p) => p.filter((x) => x.product.id !== l.product.id))}>
                  ×
                </button>
              </div>
              {/* Only when this warehouse cannot cover the quantity: then say where the goods come from. */}
              {(l.quantity > Number(l.product.stockQty) || l.sourceType === 'EXTERNAL_SUPPLIER') && (
              <label className="flex items-center gap-2 text-[11px] text-amber-300">
                <input
                  type="checkbox"
                  checked={l.sourceType === 'EXTERNAL_SUPPLIER'}
                  onChange={(e) =>
                    setCart((prev) =>
                      prev.map((x) =>
                        x.product.id === l.product.id
                          ? {
                              ...x,
                              sourceType: e.target.checked ? 'EXTERNAL_SUPPLIER' : 'INTERNAL',
                              supplierName: e.target.checked ? x.supplierName || 'Өөр дэлгүүр' : '',
                            }
                          : x,
                      ),
                    )
                  }
                />
                Үлдэгдэл хүрэхгүй ({Number(l.product.stockQty)}) — өөр газраас авна
              </label>
              )}
              {l.sourceType === 'EXTERNAL_SUPPLIER' && (
                <input
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-1 text-xs"
                  placeholder="Хаанаас авах (нийлүүлэгч / дэлгүүр)"
                  value={l.supplierName}
                  onChange={(e) =>
                    setCart((prev) =>
                      prev.map((x) => (x.product.id === l.product.id ? { ...x, supplierName: e.target.value } : x)),
                    )
                  }
                />
              )}
            </div>
          ))}

          {/* Delivery is opt-in: unticked = the customer collects the goods themselves. Hidden while the module is off. */}
          {deliveryOffered && (
          <label className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={ourDelivery}
              onChange={(e) => setDeliveryType(e.target.checked ? 'OUR_DELIVERY' : 'SELF_PICKUP')}
              className="rounded bg-slate-950 border-slate-700 text-amber-500 focus:ring-0"
            />
            <span className="font-semibold">Хүргэлт хийлгэх</span>
          </label>
          )}

          {ourDelivery && (
            <div className="space-y-3 rounded-lg border border-amber-700/50 p-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Хүргэлтийн бүс</label>
                <select
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-slate-200"
                >
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.nameMn} ({tugrik(z.baseDeliveryFeeMnt)})
                    </option>
                  ))}
                </select>
              </div>

              {features.enabled('UNLOADING') && (
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="unloading"
                    checked={isUnloading}
                    onChange={(e) => setIsUnloading(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-700 text-amber-500 focus:ring-0"
                  />
                  <label htmlFor="unloading" className="text-xs text-slate-300">
                    Буулгалт хийх (15,000₮/тн, мин 15,000₮)
                  </label>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-400">Цагийн нөхцөл</label>
                <select
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm text-slate-200"
                >
                  <option value="STANDARD">Энгийн</option>
                  <option value="NIGHT">Шөнө (−10%, хөдөө биш)</option>
                  <option value="EXPRESS">Яаралтай (+30–50%)</option>
                </select>
              </div>
            </div>
          )}

          {features.enabled('CUSTOMERS') && <CustomerPicker value={customer} onChange={pickCustomer} />}
          <input
            placeholder="Харилцагчийн нэр (заавал биш)"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />
          <input
            placeholder="Утас (заавал биш)"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
          />

          {(features.enabled('EBARIMT') || billType === 'COMPANY' || usesInvoice) && (
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400">{features.enabled('EBARIMT') ? 'И-Баримт' : 'Худалдан авагч (нэхэмжлэхэд)'}</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setBillType('CITIZEN')}
                className={chipClass(billType === 'CITIZEN', 'bg-amber-500 text-slate-950 border-amber-500 font-bold')}
              >
                Хувь хүн
              </button>
              <button
                type="button"
                onClick={() => setBillType('COMPANY')}
                className={chipClass(billType === 'COMPANY', 'bg-amber-500 text-slate-950 border-amber-500 font-bold')}
              >
                Байгууллага
              </button>
            </div>
            {billType === 'COMPANY' && (
              <input
                placeholder="Байгууллагын РД"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                value={customerRegNumber}
                onChange={(e) => setCustomerRegNumber(e.target.value.trim())}
              />
            )}
          </div>
          )}
          {ourDelivery && (
            <input
              placeholder="Хүргэлтийн хаяг"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          )}

          <div className="space-y-1.5 pt-2 border-t border-slate-800">
            <label className="text-xs font-semibold text-slate-400">Төлбөрийн хэлбэр</label>
            <div className="grid grid-cols-2 gap-1.5 mb-2">
              <button type="button" onClick={() => setPaymentMode('SINGLE')} className={chipClass(paymentMode === 'SINGLE', 'bg-slate-100 text-slate-950 border-slate-100 font-bold')}>
                Нэг төлбөр
              </button>
              <button
                type="button"
                onClick={() => {
                  setPaymentMode('SPLIT');
                  setSplitCash(totalMnt);
                  setSplitCard(0);
                  setSplitQpay(0);
                  setSplitCredit(0);
                  setSplitTransfer(0);
                  setSplitContract(0);
                  setSplitInvoice(0);
                }}
                className={chipClass(paymentMode === 'SPLIT', 'bg-slate-100 text-slate-950 border-slate-100 font-bold')}
              >
                Хувааж төлөх
              </button>
            </div>
            {paymentMode === 'SINGLE' ? (
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => setPaymentMethod('QPAY')} className={chipClass(paymentMethod === 'QPAY', 'bg-indigo-600 text-white border-indigo-500 font-semibold')}>
                  QPay QR
                </button>
                <button type="button" onClick={() => setPaymentMethod('CASH')} className={chipClass(paymentMethod === 'CASH', 'bg-indigo-600 text-white border-indigo-500 font-semibold')}>
                  Бэлэн мөнгө
                </button>
                <button type="button" onClick={() => setPaymentMethod('CARD')} className={chipClass(paymentMethod === 'CARD', 'bg-indigo-600 text-white border-indigo-500 font-semibold')}>
                  Карт (POS)
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('TRANSFER')}
                  className={`col-span-3 ${chipClass(paymentMethod === 'TRANSFER', 'bg-indigo-600 text-white border-indigo-500 font-semibold')}`}
                >
                  Банкны шилжүүлэг (орсныг шалгасан)
                </button>
                {invoiceOffered && (
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('INVOICE')}
                    className={`col-span-3 ${chipClass(paymentMethod === 'INVOICE', 'bg-sky-700 text-white border-sky-500 font-semibold')}`}
                  >
                    Нэхэмжлэхээр — шилжүүлэг хүлээнэ (мөнгө орсны дараа олгоно)
                  </button>
                )}
                {creditOffered && (
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('CREDIT')}
                    className={`col-span-3 ${chipClass(paymentMethod === 'CREDIT', 'bg-amber-600 text-white border-amber-500 font-semibold')}`}
                  >
                    Дараа төлөх (зээлээр олгох)
                  </button>
                )}
                {contractOffered && (
                  <button
                    type="button"
                    disabled={totalMnt > (partnerPayable ?? 0)}
                    onClick={() => setPaymentMethod('CONTRACT')}
                    className={`col-span-3 disabled:opacity-40 ${chipClass(paymentMethod === 'CONTRACT', 'bg-emerald-700 text-white border-emerald-500 font-semibold')}`}
                  >
                    Гэрээгээр олгох — бидний өглөгөөс хасна ({tugrik(partnerPayable ?? 0)})
                  </button>
                )}
                {contractOffered && totalMnt > (partnerPayable ?? 0) && (
                  <p className="col-span-3 text-[11px] text-slate-400">Дүн өглөгөөс их байна — «Хувааж төлөх»-өөр үлдэгдлийг өөр хэлбэрээр авна.</p>
                )}
                {customer && !customer.creditAllowed && features.enabled('CREDIT_SALES') && (
                  <p className="col-span-3 text-[11px] text-slate-500">Энэ харилцагчид дараа төлөх эрх олгогдоогүй (Харилцагчид → менежер).</p>
                )}
              </div>
            ) : (
              <div className="space-y-2 text-xs">
                <label className="block text-slate-400">
                  Бэлэн мөнгө
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                    value={splitCash}
                    onChange={(e) => setSplitCash(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  />
                </label>
                <label className="block text-slate-400">
                  Карт (POS)
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                    value={splitCard}
                    onChange={(e) => setSplitCard(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  />
                </label>
                <label className="block text-slate-400">
                  QPay (зөвхөн энэ дүнгээр QR)
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                    value={splitQpay}
                    onChange={(e) => setSplitQpay(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  />
                </label>
                <label className="block text-slate-400">
                  Банкны шилжүүлэг
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                    value={splitTransfer}
                    onChange={(e) => setSplitTransfer(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  />
                </label>
                {creditOffered && (
                  <label className="block text-slate-400">
                    Дараа төлөх (зээл)
                    <input
                      type="number"
                      min={0}
                      className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                      value={splitCredit}
                      onChange={(e) => setSplitCredit(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    />
                  </label>
                )}
                {invoiceOffered && (
                  <label className="block text-slate-400">
                    Нэхэмжлэхээр (шилжүүлэг хүлээнэ)
                    <input
                      type="number"
                      min={0}
                      className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                      value={splitInvoice}
                      onChange={(e) => setSplitInvoice(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    />
                  </label>
                )}
                {contractOffered && (
                  <label className="block text-slate-400">
                    Гэрээгээр — өглөгөөс хасна (≤ {tugrik(partnerPayable ?? 0)})
                    <input
                      type="number"
                      min={0}
                      max={partnerPayable ?? 0}
                      className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
                      value={splitContract}
                      onChange={(e) => setSplitContract(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    />
                  </label>
                )}
                <p className={splitOk ? 'text-emerald-400' : 'text-amber-400'}>
                  Нийлбэр {tugrik(splitSum)} / {tugrik(totalMnt)}
                  {splitOk ? ' — зөв' : ` — зөрүү ${tugrik(totalMnt - splitSum)}`}
                </p>
              </div>
            )}
          </div>

          <div className="bg-slate-950 p-3 rounded-xl space-y-1 text-xs border border-slate-800/60">
            {b ? (
              <>
                {deliveryOffered && ourDelivery && b.assignedVehicle && (
                  <div className="flex justify-between text-slate-400">
                    <span>Хэмжээ / ангилал:</span>
                    <span>{VEHICLE_LABEL[b.assignedVehicle] ?? b.assignedVehicle}</span>
                  </div>
                )}
                {quote?.priceList && (
                  <div className="flex justify-between text-emerald-300">
                    <span>Үнийн жагсаалт:</span>
                    <span>{quote.priceList}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-400">
                  <span>Барааны үнэ:</span>
                  <span>{tugrik(b.subtotalMnt)}</span>
                </div>
                {ourDelivery ? (
                  <div className="flex justify-between text-slate-400">
                    <span>Хүргэлт ({selectedZone?.nameMn}):</span>
                    <span>{tugrik(b.deliveryFeeMnt)}</span>
                  </div>
                ) : deliveryOffered ? (
                  <div className="flex justify-between text-emerald-400 font-medium">
                    <span>Өөрөө авах:</span>
                    <span>0₮</span>
                  </div>
                ) : null}
                {ourDelivery && isUnloading && (
                  <div className="flex justify-between text-slate-400">
                    <span>Буулгалт:</span>
                    <span>{tugrik(b.unloadingFeeMnt)}</span>
                  </div>
                )}
                {b.timeAdjustmentMnt !== 0 && (
                  <div className="flex justify-between text-slate-400">
                    <span>Цагийн нэмэгдэл:</span>
                    <span>{tugrik(b.timeAdjustmentMnt)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold text-amber-400 pt-2 border-t border-slate-800">
                  <span>Нийт дүн:</span>
                  <span>{tugrik(b.totalMnt)}</span>
                </div>
              </>
            ) : (
              <p className="text-slate-500">Сагс хоосон эсвэл тооцоо амжилтгүй.</p>
            )}
          </div>

          {error && <p className="text-red-400 text-sm whitespace-pre-wrap">{error}</p>}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleCheckout}
            className="w-full py-3.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-slate-950 font-bold rounded-xl shadow-lg transition duration-200 text-sm"
          >
            {busy ? 'Илгээж байна…' : confirmLabel}
          </button>
          {!busy && missing.length > 0 && cart.length > 0 && <p className="text-center text-[11px] text-amber-300">{missing.join(' · ')}</p>}
        </div>
      </div>
    </Shell>
  );
}
