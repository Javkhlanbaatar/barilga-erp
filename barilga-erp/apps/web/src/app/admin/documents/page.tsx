'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DocTemplatesForm } from '@/components/doc-templates-form';
import { Shell } from '@/components/shell';
import { TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';
import type { AuthUser } from '@/lib/types';

/** Баримтын загвар: admin and the general manager set the wording of invoices, issue notes and receipts. */
export default function DocumentTemplatesPage() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const raw = localStorage.getItem('barilga_user');
    const me = raw ? (JSON.parse(raw) as AuthUser) : null;
    if (!hasRole(me?.role, TOP_ROLES)) {
      router.replace(homeForRole(me?.role));
      return;
    }
    setOk(true);
  }, [router]);
  if (!ok) return <div className="p-8 text-slate-400">Уншиж байна…</div>;
  return (
    <Shell>
      <h2 className="text-xl font-bold">Баримтын загвар</h2>
      <p className="mt-1 text-sm text-slate-400">
        Өөрчлөлт бүр «Тайлан → Засварын түүх»-д хэн, хэзээ гэдэгтэйгээ бичигдэнэ. Нэхэмжлэхийн холбоосоор илгээсэн нэхэмжлэх дээр ч мөн гарна.
      </p>
      <DocTemplatesForm />
    </Shell>
  );
}
