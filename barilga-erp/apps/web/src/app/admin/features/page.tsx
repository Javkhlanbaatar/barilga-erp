'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { loadFeatures } from '@/lib/features';
import { homeForRole } from '@/lib/rbac';
import { AuthUser, FeatureSwitch } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };

export default function AdminFeaturesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<FeatureSwitch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await api<FeatureSwitch[]>('/features')).filter((r) => !r.dormant));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    if (!raw) {
      router.replace('/login');
      return;
    }
    const me = JSON.parse(raw) as AuthUser;
    if (me.role !== 'ADMIN') {
      router.replace(homeForRole(me.role));
      return;
    }
    void load();
  }, [load, router]);

  async function toggle(row: FeatureSwitch) {
    const next = !row.enabled;
    if (!next && !window.confirm(`«${row.nameMn}» модулийг унтраах уу? Бүх ажилтанд энэ модуль хаагдана (өгөгдөл устахгүй).`)) return;
    setBusy(row.key);
    try {
      await api(`/features/${row.key}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
      await loadFeatures(true);
      flash('ok', `${row.nameMn} ${next ? 'асаалаа' : 'унтраалаа'}`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Алдаа');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Админ</p>
        <h2 className="text-xl font-bold">Модулиуд</h2>
        <p className="text-slate-400 text-sm mt-1">
          Унтраасан модулийг сервер өөрөө хаана (зөвхөн цэснээс нуухгүй). Өгөгдөл хэвээр үлдэнэ; дахин асаахад бүгд буцаж гарна.
        </p>
      </div>
      <div className="card p-0 divide-y divide-slate-800 max-w-2xl">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-medium">{row.nameMn}</p>
              <p className="text-xs text-slate-500 font-mono">
                {row.key}
                {row.isDefault ? ' · анхдагч тохиргоо' : row.updatedAt ? ` · өөрчилсөн ${new Date(row.updatedAt).toLocaleString('mn-MN')}` : ''}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={row.enabled}
              disabled={busy === row.key}
              onClick={() => void toggle(row)}
              className={`relative h-7 w-12 rounded-full transition-colors ${row.enabled ? 'bg-emerald-600' : 'bg-slate-600'}`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${row.enabled ? 'left-6' : 'left-1'}`}
              />
              <span className="sr-only">{row.enabled ? 'Асаалттай' : 'Унтраалттай'}</span>
            </button>
          </div>
        ))}
        {loading && <p className="p-4 text-slate-500">Уншиж байна…</p>}
      </div>
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg ${
            toast.kind === 'error' ? 'border-red-700 bg-red-950 text-red-100' : 'border-emerald-700 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}
