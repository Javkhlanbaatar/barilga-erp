'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function WarehouseIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/warehouse/tickets');
  }, [router]);
  return <div className="p-8 text-slate-400">Уншиж байна…</div>;
}
