'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GoogleButton } from '@/components/google-button';
import { api } from '@/lib/api';
import { AuthUser, ROLE_LABEL } from '@/lib/types';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Google's client id when the admin has set Google sign-in up (null = not offered).
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('expired')) setError('Нэвтрэх хугацаа дууссан эсвэл өөр төхөөрөмжөөс гарсан тул дахин нэвтэрнэ үү.');
    api<{ googleClientId: string | null }>('/auth/config')
      .then((c) => setGoogleClientId(c.googleClientId))
      .catch(() => setGoogleClientId(null));
  }, []);

  function signedIn(res: { accessToken: string; user: AuthUser }) {
    localStorage.setItem('barilga_token', res.accessToken);
    localStorage.setItem('barilga_user', JSON.stringify(res.user));
    router.push(res.user.role === 'ACHIGCH_BELTGEGCH' ? '/warehouse/tickets' : '/pos');
  }

  async function withGoogle(credential: string) {
    setBusy(true);
    setError('');
    try {
      signedIn(await api<{ accessToken: string; user: AuthUser }>('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google-ээр нэвтэрч чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ accessToken: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      signedIn(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Нэвтэрч чадсангүй');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-md card">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase mb-2">Barilga ERP</p>
        <h1 className="text-2xl font-bold mb-1">Барилгын хангамж</h1>
        <p className="text-slate-400 text-sm mb-6">Борлуулалт · агуулах · тооцоо</p>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm">
            Хэрэглэгчийн нэр / имэйл
            <input className="mt-1 w-full" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="block text-sm">
            Нууц үг
            <input
              type="password"
              className="mt-1 w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Нэвтэрч байна…' : 'Нэвтрэх'}
          </button>
        </form>
        {googleClientId && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="h-px flex-1 bg-slate-800" />
              эсвэл
              <span className="h-px flex-1 bg-slate-800" />
            </div>
            <GoogleButton clientId={googleClientId} onCredential={(c) => void withGoogle(c)} />
            <p className="text-center text-[11px] text-slate-500">
              Админы бүртгэсэн «Google Gmail» эсвэл «Миний бүртгэл»-ээс холбосон Google бүртгэлээр нэвтэрнэ.
            </p>
          </div>
        )}
        {process.env.NODE_ENV === 'development' && (
        <ul className="mt-6 text-xs text-slate-400 space-y-1">
          {(['ADMIN', 'SUPER_MANAGER', 'BORLUULAGCH', 'ACHIGCH_BELTGEGCH'] as const).map((role) => (
            <li key={role}>
              {ROLE_LABEL[role]} — {role === 'ADMIN' ? 'admin' : role === 'SUPER_MANAGER' ? 'manager' : role === 'BORLUULAGCH' ? 'cashier' : 'warehouse'} / Barilga123!
            </li>
          ))}
        </ul>
        )}
      </div>
    </main>
  );
}
