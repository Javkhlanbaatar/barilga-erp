'use client';

import { createContext, useContext, useState } from 'react';
import type { DocTemplate } from '@/lib/types';

/**
 * Visual template editing. Printed documents are built from parts: required ones (number, goods, total…)
 * are always printed; optional ones can be switched off. In design mode every part shows an outline with a
 * switch, switched-off parts stay visible (faded) so they can be brought back, and texts are typed in place.
 * Outside design mode (printing) nothing of this shows and switched-off parts are simply not rendered.
 */
type Design = {
  on: boolean;
  t: DocTemplate;
  set: (patch: Partial<DocTemplate>) => void;
};

const DesignContext = createContext<Design | null>(null);

export function DocDesignProvider({ t, set, children }: { t: DocTemplate; set: (p: Partial<DocTemplate>) => void; children: React.ReactNode }) {
  return <DesignContext.Provider value={{ on: true, t, set }}>{children}</DesignContext.Provider>;
}

export function useDesign() {
  return useContext(DesignContext);
}

/** Is an optional part switched on in this template? */
export function shown(t: DocTemplate | undefined, key: string) {
  return !(t?.hidden ?? []).includes(key);
}

/**
 * One part of a document. `required` parts cannot be switched off (a lock is shown in design mode).
 * `inline` keeps it inside a line of text (span) instead of a block.
 */
export function Part({
  k,
  label,
  required = false,
  inline = false,
  t,
  children,
}: {
  k: string;
  label: string;
  required?: boolean;
  inline?: boolean;
  /** The template, when the part is rendered outside the editor (printing). */
  t?: DocTemplate;
  children: React.ReactNode;
}) {
  const design = useDesign();
  const tpl = design?.t ?? t;
  const isShown = required || shown(tpl, k);
  if (!design) return isShown ? <>{children}</> : null;

  const toggle = () => {
    const hidden = new Set(design.t.hidden ?? []);
    if (hidden.has(k)) hidden.delete(k);
    else hidden.add(k);
    design.set({ hidden: [...hidden] });
  };
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={`doc-part group/part relative ${inline ? 'inline-block' : ''} ${isShown ? '' : 'doc-part-off'}`}>
      <span className="doc-part-tab">
        {required ? (
          <span title="Заавал хэвлэгдэнэ — хасах боломжгүй">🔒 {label}</span>
        ) : (
          <button type="button" onClick={toggle} title={isShown ? 'Дарж хасна' : 'Дарж буцааж нэмнэ'}>
            {isShown ? '👁' : '🚫'} {label}
          </button>
        )}
      </span>
      {children}
    </Tag>
  );
}

/** A text from the template, typed straight on the document in design mode. */
export function EditText({
  field,
  fallback,
  placeholder,
  className = '',
  multiline = false,
  t,
}: {
  field: 'title' | 'headerNote' | 'footerNote';
  fallback?: string;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  t?: DocTemplate;
}) {
  const design = useDesign();
  const value = (design?.t ?? t)?.[field] ?? '';
  if (!design) {
    const text = value || fallback || '';
    return text ? <span className={`${className} ${multiline ? 'whitespace-pre-line' : ''}`}>{text}</span> : null;
  }
  return (
    <span
      className={`doc-edit ${className} ${multiline ? 'block whitespace-pre-line' : ''} ${value ? '' : 'doc-edit-empty'}`}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder ?? fallback ?? 'Бичих…'}
      onBlur={(e) => design.set({ [field]: (e.currentTarget.innerText ?? '').trim() } as Partial<DocTemplate>)}
    >
      {value || (fallback && !multiline ? fallback : '')}
    </span>
  );
}

/** Signature lines; in design mode each name is typed in place, with × to remove and + to add (up to 4). */
export function SignatureNames({ names, signer }: { names: string[]; signer?: string }) {
  const design = useDesign();
  const [draft, setDraft] = useState('');
  if (!design) {
    return (
      <>
        {names.map((n, i) => (
          <p key={`${n}-${i}`}>
            {n}: ______________________{i === 0 && signer ? ` /${signer}/` : ''}
          </p>
        ))}
      </>
    );
  }
  const list = design.t.signatures;
  const setList = (next: string[]) => design.set({ signatures: next.filter((x) => x.trim()).slice(0, 4) });
  return (
    <>
      {list.map((n, i) => (
        <p key={`${n}-${i}`} className="flex items-center gap-1">
          <span
            className="doc-edit"
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) => setList(list.map((x, j) => (j === i ? e.currentTarget.innerText.trim() : x)))}
          >
            {n}
          </span>
          : ________
          <button type="button" className="doc-x" onClick={() => setList(list.filter((_, j) => j !== i))} title="Хасах">
            ×
          </button>
        </p>
      ))}
      {list.length < 4 && (
        <p className="flex items-center gap-1">
          <input
            className="doc-add-input"
            placeholder="+ гарын үсэг нэмэх"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                e.preventDefault();
                setList([...list, draft.trim()]);
                setDraft('');
              }
            }}
            onBlur={() => {
              if (draft.trim()) {
                setList([...list, draft.trim()]);
                setDraft('');
              }
            }}
          />
        </p>
      )}
    </>
  );
}

/** Styles for design mode (outlines, tabs, faded parts); harmless when printing. */
export const DESIGN_CSS = `
  .doc-part { outline: 1px dashed transparent; outline-offset: 2px; border-radius: 2px; }
  .design .doc-part { outline-color: #cbd5e1; margin-top: 2px; }
  .design .doc-part:hover { outline-color: #f59e0b; }
  .doc-part-tab { display: none; }
  .design .doc-part-tab { display: block; position: absolute; top: -9px; right: 2px; z-index: 20; font-size: 9px; line-height: 14px;
    background: #fff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 0 4px; color: #475569; white-space: nowrap; }
  .design .doc-part-tab button { cursor: pointer; }
  .design .doc-part:hover > .doc-part-tab { border-color: #f59e0b; color: #b45309; }
  .design .doc-part-off > *:not(.doc-part-tab) { opacity: .25; text-decoration: line-through; }
  .design .doc-part-off { outline-color: #fca5a5; }
  .doc-edit { outline: none; border-bottom: 1px dotted #f59e0b; min-width: 2em; cursor: text; }
  .doc-edit-empty:empty::before { content: attr(data-placeholder); color: #94a3b8; font-style: italic; }
  .doc-x { color: #dc2626; font-weight: bold; padding: 0 4px; }
  .doc-add-input { border: 1px dashed #94a3b8; border-radius: 4px; padding: 0 4px; font-size: 11px; background: #fff; color: #0f172a; width: 12rem; }
`;

/**
 * A part switched by a yes/no field of the template (stamp box, empty buyer lines, prices). In design mode
 * it shows its switch; when off the part is shown faded so it can be switched back on.
 */
export function FlagPart({
  field,
  label,
  t,
  inline = false,
  indicator = false,
  children,
}: {
  field: 'stamp' | 'blankBuyer' | 'showPrices';
  label: string;
  t?: DocTemplate;
  inline?: boolean;
  /** Only a switch for the editor: prints nothing. */
  indicator?: boolean;
  children: React.ReactNode;
}) {
  const design = useDesign();
  const on = Boolean((design?.t ?? t)?.[field]);
  if (!design) return on && !indicator ? <>{children}</> : null;
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={`doc-part relative ${inline ? 'inline-block' : ''} ${on ? '' : 'doc-part-off'}`}>
      <span className="doc-part-tab">
        <button type="button" onClick={() => design.set({ [field]: !on } as Partial<DocTemplate>)}>
          {on ? '☑' : '☐'} {label}
        </button>
      </span>
      {children}
    </Tag>
  );
}

/** Design mode only: + / − empty rows under the goods. */
export function BlankRowsControl() {
  const design = useDesign();
  if (!design) return null;
  const n = design.t.blankRows;
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
      Гараар бөглөх хоосон мөр: <b>{n}</b>
      <button type="button" className="rounded border border-slate-300 px-2" onClick={() => design.set({ blankRows: Math.max(0, n - 1) })}>
        −
      </button>
      <button type="button" className="rounded border border-slate-300 px-2" onClick={() => design.set({ blankRows: Math.min(20, n + 1) })}>
        +
      </button>
    </div>
  );
}
