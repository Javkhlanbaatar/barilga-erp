'use client';

import { useState } from 'react';
import { mediaUrl } from '@/lib/api';

function Placeholder({ className }: { className?: string }) {
  return (
    <div className={`grid place-items-center bg-steel-800 text-slate-500 ${className ?? ''}`}>
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.5" />
        <path d="M21 16.5 16 12l-4.5 4.5-2-2L3 19" />
      </svg>
    </div>
  );
}

export function ProductImage({
  src,
  alt,
  className = 'h-28 w-full rounded-lg',
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  const url = mediaUrl(src);
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <Placeholder className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className={`${className} object-cover`}
      onError={() => setBroken(true)}
    />
  );
}
