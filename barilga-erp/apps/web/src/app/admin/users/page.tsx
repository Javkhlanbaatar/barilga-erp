'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { AuthUser, ROLE_LABEL, Role, StaffUser, Warehouse } from '@/lib/types';
import { homeForRole } from '@/lib/rbac';

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

const emptyForm = {
  fullName: '',
  username: '',
  email: '',
  password: '',
  role: 'BORLUULAGCH' as Role,
  warehouseId: '',
};

type Toast = { kind: 'error' | 'ok'; text: string };

function roleBadge(role: Role) {
  const cls =
    role === 'ADMIN'
      ? 'border-amber-600 bg-amber-950/60 text-amber-200'
      : role === 'MANAGER'
        ? 'border-sky-700 bg-sky-950/50 text-sky-200'
        : role === 'BORLUULAGCH'
          ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
          : 'border-violet-700 bg-violet-950/50 text-violet-200';
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {ROLE_LABEL[role]}
    </span>
  );
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [deleting, setDeleting] = useState<StaffUser | null>(null);
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
      const [staff, wh] = await Promise.all([
        api<StaffUser[]>('/users'),
        api<Warehouse[]>('/inventory/warehouses'),
      ]);
      setUsers(staff);
      setWarehouses(wh);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Хэрэглэгчдийг ачаалж чадсангүй';
      flash('error', message);
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
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed.role !== 'ADMIN') {
      router.replace(parsed.role === 'MANAGER' ? '/admin' : homeForRole(parsed.role));
      return;
    }
    setMe(parsed);
    void load();
  }, [load, router]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setFormError('');
    setModal('create');
  }

  function openEdit(row: StaffUser) {
    setEditing(row);
    setForm({
      fullName: row.fullName || row.name || '',
      username: row.username,
      email: row.email ?? '',
      password: '',
      role: row.role,
      warehouseId: row.warehouseId ?? '',
    });
    setFormError('');
    setModal('edit');
  }

  function validate(): string | null {
    if (form.fullName.trim().length < 2) return 'Овог нэрээ оруулна уу';
    if (!USERNAME_RE.test(form.username.trim())) {
      return 'Нэвтрэх нэр 3–32 тэмдэгт: латин үсэг, тоо, цэг, зураас, доогуур зураас';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'И-мэйл буруу байна';
    if (modal === 'create' && form.password.length < 8) return 'Нууц үг дор хаяж 8 тэмдэгт байна';
    if (modal === 'edit' && form.password && form.password.length < 8) {
      return 'Шинэ нууц үг дор хаяж 8 тэмдэгт байна';
    }
    return null;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      setFormError(invalid);
      flash('error', invalid);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (modal === 'create') {
        await api('/users', {
          method: 'POST',
          body: JSON.stringify({
            fullName: form.fullName.trim(),
            username: form.username.trim(),
            email: form.email.trim() || undefined,
            password: form.password,
            role: form.role,
            warehouseId: form.warehouseId || undefined,
          }),
        });
        flash('ok', 'Хэрэглэгч нэмэгдлээ');
      } else if (editing) {
        await api(`/users/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fullName: form.fullName.trim(),
            username: form.username.trim(),
            email: form.email.trim() || null,
            role: form.role,
            warehouseId: form.warehouseId || null,
            ...(form.password ? { password: form.password } : {}),
          }),
        });
        flash('ok', form.password ? 'Хэрэглэгч шинэчлэгдэж, нууц үг солигдлоо' : 'Хэрэглэгч шинэчлэгдлээ');
      }
      setModal(null);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Хадгалж чадсангүй';
      setFormError(message);
      flash('error', message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeactivate() {
    if (!deleting) return;
    setSaving(true);
    try {
      await api(`/users/${deleting.id}`, { method: 'DELETE' });
      flash('ok', `${deleting.username} идэвхгүй боллоо`);
      setDeleting(null);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Идэвхгүй болгож чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  async function reactivate(row: StaffUser) {
    try {
      await api(`/users/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: true }),
      });
      flash('ok', `${row.username} идэвхжлээ`);
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Идэвхжүүлж чадсангүй');
    }
  }

  if (!me) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Админ</p>
          <h2 className="text-xl font-bold">Хэрэглэгчийн удирдлага</h2>
          <p className="text-slate-400 text-sm mt-1">Ажилтны бүртгэл үүсгэх, эрх олгох, нууц үг солих, нэвтрэх эрхийг идэвхгүй болгох.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={openCreate}>
            Хэрэглэгч нэмэх
          </button>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      <div className="card overflow-auto p-0">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Овог нэр</th>
              <th>Нэвтрэх нэр</th>
              <th>Эрх</th>
              <th>Агуулах</th>
              <th>Төлөв</th>
              <th className="pr-3 text-right">Үйлдэл</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => {
              const active = row.isActive !== false && row.active !== false;
              return (
                <tr key={row.id} className={`border-t border-slate-800 ${active ? '' : 'opacity-60'}`}>
                  <td className="p-3">
                    <p className="font-medium">{row.fullName || row.name}</p>
                    <p className="text-xs text-slate-500">{row.email || '—'}</p>
                  </td>
                  <td className="font-mono text-xs">{row.username}</td>
                  <td>{roleBadge(row.role)}</td>
                  <td className="text-xs text-slate-300">{row.warehouse?.name ?? '—'}</td>
                  <td>
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        active
                          ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                          : 'border-slate-600 text-slate-400'
                      }`}
                    >
                      {active ? 'Идэвхтэй' : 'Идэвхгүй'}
                    </span>
                  </td>
                  <td className="pr-3">
                    <div className="flex justify-end gap-1">
                      <button className="btn-ghost text-xs px-3 py-1" onClick={() => openEdit(row)}>
                        Засах
                      </button>
                      {active && row.id !== me?.id && (
                        <button className="btn-danger text-xs px-3 py-1" onClick={() => setDeleting(row)}>
                          Идэвхгүй болгох
                        </button>
                      )}
                      {!active && (
                        <button className="btn-ghost text-xs px-3 py-1" onClick={() => void reactivate(row)}>
                          Идэвхжүүлэх
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Ажилтнуудыг уншиж байна…</p>}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <form onSubmit={save} className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">{modal === 'create' ? 'Хэрэглэгч нэмэх' : 'Хэрэглэгч засах / нууц үг солих'}</h3>
            {formError && <p className="text-red-400 text-sm">{formError}</p>}
            <label className="block text-xs text-slate-400">
              Овог нэр
              <input
                className="mt-1 w-full"
                required
                minLength={2}
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Нэвтрэх нэр
              <input
                className="mt-1 w-full"
                required
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="cashier01"
              />
            </label>
            <label className="block text-xs text-slate-400">
              И-мэйл (заавал биш)
              <input
                className="mt-1 w-full"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              {modal === 'create' ? 'Нууц үг' : 'Шинэ нууц үг (хэвээр үлдээх бол хоосон орхино)'}
              <input
                className="mt-1 w-full"
                type="password"
                required={modal === 'create'}
                minLength={modal === 'create' ? 8 : undefined}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Эрх
              <select
                className="mt-1 w-full"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-400">
              Агуулах / дэлгүүр
              <select
                className="mt-1 w-full"
                value={form.warehouseId}
                onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
              >
                <option value="">Томилоогүй</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-slate-500">
                Борлуулагч болон агуулахын ажилтан зөвхөн өөрийн агуулахын захиалга, үлдэгдлийг харна. Админ,
                менежер бүгдийг харна.
              </span>
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

      {deleting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="card w-full max-w-md space-y-3">
            <h3 className="font-semibold text-lg">Хэрэглэгчийг идэвхгүй болгох</h3>
            <p className="text-sm text-slate-300">
              {deleting.fullName} ({deleting.username}) нэвтрэх боломжгүй болно. Дараа нь дахин идэвхжүүлж болно.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
                Болих
              </button>
              <button className="btn-danger" disabled={saving} onClick={() => void confirmDeactivate()}>
                {saving ? 'Түр хүлээнэ үү…' : 'Идэвхгүй болгох'}
              </button>
            </div>
          </div>
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
