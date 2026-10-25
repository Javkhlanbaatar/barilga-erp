'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { AuthUser, ROLE_LABEL, Role, StaffUser, Warehouse } from '@/lib/types';
import { hasRole, homeForRole } from '@/lib/rbac';
import type { PermissionInfo } from '@/lib/permissions';

const ROLES: Role[] = ['ADMIN', 'SUPER_MANAGER', 'MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'];

/** What each role may do, shown under the role picker. */
const ROLE_HELP: Record<Role, string> = {
  ADMIN: 'Бүх зүйл: хэрэглэгч, модуль, компанийн мэдээлэл, дэлгүүр/агуулахын бүртгэл.',
  SUPER_MANAGER: 'Бүх дэлгүүр, агуулахыг хянана; үнэ, үнийн жагсаалт, цалин. Хэрэглэгч, модуль, тохиргоо өөрчлөхгүй.',
  MANAGER: 'Зөвхөн доор сонгосон дэлгүүр/агуулахынхаа захиалга, үлдэгдэл, касс, ирц, тайланг хянана. Үнэ өөрчлөхгүй.',
  BORLUULAGCH: 'Өөрийн дэлгүүрт зарна, төлбөр авна, буцаалт хийнэ.',
  ACHIGCH_BELTGEGCH: 'Өөрийн агуулахын тасалбар бэлтгэж олгоно, бараа хүлээн авна.',
};
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

const emptyForm = {
  fullName: '',
  username: '',
  email: '',
  /** «Google Gmail»: the address this person may sign in with through Google. */
  googleEmail: '',
  password: '',
  role: 'BORLUULAGCH' as Role,
  warehouseId: '',
  managedWarehouseIds: [] as string[],
};

type Toast = { kind: 'error' | 'ok'; text: string };

function roleBadge(role: Role) {
  const cls =
    role === 'ADMIN'
      ? 'border-amber-600 bg-amber-950/60 text-amber-200'
      : role === 'SUPER_MANAGER'
        ? 'border-orange-600 bg-orange-950/50 text-orange-200'
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

/** One right for one person: as the role has it, given on top, or taken away. */
type Choice = 'default' | 'grant' | 'revoke';

/** The role's own answer (the general manager also has what a branch manager has; same rule as the API). */
function byRole(role: Role, info: PermissionInfo) {
  return hasRole(role, info.roles);
}

/** What the admin set for this person that still changes something for their current role. */
function overrideCounts(row: StaffUser, catalog: PermissionInfo[]) {
  const set = row.permissions ?? { grant: [], revoke: [] };
  if (!catalog.length) return { grant: set.grant.length, revoke: set.revoke.length };
  return {
    grant: catalog.filter((p) => p.grantable && !byRole(row.role, p) && set.grant.includes(p.key)).length,
    revoke: catalog.filter((p) => byRole(row.role, p) && set.revoke.includes(p.key)).length,
  };
}

/** Rights in the order the server lists them, under their group headings. */
function groupRights(catalog: PermissionInfo[]) {
  const groups = new Map<string, PermissionInfo[]>();
  for (const p of catalog) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  return [...groups];
}

/** One line of the rights window: the right, whether the role has it, and the 3-way choice. */
function RightRow({ info, role, value, onChange }: { info: PermissionInfo; role: Role; value: Choice; onChange: (c: Choice) => void }) {
  const fromRole = byRole(role, info);
  const options: Array<[Choice, string]> = [['default', 'Анхдагч']];
  if (!fromRole && info.grantable) options.push(['grant', 'Нэмэх']);
  if (fromRole) options.push(['revoke', 'Хасах']);
  const has = value === 'grant' ? true : value === 'revoke' ? false : fromRole;
  const active: Record<Choice, string> = {
    default: 'bg-slate-600 text-white',
    grant: 'bg-emerald-600 text-white',
    revoke: 'bg-red-600 text-white',
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className={value === 'default' ? '' : 'font-medium text-amber-100'}>{info.label}</p>
        <p className="text-[11px]">
          {fromRole ? (
            <span className="text-emerald-300">✓ албан тушаалаар байгаа</span>
          ) : (
            <span className="text-slate-500">— байхгүй</span>
          )}
          {!fromRole && !info.grantable && <span className="text-slate-500"> · өөр албан тушаалд өгөхгүй</span>}
        </p>
      </div>
      <div className="flex gap-1">
        {options.map(([c, label]) => (
          <button
            key={c}
            type="button"
            aria-pressed={value === c}
            className={`min-h-[36px] rounded-md px-2.5 py-1 text-xs ${value === c ? `${active[c]} font-semibold` : 'btn-ghost'}`}
            onClick={() => onChange(c)}
          >
            {label}
          </button>
        ))}
      </div>
      <span className={`w-14 text-right text-[11px] ${has ? 'text-emerald-300' : 'text-slate-500'}`}>{has ? 'Эрхтэй' : 'Эрхгүй'}</span>
    </div>
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
  // Rights window: the catalog from the server, whose rights are open, and the choice per right.
  const [catalog, setCatalog] = useState<PermissionInfo[]>([]);
  const [rightsFor, setRightsFor] = useState<StaffUser | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // The rights as the dialog opened: closing it with changes asks first.
  const openedChoices = useRef('');
  const [rightsError, setRightsError] = useState('');

  const flash = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [staff, wh, rights] = await Promise.all([
        api<StaffUser[]>('/users'),
        api<Warehouse[]>('/inventory/warehouses'),
        // The users list still works if this fails; the rights window tries again.
        api<PermissionInfo[]>('/auth/permissions').catch(() => [] as PermissionInfo[]),
      ]);
      setUsers(staff);
      setWarehouses(wh);
      if (rights.length) setCatalog(rights);
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
      router.replace(homeForRole(parsed.role));
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

  /** Takes off the Google account a person signs in with (e.g. a wrong or a former employee's account). */
  async function unlinkGoogle(row: StaffUser) {
    if (!window.confirm(`${row.fullName || row.username}: ${row.googleEmail} Google бүртгэлийг салгах уу?`)) return;
    try {
      const next = await api<StaffUser>(`/users/${row.id}`, { method: 'PATCH', body: JSON.stringify({ unlinkGoogle: true }) });
      setEditing(next);
      // Saving the form afterwards must not put the address back.
      setForm((f) => ({ ...f, googleEmail: '' }));
      flash('ok', 'Google бүртгэл салгагдлаа');
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Салгаж чадсангүй');
    }
  }

  function openEdit(row: StaffUser) {
    setEditing(row);
    setForm({
      fullName: row.fullName || row.name || '',
      username: row.username,
      email: row.email ?? '',
      googleEmail: row.googleEmail ?? '',
      password: '',
      role: row.role,
      warehouseId: row.warehouseId ?? '',
      managedWarehouseIds: (row.managedWarehouses ?? []).map((w) => w.id),
    });
    setFormError('');
    setModal('edit');
  }

  function validate(): string | null {
    if (form.fullName.trim().length < 2) return 'Овог нэр оруулна уу';
    if (!USERNAME_RE.test(form.username.trim())) {
      return 'Нэвтрэх нэр 3–32 тэмдэгт: латин үсэг, тоо, цэг, зураас, доогуур зураас';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return 'И-мэйл буруу байна';
    if (modal === 'create' && form.password.length < 8) return 'Нууц үг дор хаяж 8 тэмдэгт байна';
    if (modal === 'edit' && form.password && form.password.length < 8) {
      return 'Шинэ нууц үг дор хаяж 8 тэмдэгт байна';
    }
    if (form.role === 'MANAGER' && !form.warehouseId && !form.managedWarehouseIds.length) {
      return 'Салбарын менежерт дор хаяж нэг дэлгүүр/агуулах сонгоно уу';
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
            googleEmail: form.googleEmail.trim() || undefined,
            password: form.password,
            role: form.role,
            warehouseId: form.warehouseId || undefined,
            managedWarehouseIds: form.role === 'MANAGER' ? form.managedWarehouseIds : [],
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
            ...(form.googleEmail.trim().toLowerCase() !== (editing.googleEmail ?? '') ? { googleEmail: form.googleEmail.trim() || null } : {}),
            role: form.role,
            warehouseId: form.warehouseId || null,
            managedWarehouseIds: form.role === 'MANAGER' ? form.managedWarehouseIds : [],
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

  async function openRights(row: StaffUser) {
    setRightsFor(row);
    setRightsError('');
    let list = catalog;
    if (!list.length) {
      try {
        list = await api<PermissionInfo[]>('/auth/permissions');
        setCatalog(list);
      } catch (err) {
        setRightsError(err instanceof Error ? err.message : 'Эрхийн жагсаалтыг ачаалж чадсангүй');
      }
    }
    const set = row.permissions ?? { grant: [], revoke: [] };
    const next: Record<string, Choice> = {};
    for (const p of list) {
      const fromRole = byRole(row.role, p);
      next[p.key] =
        fromRole && set.revoke.includes(p.key) ? 'revoke' : !fromRole && p.grantable && set.grant.includes(p.key) ? 'grant' : 'default';
    }
    setChoices(next);
    openedChoices.current = JSON.stringify(next);
  }

  async function saveRights() {
    if (!rightsFor) return;
    const grant = Object.keys(choices).filter((k) => choices[k] === 'grant');
    const revoke = Object.keys(choices).filter((k) => choices[k] === 'revoke');
    setSaving(true);
    setRightsError('');
    try {
      await api(`/users/${rightsFor.id}/permissions`, { method: 'PATCH', body: JSON.stringify({ grant, revoke }) });
      flash('ok', `${rightsFor.fullName || rightsFor.username}: эрх хадгалагдлаа`);
      setRightsFor(null);
      await load();
    } catch (err) {
      setRightsError(err instanceof Error ? err.message : 'Эрхийг хадгалж чадсангүй');
    } finally {
      setSaving(false);
    }
  }

  if (!me) return <div className="p-8 text-slate-400">Уншиж байна…</div>;

  const changed = Object.values(choices);
  const grantCount = changed.filter((c) => c === 'grant').length;
  const revokeCount = changed.filter((c) => c === 'revoke').length;

  const isActive = (row: StaffUser) => row.isActive !== false && row.active !== false;
  /** Rights given / taken on top of the role, as a visible badge (not only a tooltip). */
  const extraBadge = (row: StaffUser) => {
    const extra = row.role === 'ADMIN' ? null : overrideCounts(row, catalog);
    const google = row.googleEmail ? (
      <span className="ml-1 inline-flex rounded-full border border-sky-700 bg-sky-950/50 px-2 py-0.5 text-[11px] font-semibold text-sky-200" title={row.googleEmail}>
        Google
      </span>
    ) : null;
    return extra && (extra.grant > 0 || extra.revoke > 0) ? (
      <>
        {google}
      <span
        className="ml-1 inline-flex rounded-full border border-fuchsia-700 bg-fuchsia-950/50 px-2 py-0.5 text-[11px] font-semibold text-fuchsia-200"
        title="Албан тушаалынхаас гадна нэмсэн / хассан эрх"
      >
        эрх +{extra.grant} / −{extra.revoke}
      </span>
      </>
    ) : (
      google
    );
  };
  const warehouseText = (row: StaffUser) => (
    <>
      {row.role === 'ADMIN' || row.role === 'SUPER_MANAGER' ? 'Бүгд' : (row.warehouse?.name ?? 'Үндсэн (томилоогүй)')}
      {(row.managedWarehouses ?? []).length > 0 && (
        <p className="text-[11px] text-sky-300">+ {row.managedWarehouses!.map((w) => w.name).join(', ')}</p>
      )}
    </>
  );
  const statusBadge = (active: boolean) => (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        active ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200' : 'border-slate-600 text-slate-400'
      }`}
    >
      {active ? 'Идэвхтэй' : 'Идэвхгүй'}
    </span>
  );
  const actions = (row: StaffUser, active: boolean) => (
    <>
      <button className="btn-ghost text-xs px-3 py-1" onClick={() => openEdit(row)}>
        Засах
      </button>
      {row.role !== 'ADMIN' && (
        <button className="btn-ghost text-xs px-3 py-1" onClick={() => void openRights(row)}>
          Эрх
        </button>
      )}
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
    </>
  );

  return (
    <Shell>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <div>
          <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Админ</p>
          <h2 className="text-xl font-bold">Хэрэглэгчийн удирдлага</h2>
          <p className="text-slate-400 text-sm mt-1">Ажилтны бүртгэл үүсгэх, эрх олгох, нууц үг солих, нэвтрэх эрхийг идэвхгүй болгох.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={openCreate}>
            Хэрэглэгч нэмэх
          </button>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Шинэчлэх
          </button>
        </div>
      </div>

      {/* Phones: one card per person, buttons wrap under the details. */}
      <div className="space-y-2 md:hidden">
        {users.map((row) => {
          const active = isActive(row);
          return (
            <article key={row.id} className={`card space-y-2 ${active ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{row.fullName || row.name}</p>
                  <p className="font-mono text-xs text-slate-400">{row.username}</p>
                  {row.email && <p className="truncate text-xs text-slate-500">{row.email}</p>}
                </div>
                {statusBadge(active)}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {roleBadge(row.role)}
                {extraBadge(row)}
              </div>
              <div className="text-xs text-slate-300">
                <span className="text-slate-500">Агуулах: </span>
                {warehouseText(row)}
              </div>
              <div className="flex flex-wrap gap-2">{actions(row, active)}</div>
            </article>
          );
        })}
        {loading && <p className="p-3 text-slate-500">Ажилтнуудыг уншиж байна…</p>}
      </div>

      <div className="card hidden overflow-auto p-0 md:block">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="text-left text-slate-400 border-b border-slate-700">
            <tr>
              <th className="p-3">Овог нэр</th>
              <th>Нэвтрэх нэр</th>
              <th>Албан тушаал</th>
              <th>Агуулах</th>
              <th>Төлөв</th>
              <th className="pr-3 text-right">Үйлдэл</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => {
              const active = isActive(row);
              return (
                <tr key={row.id} className={`border-t border-slate-800 ${active ? '' : 'opacity-60'}`}>
                  <td className="p-3">
                    <p className="font-medium">{row.fullName || row.name}</p>
                    <p className="text-xs text-slate-500">{row.email || '—'}</p>
                  </td>
                  <td className="font-mono text-xs">{row.username}</td>
                  <td>
                    {roleBadge(row.role)}
                    {extraBadge(row)}
                  </td>
                  <td className="text-xs text-slate-300">{warehouseText(row)}</td>
                  <td>{statusBadge(active)}</td>
                  <td className="pr-3">
                    <div className="flex flex-wrap justify-end gap-1">{actions(row, active)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <p className="p-3 text-slate-500">Ажилтнуудыг уншиж байна…</p>}
      </div>

      {modal && (
        <Modal
          onClose={() => setModal(null)}
          title={modal === 'create' ? 'Хэрэглэгч нэмэх' : 'Хэрэглэгч засах / нууц үг солих'}
          size="md"
          busy={saving}
          footer={
            <>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Болих
              </button>
              <button type="submit" form="user-form" className="btn-primary" disabled={saving}>
                {saving ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </>
          }
        >
          <form id="user-form" onSubmit={save} className="space-y-3">
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
            {modal === 'edit' && editing && editing.id === me?.id ? (
              <p className="text-xs text-slate-400">Өөрийн Google нэвтрэлтийг «Миний бүртгэл» хэсгээс тохируулна.</p>
            ) : (
            <label className="block text-xs text-slate-400">
              Google Gmail (заавал биш)
              <input
                className="mt-1 w-full"
                type="email"
                placeholder="нэр@gmail.com"
                value={form.googleEmail}
                onChange={(e) => setForm({ ...form, googleEmail: e.target.value })}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Энэ Gmail-ээр «Google-ээр нэвтрэх» боломжтой болно (анх нэвтрэхэд холбогдоно). Өөрчилбөл хуучин Google холбоос салж, тэр хүн бүх төхөөрөмжөөс гарна.
                Нууц үг шинэчлэхэд Google холбоос мөн салгагдана (энд шинэ Gmail бичвэл тэр үлдэнэ).
              </span>
            </label>
            )}
            {modal === 'edit' && editing && editing.id === me?.id ? (
              <p className="text-xs text-slate-400">Өөрийн нууц үгийг «Миний бүртгэл» хэсгээс одоогийн нууц үгээ оруулж солино.</p>
            ) : (
              <label className="block text-xs text-slate-400">
                {modal === 'create' ? 'Нууц үг' : 'Шинэ нууц үг (хэвээр үлдээх бол хоосон орхино; солиход бүх төхөөрөмжөөс гарна)'}
                <input
                  className="mt-1 w-full"
                  type="password"
                  required={modal === 'create'}
                  minLength={modal === 'create' ? 8 : undefined}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
            )}
            {modal === 'edit' && editing?.googleEmail && editing.id !== me?.id && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 p-2 text-xs">
                <span>
                  Google-ээр нэвтэрдэг: <span className="font-semibold text-emerald-300">{editing.googleEmail}</span>
                </span>
                <button type="button" className="btn-ghost text-xs" disabled={saving} onClick={() => void unlinkGoogle(editing)}>
                  Google холбоосыг салгах
                </button>
              </div>
            )}
            <label className="block text-xs text-slate-400">
              Албан тушаал
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
              <span className="mt-1 block text-[11px] text-slate-500">{ROLE_HELP[form.role]}</span>
            </label>
            <label className="block text-xs text-slate-400">
              {form.role === 'MANAGER' ? 'Үндсэн дэлгүүр / агуулах' : 'Агуулах / дэлгүүр'}
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
                Кассчин, агуулахын ажилтан зөвхөн өөрийн дэлгүүр/агуулахыг харна; томилоогүй бол үндсэн дэлгүүрийг.
                Админ, ерөнхий менежер бүгдийг харна.
              </span>
            </label>
            {form.role === 'MANAGER' && (
              <fieldset className="rounded border border-slate-700 p-2 text-xs text-slate-400">
                <legend className="px-1">Мөн хянах дэлгүүр / агуулах</legend>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {warehouses
                    .filter((w) => w.id !== form.warehouseId)
                    .map((w) => (
                      <label key={w.id} className="flex min-h-[36px] items-center gap-2 text-sm text-slate-200">
                        <input
                          type="checkbox"
                          checked={form.managedWarehouseIds.includes(w.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              managedWarehouseIds: e.target.checked
                                ? [...form.managedWarehouseIds, w.id]
                                : form.managedWarehouseIds.filter((x) => x !== w.id),
                            })
                          }
                        />
                        {w.name}
                      </label>
                    ))}
                </div>
              </fieldset>
            )}
          </form>
        </Modal>
      )}

      {rightsFor && (
        <Modal
          onClose={() => setRightsFor(null)}
          dirty={Boolean(openedChoices.current) && JSON.stringify(choices) !== openedChoices.current}
          title={
            <span className="flex flex-wrap items-center gap-2">
              Эрх — {rightsFor.fullName || rightsFor.name || rightsFor.username}
              {roleBadge(rightsFor.role)}
            </span>
          }
          size="xl"
          busy={saving}
          footer={
            <>
              <span className="mr-auto self-center text-xs text-slate-400">
                {grantCount || revokeCount ? `Нэмсэн ${grantCount}, хассан ${revokeCount}` : 'Бүгд албан тушаалын анхдагчаар'}
              </span>
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={!grantCount && !revokeCount}
                onClick={() => setChoices(Object.fromEntries(Object.keys(choices).map((k) => [k, 'default' as Choice])))}
              >
                Бүгдийг анхдагч болгох
              </button>
              <button type="button" className="btn-ghost" onClick={() => setRightsFor(null)}>
                Болих
              </button>
              <button className="btn-primary" disabled={saving || !catalog.length} onClick={() => void saveRights()}>
                {saving ? 'Хадгалж байна…' : 'Хадгалах'}
              </button>
            </>
          }
        >
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-400">
              <li>Хадгалмагц шууд хүчинтэй болно; ажилтан дахин нэвтрэх шаардлагагүй.</li>
              <li>«Анхдагч» — албан тушаалынх нь дагуу. «Нэмэх» — албан тушаалд нь байхгүй эрхийг өгнө. «Хасах» — байгаа эрхийг авна.</li>
              <li>Админ үргэлж бүх эрхтэй — түүнийг хязгаарлахгүй.</li>
              <li>Цалин, мөнгө гаргах, цуцлах зэрэг эрхийг өөр албан тушаалд өгөхгүй, зөвхөн хасна.</li>
              <li>Өөрчлөлт бүр «Тайлан → Засварын түүх»-д бичигдэнэ.</li>
            </ul>
            <div className="space-y-3">
              {groupRights(catalog).map(([group, items]) => (
                <section key={group}>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-brand">{group}</h4>
                  <div className="divide-y divide-slate-800 rounded-lg border border-slate-700">
                    {items.map((p) => (
                      <RightRow
                        key={p.key}
                        info={p}
                        role={rightsFor.role}
                        value={choices[p.key] ?? 'default'}
                        onChange={(c) => setChoices({ ...choices, [p.key]: c })}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {!catalog.length && !rightsError && <p className="text-sm text-slate-500">Уншиж байна…</p>}
            </div>
            {rightsError && <p className="text-red-400 text-sm">{rightsError}</p>}
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)} title="Хэрэглэгчийг идэвхгүй болгох" size="md" busy={saving}>
          <p className="text-sm text-slate-300">
            {deleting.fullName} ({deleting.username}) нэвтрэх боломжгүй болно. Дараа нь дахин идэвхжүүлж болно.
          </p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
              Болих
            </button>
            <button className="btn-danger" disabled={saving} onClick={() => void confirmDeactivate()}>
              {saving ? 'Түр хүлээнэ үү…' : 'Идэвхгүй болгох'}
            </button>
          </div>
        </Modal>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 left-4 right-4 z-[60] sm:left-auto rounded-lg border px-4 py-3 text-sm shadow-lg ${
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
