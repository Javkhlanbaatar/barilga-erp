'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAvailableReports } from '@/components/reports-nav';
import { Shell } from '@/components/shell';

/** «Тайлан»: one place for every report the user may open. Opens the only one directly when there is one. */
export default function ReportsHubPage() {
  const router = useRouter();
  const reports = useAvailableReports();

  useEffect(() => {
    if (reports.length === 1) router.replace(reports[0].href);
  }, [reports, router]);

  return (
    <Shell>
      <div className="mb-4">
        <p className="text-amber-brand text-xs tracking-[0.2em] uppercase">Тайлан</p>
        <h2 className="text-xl font-bold">Тайлан</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {reports.map((r) => (
          <Link key={r.href} href={r.href} className="card hover:border-amber-600 transition-colors">
            <p className="font-semibold">{r.label}</p>
            <p className="text-sm text-slate-400 mt-1">{r.hint}</p>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
