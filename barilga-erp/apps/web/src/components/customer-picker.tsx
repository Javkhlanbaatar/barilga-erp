'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Customer } from '@/lib/types';

/** Search registered customers at the till. Picking one links the order to them; walk-in sales need none. */
export function CustomerPicker({
  value,
  onChange,
  filter,
  allowCreate = false,
}: {
  value: Customer | null;
  onChange: (c: Customer | null) => void;
  /** Narrows the matches, e.g. to suppliers on a goods receipt. */
  filter?: (c: Customer) => boolean;
  /** Offer «+ Шинэ харилцагч» to register a company or a person on the spot. */
  allowCreate?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nc, setNc] = useState({ type: 'COMPANY' as 'COMPANY' | 'INDIVIDUAL', name: '', phone: '', regNumber: '' });
  const [err, setErr] = useState('');

  async function create() {
    setErr('');
    try {
      const c = await api<Customer>('/customers', {
        method: 'POST',
        body: JSON.stringify({ type: nc.type, name: nc.name.trim(), phone: nc.phone.trim(), regNumber: nc.regNumber.trim() || undefined }),
      });
      onChange(c);
      setCreating(false);
      setNc({ type: 'COMPANY', name: '', phone: '', regNumber: '' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Бүртгэж чадсангүй');
    }
  }

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        const found = await api<Customer[]>(`/customers?q=${encodeURIComponent(term)}`);
        setResults(filter ? found.filter(filter) : found);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [q]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-sm">
        <div className="min-w-0">
          <p className="font-medium truncate">{value.name}</p>
          <p className="text-xs text-slate-400">
            {value.phone}
            {value.regNumber ? ` · РД ${value.regNumber}` : ''} · бүртгэлтэй харилцагч
          </p>
        </div>
        <button type="button" className="btn-ghost text-xs px-2 py-1" onClick={() => onChange(null)}>
          Салгах
        </button>
      </div>
    );
  }

  if (creating) {
    return (
      <div className="space-y-2 rounded-lg border border-slate-700 p-2 text-xs">
        <div className="grid grid-cols-2 gap-1">
          {(
            [
              ['COMPANY', 'Байгууллага'],
              ['INDIVIDUAL', 'Хувь хүн'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" className={nc.type === k ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setNc({ ...nc, type: k })}>
              {l}
            </button>
          ))}
        </div>
        <input className="w-full" placeholder={nc.type === 'COMPANY' ? 'Байгууллагын нэр' : 'Овог нэр'} value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} />
        <input className="w-full" placeholder="Утас" inputMode="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} />
        <input
          className="w-full"
          placeholder={nc.type === 'COMPANY' ? 'РД (7 оронтой) — заавал' : 'Регистрийн дугаар (заавал биш)'}
          value={nc.regNumber}
          onChange={(e) => setNc({ ...nc, regNumber: e.target.value })}
        />
        {err && <p className="text-red-400">{err}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn-primary text-xs" disabled={nc.name.trim().length < 2 || nc.phone.trim().length < 8} onClick={() => void create()}>
            Бүртгээд сонгох
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setCreating(false)}>
            Болих
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {allowCreate && (
        <button
          type="button"
          className="absolute right-1 top-1 z-10 rounded px-2 py-1 text-xs text-amber-brand hover:underline"
          onClick={() => {
            setNc({ ...nc, name: q.trim() });
            setCreating(true);
          }}
        >
          + Шинэ
        </button>
      )}
      <input
        placeholder="Бүртгэлтэй харилцагч хайх (нэр, утас, РД)…"
        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-sm"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && q.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-700 bg-slate-950 shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">Олдсонгүй — доор гараар бичиж болно.</li>}
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-800"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c);
                  setQ('');
                  setOpen(false);
                }}
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-slate-400">
                  {' '}
                  · {c.phone}
                  {c.regNumber ? ` · ${c.regNumber}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
