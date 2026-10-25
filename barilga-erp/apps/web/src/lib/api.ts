const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export function apiOrigin() {
  try {
    return new URL(API).origin;
  } catch {
    return 'http://localhost:4000';
  }
}

/** Absolute URL for product photos (uploaded path or external http URL). */
export function mediaUrl(path?: string | null) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path;
  const prefix = path.startsWith('/') ? path : `/${path}`;
  return `${apiOrigin()}${prefix}`;
}

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('barilga_token');
}

export async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message
      ? Array.isArray(data.message)
        ? data.message.join(', ')
        : data.message
      : res.statusText;
    throw new Error(message);
  }
  return data as T;
}

export function orderTrackingUrl(token?: string | null) {
  if (!token || typeof window === 'undefined') return '';
  return `${window.location.origin}/track/${token}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message
      ? Array.isArray(data.message)
        ? data.message.join(', ')
        : data.message
      : res.statusText;
    throw new Error(message);
  }
  return data as T;
}

export async function apiUpload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const token = getToken();
  const body = new FormData();
  body.append(field, file);
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message
      ? Array.isArray(data.message)
        ? data.message.join(', ')
        : data.message
      : res.statusText;
    throw new Error(message);
  }
  return data as T;
}

export function tugrik(n: number) {
  return `${new Intl.NumberFormat('mn-MN').format(Math.round(n))}₮`;
}
