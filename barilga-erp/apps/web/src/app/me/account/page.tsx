'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { GoogleButton } from '@/components/google-button';
import { Shell } from '@/components/shell';
import { api } from '@/lib/api';
import { savedUser } from '@/lib/permissions';
import { AuthUser, ROLE_LABEL, Role } from '@/lib/types';

type Profile = {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: Role;
  warehouseName: string | null;
  googleEmail: string | null;
  googleLinked: boolean;
  googleEnabled: boolean;
};
type Session = { accessToken: string; user: AuthUser };
/** bcrypt reads 72 bytes (a Cyrillic letter is 2 bytes). */
const bytes = (s: string) => new TextEncoder().encode(s).length;
type Note = { ok: boolean; text: string } | null;

/** Keeps this device signed in after the server issued a new token (password change, signing out elsewhere). */
function keepSession(s: Session) {
  localStorage.setItem('barilga_token', s.accessToken);
  localStorage.setItem('barilga_user', JSON.stringify(s.user));
  window.dispatchEvent(new Event('barilga-user'));
}

/** The name shown in the menu follows a change made here. */
function rememberName(fullName: string) {
  const u = savedUser();
  if (!u || u.fullName === fullName) return;
  localStorage.setItem('barilga_user', JSON.stringify({ ...u, fullName, name: fullName }));
  window.dispatchEvent(new Event('barilga-user'));
}

/**
 * «Миний бүртгэл»: everyone's own page — name, phone and e-mail, their password, the Google account they sign in
 * with, and signing out of every device. Role, warehouse and rights stay with the admin.
 */
export default function MyAccountPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [config, setConfig] = useState<{ googleClientId: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setProfile(await api<Profile>('/auth/profile'));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Ачаалж чадсангүй');
    }
  }, []);

  useEffect(() => {
    void load();
    api<{ googleClientId: string | null }>('/auth/config')
      .then(setConfig)
      .catch(() => setConfig({ googleClientId: null }));
  }, [load]);

  return (
    <Shell>
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-amber-brand">Хэрэглэгч</p>
          <h1 className="text-2xl font-bold">Миний бүртгэл</h1>
          <p className="text-sm text-slate-400">Өөрийн мэдээлэл, нууц үг, Google-ээр нэвтрэх. Албан тушаал, агуулах, эрхийг админ тохируулна.</p>
        </div>
        {loadError && <p className="card text-sm text-red-400">{loadError}</p>}
        {!profile && !loadError && <p className="text-sm text-slate-500">Уншиж байна…</p>}
        {profile && (
          <>
            <DetailsCard profile={profile} onSaved={setProfile} />
            <PasswordCard onChanged={() => void load()} />
            <GoogleCard profile={profile} clientId={config?.googleClientId ?? null} onChanged={setProfile} />
            <SessionsCard />
          </>
        )}
      </div>
    </Shell>
  );
}

function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return <p className={`text-sm ${note.ok ? 'text-emerald-300' : 'text-red-400'}`}>{note.text}</p>;
}

function DetailsCard({ profile, onSaved }: { profile: Profile; onSaved: (p: Profile) => void }) {
  const [fullName, setFullName] = useState(profile.fullName);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [email, setEmail] = useState(profile.email ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const emailChanged = email.trim().toLowerCase() !== (profile.email ?? '');
  const changed = fullName.trim() !== profile.fullName || phone.trim() !== (profile.phone ?? '') || emailChanged;

  async function save(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    if (fullName.trim().length < 2) return setNote({ ok: false, text: 'Нэрээ бичнэ үү (2-оос доошгүй тэмдэгт)' });
    if (emailChanged && !password) return setNote({ ok: false, text: 'Имэйл солиход одоогийн нууц үгээ оруулна уу' });
    setSaving(true);
    try {
      const next = await api<Profile>('/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: fullName.trim(),
          phone: phone.trim(),
          ...(emailChanged ? { email: email.trim(), currentPassword: password } : {}),
        }),
      });
      onSaved(next);
      rememberName(next.fullName);
      setPassword('');
      setNote({ ok: true, text: 'Хадгалагдлаа.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Хадгалж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-semibold">Мэдээлэл</h2>
        <span className="rounded-full border border-amber-700/70 bg-amber-950/50 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
          {ROLE_LABEL[profile.role]}
        </span>
      </div>
      <p className="text-xs text-slate-400">
        Нэвтрэх нэр: <span className="font-mono text-slate-200">{profile.username}</span>
        {profile.warehouseName ? ` · ${profile.warehouseName}` : ''}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Нэр
          <input className="mt-1 w-full" value={fullName} maxLength={80} onChange={(e) => setFullName(e.target.value)} required />
        </label>
        <label className="block text-xs text-slate-400">
          Утас
          <input className="mt-1 w-full" inputMode="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="block text-xs text-slate-400 sm:col-span-2">
          Имэйл (имэйлээрээ ч нэвтэрч болно; Google нэвтрэлт доорх хэсгээс)
          <input className="mt-1 w-full" type="email" value={email} maxLength={120} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {emailChanged && (
          <label className="block text-xs text-slate-400 sm:col-span-2">
            Имэйл солиход одоогийн нууц үг
            <input className="mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
      </div>
      <NoteLine note={note} />
      <div className="flex justify-end">
        <button className="btn-primary" disabled={saving || !changed}>
          {saving ? 'Хадгалж байна…' : 'Хадгалах'}
        </button>
      </div>
    </form>
  );
}

function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    if (next.length < 8) return setNote({ ok: false, text: 'Шинэ нууц үг 8-аас доошгүй тэмдэгт байна' });
    if (bytes(next) > 72) return setNote({ ok: false, text: 'Шинэ нууц үг хэт урт (латин 72, кирилл 36 орчим тэмдэгтээс ихгүй)' });
    if (next !== again) return setNote({ ok: false, text: 'Шинэ нууц үг хоёр удаа ижил бичигдээгүй байна' });
    setSaving(true);
    try {
      const res = await api<Session & { googleUnlinked?: boolean }>('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      keepSession(res);
      setCurrent('');
      setNext('');
      setAgain('');
      setNote({
        ok: true,
        text:
          'Нууц үг солигдлоо. Бусад төхөөрөмж дээр дахин нэвтрэх шаардлагатай.' +
          (res.googleUnlinked ? ' Google бүртгэл аюулгүй байдлын үүднээс салгагдсан — өөрийнх бол доороос дахин холбоно уу.' : ''),
      });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Сольж чадсангүй' });
    } finally {
      setSaving(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <form onSubmit={save} className="card space-y-3">
      <h2 className="font-semibold">Нууц үг солих</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-xs text-slate-400">
          Одоогийн нууц үг
          <input className="mt-1 w-full" type={type} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="block text-xs text-slate-400">
          Шинэ нууц үг (8+ тэмдэгт)
          <input className="mt-1 w-full" type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label className="block text-xs text-slate-400">
          Шинэ нууц үг дахин
          <input className="mt-1 w-full" type={type} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Нууц үгийг харуулах
      </label>
      <NoteLine note={note} />
      <div className="flex justify-end">
        <button className="btn-primary" disabled={saving || !current || !next || !again}>
          {saving ? 'Сольж байна…' : 'Нууц үг солих'}
        </button>
      </div>
    </form>
  );
}

function GoogleCard({ profile, clientId, onChanged }: { profile: Profile; clientId: string | null; onChanged: (p: Profile) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  // Linking and unlinking change how one signs in: the current password is asked first.
  const [password, setPassword] = useState('');

  async function link(credential: string) {
    if (!password) return setNote({ ok: false, text: 'Эхлээд одоогийн нууц үгээ оруулаад дараа нь Google товч дарна уу' });
    setBusy(true);
    setNote(null);
    try {
      onChanged(await api<Profile>('/auth/google/link', { method: 'POST', body: JSON.stringify({ credential, currentPassword: password }) }));
      setPassword('');
      setNote({ ok: true, text: 'Google бүртгэл холбогдлоо. Одоо нэвтрэх хуудсан дээрх Google товчоор нэвтэрч болно.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Холбож чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!password) return setNote({ ok: false, text: 'Салгахын тулд одоогийн нууц үгээ оруулна уу' });
    if (!window.confirm(`${profile.googleEmail ?? 'Google'} бүртгэлийг салгах уу? Дараа нь нууц үгээрээ нэвтэрнэ, бусад төхөөрөмжөөс гарна.`)) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await api<Session & { profile: Profile }>('/auth/google/unlink', { method: 'POST', body: JSON.stringify({ currentPassword: password }) });
      keepSession(res);
      onChanged(res.profile);
      setPassword('');
      setNote({ ok: true, text: 'Google бүртгэл салгагдлаа.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Салгаж чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  const passwordBox = (
    <label className="block max-w-sm text-xs text-slate-400">
      Одоогийн нууц үг
      <input className="mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
    </label>
  );

  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Google-ээр нэвтрэх</h2>
      {profile.googleLinked ? (
        <>
          <p className="text-sm">
            Холбогдсон: <span className="font-semibold text-emerald-300">{profile.googleEmail ?? 'Google бүртгэл'}</span>
          </p>
          {passwordBox}
          <button type="button" className="btn-ghost text-sm" disabled={busy || !password} onClick={() => void unlink()}>
            Салгах
          </button>
        </>
      ) : !clientId ? (
        <p className="text-sm text-slate-400">
          Админ Google нэвтрэлтийг хараахан тохируулаагүй байна. Тохируулсны дараа энд Gmail бүртгэлээ холбож, нууц үггүйгээр нэвтэрнэ.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-400">
            Gmail бүртгэлээ холбовол нэвтрэх хуудсан дээр «Google-ээр нэвтрэх» дарж шууд орно. Нууц үгээ оруулаад Google товч дарна уу.
            {profile.googleEmail ? ` Админ таны Google Gmail-ийг ${profile.googleEmail} гэж бүртгэсэн — тэр хаягаар шууд нэвтэрч болно.` : ''}
          </p>
          {passwordBox}
          <div className="max-w-sm">{!busy && <GoogleButton clientId={clientId} text="continue_with" onCredential={(c) => void link(c)} />}</div>
        </>
      )}
      <NoteLine note={note} />
    </section>
  );
}

function SessionsCard() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [password, setPassword] = useState('');

  async function logoutAll() {
    if (!window.confirm('Бусад бүх төхөөрөмж (утас, компьютер) дээрх нэвтрэлтийг хаах уу? Энэ төхөөрөмж нэвтэрсэн хэвээр үлдэнэ.')) return;
    setBusy(true);
    setNote(null);
    try {
      keepSession(await api<Session>('/auth/logout-all', { method: 'POST', body: JSON.stringify({ currentPassword: password }) }));
      setPassword('');
      setNote({ ok: true, text: 'Бусад төхөөрөмжөөс гаргалаа.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Чадсангүй' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-2">
      <h2 className="font-semibold">Нэвтэрсэн төхөөрөмжүүд</h2>
      <p className="text-sm text-slate-400">Утсаа гээсэн, эсвэл бусдын компьютер дээр нэвтэрч орхисон бол бусад бүх төхөөрөмжөөс гаргана.</p>
      <label className="block max-w-sm text-xs text-slate-400">
        Одоогийн нууц үг
        <input className="mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <NoteLine note={note} />
      <button type="button" className="btn-ghost text-sm" disabled={busy || !password} onClick={() => void logoutAll()}>
        Бусад бүх төхөөрөмжөөс гарах
      </button>
    </section>
  );
}
