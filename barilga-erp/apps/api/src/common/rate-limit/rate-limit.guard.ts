import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

export type RateLimitOptions = {
  /** Bucket name; each (name, client IP) pair has its own counter. */
  name: string;
  /** Max requests allowed inside the window. */
  limit: number;
  windowMs: number;
};

export const RATE_LIMIT_KEY = 'barilga:rate-limit';

/** Apply with `@UseGuards(RateLimitGuard)` on a controller or handler. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

const MAX_TRACKED_KEYS = 50_000;
const SWEEP_EVERY_MS = 60_000;
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Sliding-window, in-memory limiter keyed by client IP.
 *
 * Limitation: counters live in process memory, so with PM2 cluster mode (`instances: 'max'`)
 * each worker enforces its own budget. Behind nginx, set TRUST_PROXY (see main.ts) so `req.ip`
 * is the real client rather than the proxy.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private static hits = new Map<string, number[]>();
  private static lastSweep = 0;

  constructor(private readonly reflector: Reflector) {}

  /** Test helper. */
  static reset() {
    RateLimitGuard.hits.clear();
    RateLimitGuard.lastSweep = 0;
  }

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const key = `${options.name}:${ip}`;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    const recent = (RateLimitGuard.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= options.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1000));
      RateLimitGuard.hits.set(key, recent);
      res.setHeader?.('Retry-After', String(retryAfterSec));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests. Please try again later.', error: 'Too Many Requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    RateLimitGuard.hits.set(key, recent);
    RateLimitGuard.sweep(now);
    return true;
  }

  private static sweep(now: number) {
    if (now - RateLimitGuard.lastSweep < SWEEP_EVERY_MS && RateLimitGuard.hits.size <= MAX_TRACKED_KEYS) {
      return;
    }
    RateLimitGuard.lastSweep = now;
    for (const [key, times] of RateLimitGuard.hits) {
      if (!times.length || times[times.length - 1] < now - STALE_AFTER_MS) {
        RateLimitGuard.hits.delete(key);
      }
    }
    if (RateLimitGuard.hits.size > MAX_TRACKED_KEYS) {
      let toDrop = RateLimitGuard.hits.size - MAX_TRACKED_KEYS;
      for (const key of RateLimitGuard.hits.keys()) {
        if (toDrop-- <= 0) break;
        RateLimitGuard.hits.delete(key);
      }
    }
  }
}
