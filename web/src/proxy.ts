import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ============================================================================
// UPSTASH REDIS RATE LIMITER
// Cluster-wide limits — works correctly across all Vercel function instances.
// Each route gets its own Ratelimit instance with a sliding window algorithm.
// ============================================================================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Sliding window gives smooth limiting without the burst problem of fixed windows.
// Each limiter is keyed by (limiter name + identifier) inside Upstash automatically.
const limiters = {
  // Payment routes — strictest
  generator_search:     new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(2,  '30 s'), prefix: 'rl:gen_search' }),
  marketplace_purchase: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5,  '60 s'), prefix: 'rl:mkt_purchase' }),
  exchange_purchase:    new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5,  '60 s'), prefix: 'rl:ex_purchase' }),
  exchange_list:        new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3,  '60 s'), prefix: 'rl:ex_list' }),

  // Signed actions — moderate
  exchange_cancel:      new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '60 s'), prefix: 'rl:ex_cancel' }),
  vault_reveal:         new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5,  '60 s'), prefix: 'rl:vlt_reveal' }),
  vault_purge:          new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5,  '60 s'), prefix: 'rl:vlt_purge' }),
  admin_burn:           new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '60 s'), prefix: 'rl:adm_burn' }),

  // Read routes — lenient
  vault_fetch:          new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(15, '60 s'), prefix: 'rl:vlt_fetch' }),
};

// ============================================================================
// ROUTE → LIMITER MAP
// ============================================================================
const ROUTE_LIMITERS: Array<[string, keyof typeof limiters]> = [
  ['/api/generator/search',     'generator_search'],
  ['/api/marketplace/purchase', 'marketplace_purchase'],
  ['/api/exchange/purchase',    'exchange_purchase'],
  ['/api/exchange/list',        'exchange_list'],
  ['/api/exchange/cancel',      'exchange_cancel'],
  ['/api/vault/reveal',         'vault_reveal'],
  ['/api/vault/purge',          'vault_purge'],
  ['/api/vault/fetch',          'vault_fetch'],
  ['/api/admin/burn',           'admin_burn'],
];

// ============================================================================
// IDENTIFIER
// Prefer wallet address (set by client on every authenticated request).
// Fall back to IP for unauthenticated routes.
// ============================================================================
function getIdentifier(req: NextRequest): string {
  const wallet = req.headers.get('x-wallet-address');
  if (wallet && wallet.length > 20) return wallet;

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return req.headers.get('x-real-ip') || 'unknown';
}

// ============================================================================
// MIDDLEWARE
// ============================================================================
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  for (const [prefix, limiterKey] of ROUTE_LIMITERS) {
    if (!pathname.startsWith(prefix)) continue;

    const identifier = getIdentifier(req);

    try {
      const { success, limit, remaining, reset } = await limiters[limiterKey].limit(identifier);

      if (!success) {
        const retryAfterSeconds = Math.ceil((reset - Date.now()) / 1000);
        console.warn(`[RateLimit] ${limiterKey} — ${identifier} blocked (${limit} req/window)`);

        return new NextResponse(
          JSON.stringify({ error: 'Too many requests. Please slow down.' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfterSeconds),
              'X-RateLimit-Limit': String(limit),
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(reset),
            },
          }
        );
      }

      // Pass through — attach remaining count headers for client visibility
      const response = NextResponse.next();
      response.headers.set('X-RateLimit-Limit', String(limit));
      response.headers.set('X-RateLimit-Remaining', String(remaining));
      response.headers.set('X-RateLimit-Reset', String(reset));
      return response;

    } catch (err) {
      // If Upstash is unreachable, fail open — don't block legitimate traffic
      console.error(`[RateLimit] Upstash error on ${limiterKey}:`, err);
      return NextResponse.next();
    }
  }

  return NextResponse.next();
}

// ============================================================================
// MATCHER
// ============================================================================
export const config = {
  matcher: [
    '/api/generator/:path*',
    '/api/marketplace/:path*',
    '/api/exchange/:path*',
    '/api/vault/:path*',
    '/api/admin/:path*',
  ],
};
