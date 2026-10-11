'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { homeForRole } from '@/lib/rbac';
import { AuthUser, Warehouse } from '@/lib/types';

type Toast = { kind: 'error' | 'ok'; text: string };

const emptyForm = { code: '', name: '', address: '', phone: '' };

export default function AdminWarehousesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<Warehouse[]>('/inventory/warehouses?all=true'));
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load');
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

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError('');
    setModal('create');
  }

  function openEdit(row: Warehouse) {
    setEditing(row);
    setForm({ code: row.code, name: row.name, address: row.address ?? '', phone: row.phone ?? '' });
    setFormError('');
    setModal('edit');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'create') {
        await api('/inventory/warehouses', {
          method: 'POST',
          body: JSON.stringify({
            code: form.code.trim(),
            name: form.name.trim(),
            address: form.address.trim() || undefined,
            phone: form.phone.trim() || undefined,
          }),
        });
        flash('ok', 'Агуулах үүслээ');
      } else if (editing) {
        await api(`/inventory/warehouses/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: form.name.trim(), address: form.address.trim(), phone: form.phone.trim() }),
        });
        flash('ok', 'Хадгалагдлаа');
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function patch(row: Warehouse, body: Record<string, unknown>, okText: string) {
    try {
      await api(`/inventory/warehouses/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      flash('ok', okText);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Admin</p>
          <h2 className="text-xl font-bold">Дэлгүүр / агуулах</h2>
          <p className="text-slate-400 text-sm mt-1">
            Дэлгүүр бүр өөрийн агуулахтай. Анхдагч агуулахад хуучин үлдэгдэл хуваарилагдсан.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={openCreate}>
            Агуулах нэмэх
          </button>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Код</th>
              <th>Нэр</th>
              <th>Хаяг</th>
              <th>Утас</th>
              <th>Төлөв</th>
              <th className="pr-3 text-right">Үйлдэл</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`border-t border-slate-800 ${row.isActive ? '' : 'opacity-60'}`}>
                <td className="p-3 font-mono text-xs">{row.code}</td>
                <td className="font-medium">{row.name}</td>
                <td className="text-slate-300">{row.address || '—'}</td>
                <td className="text-slate-300">{row.phone || '—'}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {row.isDefault && (
                      <span className="inline-flex rounded-full border border-amber-600 bg-amber-950/60 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
                        Анхдагч
                      </span>
                    )}
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        row.isActive
                          ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                          : 'border-slate-600 text-slate-400'
                      }`}
                    >
                      {row.isActive ? 'Идэвхтэй' : 'Идэвхгүй'}
                    </span>
                  </div>
                </td>
                <td className="pr-3">
                  <div className="flex justify-end gap-1">
                    <button className="btn-ghost text-xs px-3 py-1" onClick={() => openEdit(row)}>
                      Засах
                    </button>
                    {row.isActive && !row.isDefault && (
                      <button
                        className="btn-ghost text-xs px-3 py-1"
                        onClick={() => void patch(row, { isDefault: true }, `${row.name} анхдагч боллоо`)}
                      >
                        Анхдагч болгох
                      </button>
                    )}
                    {row.isActive && !row.isDefault && (
                      <button
                        className="btn-danger text-xs px-3 py-1"
                        onClick={() => void patch(row, { isActive: false }, `${row.name} идэвхгүй боллоо`)}
                      >
                        Идэвхгүй болгох
                      </button>
                    )}
                    {!row.isActive && (
                      <button
                        className="btn-ghost text-xs px-3 py-1"
                        onClick={() => void patch(row, { isActive: true }, `${row.name} идэвхжлээ`)}
                      >
                        Идэвхжүүлэх
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Уншиж байна…</p>}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={save} className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">{modal === 'create' ? 'Агуулах нэмэх' : 'Агуулах засах'}</h3>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <label className="block text-xs text-slate-400">
              Код (давтагдахгүй, дараа нь солигдохгүй)
              <input
                className="mt-1 w-full font-mono"
                required
                disabled={modal === 'edit'}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="SHOP-2"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Нэр
              <input
                className="mt-1 w-full"
                required
                minLength={2}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Хаяг
              <input className="mt-1 w-full" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </label>
            <label className="block text-xs text-slate-400">
              Утас
              <input className="mt-1 w-full" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-[60] rounded-lg border px-4 py-3 text-sm shadow-lg ${
            toast.kind === 'error'
              ? 'border-red-700 bg-red-950 text-red-100'
              : 'border-emerald-700 bg-emerald-950 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}
