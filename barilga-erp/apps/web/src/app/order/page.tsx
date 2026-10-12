'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProductImage } from '@/components/product-image';
import { publicApi, tugrik } from '@/lib/api';
import { Product, VEHICLE_LABEL, Zone } from '@/lib/types';

type DeliveryType = 'OUR_DELIVERY' | 'SELF_PICKUP' | 'CUSTOMER_DRIVER';
type CartLine = { product: Product; quantity: number };
type Quote = {
  breakdown: {
    assignedVehicle: string;
    subtotalMnt: number;
    deliveryFeeMnt: number;
    unloadingFeeMnt: number;
    timeAdjustmentMnt: number;
    totalMnt: number;
  };
};

function chipClass(active: boolean) {
  return `py-2 px-2 text-xs font-medium rounded-lg border ${
    active ? 'bg-amber-500 text-slate-950 border-amber-500 font-bold' : 'bg-slate-800 text-slate-300 border-slate-700'
  }`;
}

export default function PublicOrderPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('OUR_DELIVERY');
  const [zoneId, setZoneId] = useState('');
  const [time, setTime] = useState('STANDARD');
  const [isUnloading, setIsUnloading] = useState(false);
  const [shop, setShop] = useState<{ shopOpen: boolean; unloading: boolean }>({ shopOpen: true, unloading: false });
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ourDelivery = deliveryType === 'OUR_DELIVERY';

  // Which services the shop offers right now (admin module switches).
  useEffect(() => {
    publicApi<{ shopOpen: boolean; unloading: boolean }>('/public/config')
      .then((c) => {
        setShop(c);
        if (!c.unloading) setIsUnloading(false);
      })
      .catch(() => undefined);
  }, []);
  const items = useMemo(
    () => cart.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
    [cart],
  );

  useEffect(() => {
    publicApi<{ products: Product[]; zones: Zone[] }>('/public/catalog')
      .then((data) => {
        setProducts(data.products);
        setZones(data.zones);
        if (data.zones[0]) setZoneId(data.zones[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Catalog failed'));
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => {
      publicApi<Quote>('/public/quote', {
        method: 'POST',
        body: JSON.stringify({
          zoneId: ourDelivery ? zoneId : undefined,
          deliveryMethod: deliveryType,
          timeCondition: time,
          unloadingRequested: ourDelivery && isUnloading,
          items,
        }),
      })
        .then(setQuote)
        .catch((err) => setError(err instanceof Error ? err.message : 'Quote failed'));
    }, 250);
    return () => clearTimeout(t);
  }, [items, zoneId, deliveryType, time, isUnloading, ourDelivery]);

  function add(product: Product) {
    setCart((prev) => {
      const found = prev.find((l) => l.product.id === product.id);
      if (found) return prev.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { product, quantity: 1 }];
    });
  }

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      const plate = vehicleNumber.trim();
      const phone = driverPhone.trim();
      if (ourDelivery && (plate || phone) && (!plate || phone.replace(/\s+/g, '').length < 8)) {
        throw new Error('Ачааны машины дугаар болон жолоочийн утсыг хамтад нь оруулна, эсвэл хоосон үлдээнэ');
      }
      const order = await publicApi<{ trackingToken: string }>('/public/orders', {
        method: 'POST',
        body: JSON.stringify({
          zoneId: ourDelivery ? zoneId : undefined,
          deliveryMethod: deliveryType,
          timeCondition: time,
          unloadingRequested: ourDelivery && isUnloading,
          items,
          customerName,
          customerPhone,
          deliveryAddress: address,
          paymentMethod: 'QPAY',
          vehicleNumber: ourDelivery && plate ? plate : undefined,
          driverPhone: ourDelivery && phone ? phone : undefined,
        }),
      });
      router.push(`/track/${order.trackingToken}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  const b = quote?.breakdown;

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-4 py-8">
      {!shop.shopOpen && (
        <p className="mb-4 rounded-lg border border-amber-700 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
          Онлайн захиалга түр хаалттай байна. Дэлгүүрт ирж эсвэл утсаар захиална уу.
        </p>
      )}
      <header className="flex items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Barilga</p>
          <h1 className="text-2xl font-bold">Цахим захиалга</h1>
          <p className="text-slate-400 text-sm">Хүргэлтийн машины дугаар, жолоочийн утсыг энд эсвэл дараа нь tracking холбоосоор оруулна.</p>
        </div>
        <Link href="/login" className="btn-ghost text-sm">
          Ажилтны нэвтрэх
        </Link>
      </header>
      {error && <p className="text-red-400 mb-3">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => (
            <button key={p.id} type="button" className="card text-left" onClick={() => add(p)}>
              <ProductImage src={p.imageUrl} alt={p.nameMn} />
              <p className="font-semibold mt-2">{p.nameMn}</p>
              <p className="text-sm text-slate-400">{tugrik(p.priceMnt)} · {p.unit}</p>
            </button>
          ))}
        </section>
        <aside className="card space-y-3 h-fit">
          <h2 className="font-semibold">Сагс</h2>
          {cart.length === 0 && <p className="text-slate-500 text-sm">Бараа сонгоно уу</p>}
          <ul className="space-y-1 text-sm">
            {cart.map((line) => (
              <li key={line.product.id} className="flex justify-between gap-2">
                <span>
                  {line.product.nameMn} × {line.quantity}
                </span>
                <button type="button" className="text-slate-500" onClick={() => setCart((c) => c.filter((l) => l.product.id !== line.product.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-3 gap-1">
            <button type="button" className={chipClass(deliveryType === 'OUR_DELIVERY')} onClick={() => setDeliveryType('OUR_DELIVERY')}>
              Хүргэлт
            </button>
            <button type="button" className={chipClass(deliveryType === 'SELF_PICKUP')} onClick={() => setDeliveryType('SELF_PICKUP')}>
              Өөрөө авна
            </button>
            <button type="button" className={chipClass(deliveryType === 'CUSTOMER_DRIVER')} onClick={() => setDeliveryType('CUSTOMER_DRIVER')}>
              Өөрийн жолооч
            </button>
          </div>
          {ourDelivery && (
            <>
              <label className="block text-sm">
                Бүс
                <select className="mt-1 w-full" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.nameMn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Цаг
                <select className="mt-1 w-full" value={time} onChange={(e) => setTime(e.target.value)}>
                  <option value="STANDARD">Энгийн</option>
                  <option value="NIGHT">Шөнө</option>
                  <option value="EXPRESS">Яаралтай</option>
                </select>
              </label>
              {shop.unloading && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={isUnloading} onChange={(e) => setIsUnloading(e.target.checked)} />
                  Буулгалт
                </label>
              )}
              <label className="block text-sm">
                Хаяг
                <input className="mt-1 w-full" value={address} onChange={(e) => setAddress(e.target.value)} />
              </label>
              <label className="block text-sm">
                Ачааны машины дугаар (заавал биш)
                <input className="mt-1 w-full" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="7711 УБН" />
              </label>
              <label className="block text-sm">
                Жолоочийн утас (заавал биш)
                <input className="mt-1 w-full" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} placeholder="99112233" />
              </label>
              <p className="text-xs text-slate-500">Хожим tracking холбоосоор нэмж болно.</p>
            </>
          )}
          <label className="block text-sm">
            Нэр
            <input className="mt-1 w-full" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </label>
          <label className="block text-sm">
            Утас
            <input className="mt-1 w-full" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
          </label>
          {b && (
            <div className="text-sm space-y-1">
              <p>Хэмжээ: {VEHICLE_LABEL[b.assignedVehicle] ?? b.assignedVehicle}</p>
              <p>Нийт: <span className="font-bold text-amber-brand">{tugrik(b.totalMnt)}</span></p>
            </div>
          )}
          <button className="btn-primary w-full" disabled={busy || cart.length === 0 || !customerName || !customerPhone} onClick={() => void checkout()}>
            {busy ? 'Илгээж байна…' : 'Захиалах (QPay)'}
          </button>
        </aside>
      </div>
    </main>
  );
}
