'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/pos' : '/login');
  }, [router]);
  return <div className="p-8 text-slate-400">Уншиж байна…</div>;
}
