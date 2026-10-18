'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { AuthUser, ROLE_LABEL } from '@/lib/types';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('expired')) setError('Нэвтрэх хугацаа дууссан тул дахин нэвтэрнэ үү.');
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ accessToken: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('barilga_token', res.accessToken);
      localStorage.setItem('barilga_user', JSON.stringify(res.user));
      router.push(res.user.role === 'ACHIGCH_BELTGEGCH' ? '/warehouse/tickets' : '/pos');
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
