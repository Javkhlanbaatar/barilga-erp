'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FeatureKey, FeatureSwitch } from '@/lib/types';

type FeatureMap = Partial<Record<FeatureKey, boolean>>;

let cache: FeatureMap | null = null;
let inflight: Promise<FeatureMap> | null = null;

/** Fetches the module switches once per page load. The server enforces them; this only hides the UI. */
export function loadFeatures(force = false): Promise<FeatureMap> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight || force) {
    inflight = api<FeatureSwitch[]>('/features')
      .then((rows) => {
        cache = Object.fromEntries(rows.map((r) => [r.key, r.enabled])) as FeatureMap;
        return cache;
      })
      .catch(() => {
        // Unknown = shown; the API still refuses a switched-off module.
        cache = {};
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** `enabled(key)` is true until the server says the module is off. */
export function useFeatures() {
  const [map, setMap] = useState<FeatureMap>(cache ?? {});
  useEffect(() => {
    let alive = true;
    void loadFeatures().then((m) => alive && setMap(m));
    return () => {
      alive = false;
    };
  }, []);
  return { enabled: (key: FeatureKey) => map[key] !== false };
}
