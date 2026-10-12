'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Customer } from '@/lib/types';

/** Search registered customers at the till. Picking one links the order to them; walk-in sales need none. */
export function CustomerPicker({ value, onChange }: { value: Customer | null; onChange: (c: Customer | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        setResults(await api<Customer[]>(`/customers?q=${encodeURIComponent(term)}`));
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

  return (
    <div className="relative">
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
