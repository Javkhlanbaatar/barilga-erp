'use client';

import { isManager } from '@/lib/rbac';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthUser } from '@/lib/types';

export default function HrRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const role = raw ? (JSON.parse(raw) as AuthUser).role : null;
    router.replace(
      isManager(role)
        ? '/admin/attendance'
        : role === 'ACHIGCH_BELTGEGCH'
          ? '/warehouse/tickets'
          : '/pos',
    );
  }, [router]);
  return <div className="p-8 text-slate-400">Уншиж байна…</div>;
}
