// Worker entry: serves the static apps and gates /api/* traffic to the single
// MangoEvent Durable Object. Admin authorization happens here (stateless HMAC
// session verification); the DO trusts the internal `x-mt-admin` header,
// which is always stripped from inbound requests first.

import type { MangoEvent } from './event-do';
import {
  clearSessionCookie,
  getCookie,
  mintSession,
  SESSION_COOKIE,
  sessionCookie,
  verifySession,
} from './session';

export { MangoEvent } from './event-do';

export interface Env {
  ASSETS: Fetcher;
  EVENT_DO: DurableObjectNamespace<MangoEvent>;
  /** Set via `wrangler secret put ADMIN_PASSWORD` (or .dev.vars locally). */
  ADMIN_PASSWORD: string;
  /** Optional separate signing secret; falls back to ADMIN_PASSWORD. */
  SESSION_SECRET?: string;
}

const ADMIN_HEADER = 'x-mt-admin';

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function signingSecret(env: Env): string {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.ADMIN_PASSWORD) {
      return json({ error: 'Server is missing ADMIN_PASSWORD secret' }, 500);
    }

    const secure = url.protocol === 'https:';
    const stub = env.EVENT_DO.get(env.EVENT_DO.idFromName('mango-tango'));

    // Never trust an inbound admin marker.
    const headers = new Headers(request.headers);
    headers.delete(ADMIN_HEADER);

    const token = getCookie(request, SESSION_COOKIE);
    const isAdmin = token ? await verifySession(signingSecret(env), token) : false;
    if (isAdmin) headers.set(ADMIN_HEADER, '1');

    // Login: the DO validates the password (it owns per-IP rate limiting);
    // on success the Worker mints the session cookie.
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      const res = await stub.fetch(new Request(request, { headers }));
      if (!res.ok) return res;
      const fresh = await mintSession(signingSecret(env));
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(fresh, secure) });
    }

    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(secure) });
    }

    if (url.pathname === '/api/admin/session' && request.method === 'GET') {
      return json({ admin: isAdmin });
    }

    if (url.pathname.startsWith('/api/admin/') && !isAdmin) {
      return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }

    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
