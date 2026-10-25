'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/** Open dialogs, newest last: Esc closes only the top one (a question asked over a form must not close the form too). */
const openStack: object[] = [];
/**
 * The page's own overflow, saved when the first dialog opens and put back when the last one closes (not per dialog:
 * two stacked dialogs removed together would otherwise leave the page unable to scroll).
 */
let pageOverflow = '';

/**
 * A dialog that works on phones: the backdrop scrolls, so a form taller than the screen can always be scrolled
 * to its title and its buttons (the dialogs before were centred and clipped). Tap outside or Esc closes it,
 * unless `busy`. Once something was typed in it (or `dirty` says so), those and the ✕ ask first, so a stray tap
 * does not lose the form; the dialog's own «Болих» closes at once.
 */
export function Modal({
  onClose,
  title,
  size = 'md',
  busy = false,
  guardTyping = true,
  dirty = false,
  children,
  footer,
}: {
  onClose: () => void;
  title?: ReactNode;
  size?: keyof typeof WIDTH;
  busy?: boolean;
  /** Off for a dialog whose onClose already asks before dropping what was typed (then `dirty` is not used either). */
  guardTyping?: boolean;
  /** Changes made without typing (buttons, scans): also asked about before closing. */
  dirty?: boolean;
  children: ReactNode;
  /** Buttons kept visible at the bottom of the dialog while the content scrolls. */
  footer?: ReactNode;
}) {
  // The latest handler and state, so the key listener and the scroll lock are set up once per dialog.
  const close = useRef(onClose);
  const isBusy = useRef(busy);
  const guard = useRef(guardTyping);
  const changed = useRef(dirty);
  close.current = onClose;
  isBusy.current = busy;
  guard.current = guardTyping;
  changed.current = dirty;
  // Closes only when the press also started on the backdrop (not when selecting text that ends outside).
  const downOnBackdrop = useRef(false);
  // Something was typed or picked in the dialog.
  const typed = useRef(false);
  // Esc, a tap outside or the ✕ (never while busy; asks first once something was typed). Reads the refs, so stable.
  const dismiss = useRef(() => {
    if (isBusy.current) return;
    if (guard.current && (typed.current || changed.current) && !window.confirm('Бөглөсөн мэдээлэл хадгалагдахгүй. Хаах уу?')) return;
    close.current();
  }).current;

  useEffect(() => {
    const self = {};
    // The page behind does not scroll while any dialog is open.
    if (!openStack.length) {
      pageOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openStack.push(self);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openStack[openStack.length - 1] === self && dismiss();
    window.addEventListener('keydown', onKey);
    return () => {
      openStack.splice(openStack.indexOf(self), 1);
      window.removeEventListener('keydown', onKey);
      if (!openStack.length) document.body.style.overflow = pageOverflow;
    };
  }, [dismiss]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // A dialog rendered inside a clickable row must not click that row too.
        e.stopPropagation();
        if (downOnBackdrop.current && e.target === e.currentTarget) dismiss();
        downOnBackdrop.current = false;
      }}
    >
      <div
        className={`card relative mx-auto my-2 w-full ${WIDTH[size]} space-y-3 sm:my-10`}
        onInput={() => {
          typed.current = true;
        }}
      >
        {title !== undefined && (
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold">{title}</h3>
            <button type="button" className="btn-ghost -mr-1 -mt-1 h-9 w-9 shrink-0 p-0" aria-label="Хаах" onClick={dismiss}>
              ✕
            </button>
          </div>
        )}
        {children}
        {footer && <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-slate-800 bg-steel-900 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
