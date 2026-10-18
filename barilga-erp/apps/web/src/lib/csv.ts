/** Downloads rows as a CSV that Excel opens with Cyrillic intact (UTF-8 with BOM). */
export function downloadCsv(filename: string, head: string[], rows: Array<Array<string | number | null | undefined>>) {
  const cell = (c: string | number | null | undefined) => `"${String(c ?? '').replace(/"/g, '""')}"`;
  const text = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
