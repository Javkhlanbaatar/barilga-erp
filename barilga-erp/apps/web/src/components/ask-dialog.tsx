'use client';

import { FormEvent, useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal } from './modal';

export type AskField = {
  key: string;
  label: string;
  initial?: string;
  placeholder?: string;
  /** Numbers on a phone keypad. */
  numeric?: boolean;
  /** At least this many letters (after trimming); 0 = may be empty. */
  minLength?: number;
  maxLength?: number;
};

export type AskOptions = {
  title: string;
  /** A line above the boxes (what is being changed, the current value…). */
  intro?: ReactNode;
  fields: AskField[];
  confirmText?: string;
  /** Extra check before closing: a message to show, or '' when the values are fine. */
  validate?: (values: Record<string, string>) => string;
};

/** The `ask` of useAsk, for helpers that ask on a page's behalf. */
export type Ask = (opts: AskOptions) => Promise<Record<string, string> | null>;

/**
 * A question asked in the page instead of window.prompt (which some browsers and in-app views block, so the
 * action silently did nothing). `ask` resolves with the trimmed values, or null when cancelled; render `dialog`.
 */
export function useAsk() {
  const [state, setState] = useState<AskOptions | null>(null);
  const resolver = useRef<((v: Record<string, string> | null) => void) | null>(null);

  const ask = useCallback(
    (opts: AskOptions) =>
      new Promise<Record<string, string> | null>((resolve) => {
        resolver.current?.(null);
        resolver.current = resolve;
        setState(opts);
      }),
    [],
  );

  const finish = (v: Record<string, string> | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setState(null);
  };

  const dialog = state ? <AskModal key={state.title} opts={state} onDone={finish} /> : null;
  return [ask, dialog] as const;
}

function AskModal({ opts, onDone }: { opts: AskOptions; onDone: (v: Record<string, string> | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(opts.fields.map((f) => [f.key, f.initial ?? ''])));
  const [error, setError] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
    for (const f of opts.fields) {
      if ((f.minLength ?? 0) > 0 && trimmed[f.key].length < (f.minLength ?? 0)) {
        // «Шалтгаан» rather than the whole label with its note in brackets.
        return setError(`«${f.label.split(' (')[0]}» ${f.minLength}-аас доошгүй тэмдэгт байна`);
      }
    }
    const problem = opts.validate?.(trimmed) ?? '';
    if (problem) return setError(problem);
    onDone(trimmed);
  }

  return (
    <Modal
      title={opts.title}
      size="sm"
      // A short question: closing it loses little, and must not raise a browser dialog of its own.
      guardTyping={false}
      onClose={() => onDone(null)}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={() => onDone(null)}>
            Болих
          </button>
          <button type="submit" form="ask-form" className="btn-primary">
            {opts.confirmText ?? 'Хадгалах'}
          </button>
        </>
      }
    >
      <form id="ask-form" onSubmit={submit} className="space-y-3">
        {opts.intro && <div className="text-sm text-slate-300">{opts.intro}</div>}
        {opts.fields.map((f, i) => (
          <label key={f.key} className="block text-xs text-slate-400">
            {f.label}
            <input
              className={`mt-1 w-full ${f.numeric ? 'text-right' : ''}`}
              inputMode={f.numeric ? 'numeric' : undefined}
              autoFocus={i === 0}
              placeholder={f.placeholder}
              maxLength={f.maxLength ?? 300}
              value={values[f.key]}
              onChange={(e) => {
                setValues({ ...values, [f.key]: e.target.value });
                setError('');
              }}
            />
          </label>
        ))}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </Modal>
  );
}
