'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { can, savedUser } from '@/lib/permissions';

/** «Хүний нөөц»: whoever looks after attendance goes to the staff board, everyone else to their own attendance. */
export default function HrRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    const user = savedUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    router.replace(can(user, 'ATTENDANCE_MANAGE') ? '/admin/attendance' : '/me/attendance');
  }, [router]);
  return <div className="p-8 text-slate-400">Уншиж байна…</div>;
}
