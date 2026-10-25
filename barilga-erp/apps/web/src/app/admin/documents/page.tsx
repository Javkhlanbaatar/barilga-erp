'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DocTemplatesForm } from '@/components/doc-templates-form';
import { Shell } from '@/components/shell';
import { useCan } from '@/lib/permissions';
import { TOP_ROLES, hasRole, homeForRole } from '@/lib/rbac';
import type { AuthUser } from '@/lib/types';

/**
 * View only: the shared form edits by clicking on the sample document, so for someone the admin took the right
 * from, clicks on the sample, the save buttons and the editing help are switched off here (the server refuses
 * saves anyway). Switching between documents stays.
 */
const VIEW_ONLY_CSS = `
  .doc-view-only .print-doc { pointer-events: none; }
  .doc-view-only > div > div > span.ml-auto, .doc-view-only > div > p.text-xs { display: none; }
`;

/** Баримтын загвар: admin and the general manager set the wording of invoices, issue notes and receipts. */
export default function DocumentTemplatesPage() {
  const router = useRouter();
  const can = useCan();
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
  const canEdit = can('DOC_TEMPLATE_EDIT');
  return (
    <Shell>
      <h2 className="text-xl font-bold">Баримтын загвар</h2>
      <p className="mt-1 text-sm text-slate-400">
        Өөрчлөлт бүр «Тайлан → Засварын түүх»-эд хэн, хэзээ гэдэгтэйгээ бичигдэнэ. Нэхэмжлэхийн холбоосоор илгээсэн нэхэмжлэх дээр ч мөн гарна.
      </p>
      {!canEdit && (
        <p className="mt-2 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          Танд баримтын загвар засах эрх байхгүй — зөвхөн харна.
        </p>
      )}
      <div className={canEdit ? undefined : 'doc-view-only'}>
        <DocTemplatesForm />
      </div>
      {!canEdit && <style>{VIEW_ONLY_CSS}</style>}
    </Shell>
  );
}
