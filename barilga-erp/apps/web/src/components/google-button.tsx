'use client';

import { useEffect, useRef, useState } from 'react';

/** The parts of Google Identity Services (accounts.google.com/gsi/client) this page uses. */
type GoogleIdentity = {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (r: { credential?: string }) => void; ux_mode?: 'popup' | 'redirect'; auto_select?: boolean }): void;
      renderButton(el: HTMLElement, options: { theme?: string; size?: string; text?: string; shape?: string; width?: string; locale?: string }): void;
      disableAutoSelect(): void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

let loading: Promise<void> | null = null;

/** Loads Google's sign-in script once. */
function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    // hl: the language of Google's sign-in texts (Google's reference: gsi/client?hl=<code>).
    s.src = 'https://accounts.google.com/gsi/client?hl=mn';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Google-ийн нэвтрэх товч ачаалагдсангүй (интернэт холболтоо шалгана уу)'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Google's own «Sign in with Google» button. When the person picks their account, `onCredential` gets the ID token,
 * which the API checks with Google before signing anyone in.
 */
export function GoogleButton({
  clientId,
  onCredential,
  text = 'signin_with',
}: {
  clientId: string;
  onCredential: (credential: string) => void;
  text?: 'signin_with' | 'continue_with';
}) {
  const box = useRef<HTMLDivElement>(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    loadGoogle()
      .then(() => {
        if (!alive || !box.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          auto_select: false,
          callback: (r) => r.credential && handler.current(r.credential),
        });
        window.google.accounts.id.renderButton(box.current, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text,
          locale: 'mn',
          // Pixels as text, at most 400 (Google's reference).
          width: String(Math.min(400, Math.max(200, box.current.offsetWidth || 300))),
        });
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'Google товч ачаалагдсангүй'));
    return () => {
      alive = false;
    };
  }, [clientId, text]);

  return (
    <div>
      <div ref={box} className="flex min-h-[44px] w-full justify-center" />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
