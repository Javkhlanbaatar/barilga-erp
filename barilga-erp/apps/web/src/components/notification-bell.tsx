'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export type Alert = { key: string; level: 'danger' | 'warn' | 'info'; title: string; detail?: string; count: number; href: string };
type Feed = { alerts: Alert[]; total: number; at: string };

const DOT: Record<Alert['level'], string> = { danger: 'bg-red-500', warn: 'bg-amber-400', info: 'bg-sky-400' };

/** Polls the alerts once a minute and on every page change; one fetch shared by every bell on the page. */
export function useAlerts(enabled: boolean, pathname: string) {
  const [feed, setFeed] = useState<Feed | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = () =>
      api<Feed>('/notifications')
        .then((f) => alive && setFeed(f))
        .catch(() => undefined);
    void poll();
    const h = window.setInterval(poll, 60_000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [enabled, pathname]);
  return feed;
}

/** Сануулга: a bell with the number of things to act on, opening a list that links to where to fix each. */
export function NotificationBell({ feed, align = 'left' }: { feed: Feed | null; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const alerts = feed?.alerts ?? [];
  const urgent = alerts.some((a) => a.level === 'danger');
  const count = alerts.length;

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className="relative rounded-md p-1.5 hover:bg-steel-800"
        aria-label={`Сануулга${count ? ` (${count})` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && (
          <span
            className={`absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-center text-[10px] font-bold leading-[18px] text-white ${
              urgent ? 'bg-red-600' : 'bg-amber-600'
            }`}
          >
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`absolute z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-steel-900 shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <p className="border-b border-slate-800 px-3 py-2 text-sm font-semibold">Сануулга</p>
          {alerts.length === 0 && <p className="px-3 py-4 text-sm text-slate-400">Анхаарах зүйл алга ✓</p>}
          <ul className="max-h-[60vh] overflow-auto">
            {alerts.map((a) => (
              <li key={a.key}>
                <Link href={a.href} onClick={() => setOpen(false)} className="flex gap-2 px-3 py-2 text-sm hover:bg-steel-800">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[a.level]}`} />
                  <span className="flex-1">
                    {a.title}
                    {a.detail && <span className="block text-[11px] text-slate-400">{a.detail}</span>}
                  </span>
                  <span className="font-semibold">{a.count}</span>
                </Link>
              </li>
            ))}
          </ul>
          {feed && (
            <p className="border-t border-slate-800 px-3 py-1.5 text-[10px] text-slate-500">
              Шинэчилсэн {new Date(feed.at).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' })} · асуудлыг засахад автоматаар арилна
            </p>
          )}
        </div>
      )}
    </div>
  );
}
