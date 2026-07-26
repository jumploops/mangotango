// The MangoEvent Durable Object: authoritative, serialized coordinator for
// one Mango Tango event. Persistent state lives in the DO's SQLite storage;
// live clients hold hibernatable WebSockets and receive full snapshots of
// event config + mango list on every change (the list is tiny, so snapshot
// patches are simpler and safer than granular diffs).

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import type {
  AdminState,
  AdminStats,
  ApiError,
  AuditEntry,
  EventConfig,
  EventStatus,
  GuestState,
  Mango,
  MangoAdminInfo,
  MangoResult,
  PatchMessage,
  RatingEntry,
  RecentSubmission,
  StatsMessage,
  SubmissionSummary,
  SubmittedScore,
} from '../../shared/types';
import { isValidClientId, isValidScore } from '../../shared/types';
import CATALOG from '../../shared/mangoes.json';

const EVENT_ID = 'mango-tango';
const ADMIN_HEADER = 'x-mt-admin';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS event (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    submissions_open INTEGER NOT NULL DEFAULT 1,
    require_all INTEGER NOT NULL DEFAULT 1,
    allow_resubmit INTEGER NOT NULL DEFAULT 1,
    results_visible INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mangoes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    required_for_submit INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS participants (
    client_id TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_connected INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS ratings (
    client_id TEXT NOT NULL,
    mango_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    client_rev INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, mango_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_client ON submissions(client_id, status)`,
  `CREATE TABLE IF NOT EXISTS submitted_scores (
    submission_id TEXT NOT NULL,
    mango_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    mango_name TEXT NOT NULL,
    PRIMARY KEY (submission_id, mango_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
];

/** The event's mango catalog lives in shared/mangoes.json; bump this when the
    catalog changes so existing events pick up the update on next boot. */
const SEED_VERSION = '2';

/** Placeholder demo mangoes from seed v1 — replaced by the real catalog. */
const LEGACY_SAMPLES = [
  'Alphonso',
  'Ataulfo (Honey)',
  'Kent',
  'Keitt',
  'Tommy Atkins',
  'Nam Dok Mai',
];

interface EventRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  status: string;
  submissions_open: number;
  require_all: number;
  allow_resubmit: number;
  results_visible: number;
  message: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface MangoRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  description: string;
  details: string;
  sort_order: number;
  available: number;
  required_for_submit: number;
  created_at: number;
  updated_at: number;
}

interface WsAttachment {
  clientId: string | null;
  admin: boolean;
}

interface Bucket {
  tokens: number;
  last: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function err(error: string, code: ApiError['code'], status: number, extra?: Partial<ApiError>): Response {
  return json({ ok: false, error, code, ...extra }, status);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  // Strip control characters, collapse whitespace runs, trim.
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0 || cleaned.length > maxLen) return null;
  return cleaned;
}

export class MangoEvent extends DurableObject<Env> {
  private sql: SqlStorage;
  private buckets = new Map<string, Bucket>();
  private loginFails = new Map<string, { count: number; lockedUntil: number }>();
  private statsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    // Additive migration for events created before the details column existed.
    try {
      this.sql.exec(`ALTER TABLE mangoes ADD COLUMN details TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists (fresh schema or already migrated).
    }
    this.seedIfEmpty();
    this.syncSeedCatalog();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private seedIfEmpty(): void {
    const now = Date.now();
    const hasEvent = this.sql.exec('SELECT id FROM event WHERE id = ?', EVENT_ID).toArray().length > 0;
    if (!hasEvent) {
      this.sql.exec(
        `INSERT INTO event (id, name, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)`,
        EVENT_ID, 'Mango Tango', now, now,
      );
      this.audit('event.seeded', 'Event created');
    }
  }

  /** One-time (per SEED_VERSION) sync of shared/mangoes.json into the DB.
      Upserts by name so host edits to ids/ratings survive catalog updates;
      also retires the v1 placeholder samples along with their ratings. */
  private syncSeedCatalog(): void {
    const applied = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'seed_version'`)
      .toArray()[0]?.value;
    if (applied === SEED_VERSION) return;

    const now = Date.now();
    const catalogNames = new Set(CATALOG.map((m) => m.name));
    for (const name of LEGACY_SAMPLES) {
      if (catalogNames.has(name)) continue;
      for (const row of this.sql
        .exec<{ id: string }>('SELECT id FROM mangoes WHERE name = ?', name)
        .toArray()) {
        this.sql.exec('DELETE FROM ratings WHERE mango_id = ?', row.id);
        this.sql.exec('DELETE FROM submitted_scores WHERE mango_id = ?', row.id);
        this.sql.exec('DELETE FROM mangoes WHERE id = ?', row.id);
      }
    }
    CATALOG.forEach((m, i) => {
      const existing = this.sql
        .exec<{ id: string }>('SELECT id FROM mangoes WHERE name = ?', m.name)
        .toArray()[0];
      if (existing) {
        this.sql.exec(
          'UPDATE mangoes SET description = ?, details = ?, updated_at = ? WHERE id = ?',
          m.summary, m.details, now, existing.id,
        );
      } else {
        this.sql.exec(
          `INSERT INTO mangoes (id, name, description, details, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(), m.name, m.summary, m.details, (i + 1) * 10, now, now,
        );
      }
    });
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('seed_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      SEED_VERSION,
    );
    this.bumpRevision();
    this.audit('event.catalog_synced', `Catalog v${SEED_VERSION}: ${CATALOG.length} mangoes`);
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const isAdmin = request.headers.get(ADMIN_HEADER) === '1';

    try {
      if (path === '/api/ws') return this.handleWebSocket(request, url, isAdmin);
      if (path === '/api/state' && method === 'GET') return this.handleGuestState(url);
      if (path === '/api/rate' && method === 'POST') return this.handleRate(request);
      if (path === '/api/submit' && method === 'POST') return this.handleSubmit(request);
      if (path === '/api/admin/login' && method === 'POST') return this.handleLogin(request);

      if (path.startsWith('/api/admin/')) {
        if (!isAdmin) return err('Unauthorized', 'unauthorized', 401);
        if (path === '/api/admin/state' && method === 'GET') return json(this.adminState());
        if (path === '/api/admin/event' && method === 'POST') return this.handleEventUpdate(request);
        if (path === '/api/admin/mango' && method === 'POST') return this.handleMangoCreate(request);
        if (path === '/api/admin/reorder' && method === 'POST') return this.handleReorder(request);
        const mangoMatch = path.match(/^\/api\/admin\/mango\/([A-Za-z0-9-]+)(\/delete)?$/);
        if (mangoMatch && method === 'POST') {
          return mangoMatch[2]
            ? this.handleMangoDelete(mangoMatch[1])
            : this.handleMangoUpdate(mangoMatch[1], request);
        }
        if (path === '/api/admin/export' && method === 'GET') {
          return this.handleExport(url.searchParams.get('format') ?? 'json');
        }
      }

      return err('Not found', 'not_found', 404);
    } catch (e) {
      if (e instanceof SyntaxError) return err('Invalid JSON body', 'invalid', 400);
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  private getEvent(): EventConfig {
    const row = this.sql.exec<EventRow>('SELECT * FROM event WHERE id = ?', EVENT_ID).one();
    return {
      id: row.id,
      name: row.name,
      status: row.status as EventStatus,
      submissionsOpen: !!row.submissions_open,
      requireAll: !!row.require_all,
      allowResubmit: !!row.allow_resubmit,
      resultsVisible: !!row.results_visible,
      message: row.message,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToMango(row: MangoRow): Mango {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      details: row.details,
      sortOrder: row.sort_order,
      available: !!row.available,
      requiredForSubmit: !!row.required_for_submit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private listMangoes(availableOnly: boolean): Mango[] {
    const where = availableOnly ? 'WHERE available = 1' : '';
    return this.sql
      .exec<MangoRow>(`SELECT * FROM mangoes ${where} ORDER BY sort_order, created_at`)
      .toArray()
      .map((r) => this.rowToMango(r));
  }

  private getMango(id: string): Mango | null {
    const rows = this.sql.exec<MangoRow>('SELECT * FROM mangoes WHERE id = ?', id).toArray();
    return rows.length ? this.rowToMango(rows[0]) : null;
  }

  private clientRatings(clientId: string): Record<string, RatingEntry> {
    const out: Record<string, RatingEntry> = {};
    for (const r of this.sql
      .exec<{ mango_id: string; score: number; client_rev: number; updated_at: number }>(
        'SELECT mango_id, score, client_rev, updated_at FROM ratings WHERE client_id = ?',
        clientId,
      )
      .toArray()) {
      out[r.mango_id] = {
        mangoId: r.mango_id,
        score: r.score,
        clientRev: r.client_rev,
        updatedAt: r.updated_at,
      };
    }
    return out;
  }

  private activeSubmission(clientId: string): SubmissionSummary | null {
    const rows = this.sql
      .exec<{ id: string; display_name: string; created_at: number; revision: number; status: string }>(
        `SELECT id, display_name, created_at, revision, status FROM submissions
         WHERE client_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        clientId,
      )
      .toArray();
    if (!rows.length) return null;
    const sub = rows[0];
    const scores: SubmittedScore[] = this.sql
      .exec<{ mango_id: string; mango_name: string; score: number }>(
        'SELECT mango_id, mango_name, score FROM submitted_scores WHERE submission_id = ?',
        sub.id,
      )
      .toArray()
      .map((s) => ({ mangoId: s.mango_id, mangoName: s.mango_name, score: s.score }));
    return {
      id: sub.id,
      displayName: sub.display_name,
      createdAt: sub.created_at,
      revision: sub.revision,
      status: sub.status as 'active' | 'superseded',
      scores,
    };
  }

  /** Results computed from active (non-superseded) submissions only. */
  private computeResults(): MangoResult[] {
    const mangoes = this.listMangoes(false);
    const scoreRows = this.sql
      .exec<{ mango_id: string; score: number }>(
        `SELECT ss.mango_id, ss.score FROM submitted_scores ss
         JOIN submissions s ON s.id = ss.submission_id WHERE s.status = 'active'`,
      )
      .toArray();
    const byMango = new Map<string, number[]>();
    for (const r of scoreRows) {
      let list = byMango.get(r.mango_id);
      if (!list) byMango.set(r.mango_id, (list = []));
      list.push(r.score);
    }
    const results: MangoResult[] = mangoes.map((m) => {
      const scores = (byMango.get(m.id) ?? []).sort((a, b) => a - b);
      const distribution = new Array(10).fill(0);
      for (const s of scores) distribution[s - 1]++;
      const sum = scores.reduce((a, b) => a + b, 0);
      return {
        mangoId: m.id,
        name: m.name,
        count: scores.length,
        average: scores.length ? sum / scores.length : null,
        median: median(scores),
        distribution,
        rank: null,
      };
    });
    const ranked = results
      .filter((r) => r.count > 0)
      .sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || b.count - a.count);
    ranked.forEach((r, i) => {
      r.rank = i + 1;
    });
    return results;
  }

  private guestState(clientId: string | null): GuestState {
    const event = this.getEvent();
    const submission = clientId ? this.activeSubmission(clientId) : null;
    return {
      role: 'guest',
      event,
      mangoes: this.listMangoes(true),
      ratings: clientId ? this.clientRatings(clientId) : {},
      submission,
      // Standings are a reward for submitting — never shown beforehand, so
      // they can't anchor scores that are still being decided.
      results: event.resultsVisible && submission ? this.computeResults() : null,
      serverTime: Date.now(),
    };
  }

  /** Client ids that currently hold an active submission. */
  private submittedClientIds(): Set<string> {
    return new Set(
      this.sql
        .exec<{ client_id: string }>(`SELECT DISTINCT client_id FROM submissions WHERE status = 'active'`)
        .toArray()
        .map((r) => r.client_id),
    );
  }

  private adminMangoes(): MangoAdminInfo[] {
    const drafts = new Map<string, number>();
    for (const r of this.sql
      .exec<{ mango_id: string; n: number }>('SELECT mango_id, COUNT(*) AS n FROM ratings GROUP BY mango_id')
      .toArray()) {
      drafts.set(r.mango_id, r.n);
    }
    const submitted = new Map<string, number>();
    for (const r of this.sql
      .exec<{ mango_id: string; n: number }>(
        `SELECT ss.mango_id, COUNT(*) AS n FROM submitted_scores ss
         JOIN submissions s ON s.id = ss.submission_id WHERE s.status = 'active'
         GROUP BY ss.mango_id`,
      )
      .toArray()) {
      submitted.set(r.mango_id, r.n);
    }
    return this.listMangoes(false).map((m) => ({
      ...m,
      draftCount: drafts.get(m.id) ?? 0,
      submittedCount: submitted.get(m.id) ?? 0,
    }));
  }

  private adminStats(): AdminStats {
    const one = (q: string): number => this.sql.exec<{ n: number }>(q).one().n;
    return {
      connected: this.ctx.getWebSockets().length,
      participants: one('SELECT COUNT(*) AS n FROM participants'),
      draftParticipants: one('SELECT COUNT(DISTINCT client_id) AS n FROM ratings'),
      activeSubmissions: one(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'active'`),
      totalSubmissions: one('SELECT COUNT(*) AS n FROM submissions'),
    };
  }

  private recentSubmissions(limit = 12): RecentSubmission[] {
    return this.sql
      .exec<{ id: string; display_name: string; created_at: number; status: string; n: number }>(
        `SELECT s.id, s.display_name, s.created_at, s.status,
                (SELECT COUNT(*) FROM submitted_scores ss WHERE ss.submission_id = s.id) AS n
         FROM submissions s ORDER BY s.created_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        displayName: r.display_name,
        createdAt: r.created_at,
        status: r.status as 'active' | 'superseded',
        scoreCount: r.n,
      }));
  }

  private recentAudit(limit = 20): AuditEntry[] {
    return this.sql
      .exec<{ id: number; at: number; action: string; detail: string }>(
        'SELECT id, at, action, detail FROM audit ORDER BY id DESC LIMIT ?',
        limit,
      )
      .toArray();
  }

  private adminState(): AdminState {
    return {
      role: 'admin',
      event: this.getEvent(),
      mangoes: this.adminMangoes(),
      stats: this.adminStats(),
      results: this.computeResults(),
      recentSubmissions: this.recentSubmissions(),
      audit: this.recentAudit(),
      serverTime: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Guest endpoints
  // -------------------------------------------------------------------------

  private handleGuestState(url: URL): Response {
    const clientId = url.searchParams.get('clientId');
    if (clientId !== null && !isValidClientId(clientId)) {
      return err('Invalid clientId', 'invalid', 400);
    }
    if (clientId) this.touchParticipant(clientId, false);
    return json(this.guestState(clientId));
  }

  private async handleRate(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<import('../../shared/types').RateRequest>;
    if (!isValidClientId(body.clientId)) return err('Invalid clientId', 'invalid', 400);
    if (!isValidScore(body.score)) return err('Score must be an integer 1-10', 'invalid', 400);
    if (typeof body.clientRev !== 'number' || !Number.isInteger(body.clientRev) || body.clientRev < 0) {
      return err('Invalid clientRev', 'invalid', 400);
    }
    if (typeof body.mangoId !== 'string') return err('Invalid mangoId', 'invalid', 400);

    if (!this.allowRequest(`rate:${body.clientId}`, 90, 60_000)) {
      return err('Slow down a little', 'rate_limited', 429);
    }

    const event = this.getEvent();
    if (event.status !== 'open') {
      return err(
        event.status === 'paused' ? 'Ranking is paused' : 'Ranking is not open',
        event.status === 'paused' ? 'paused' : 'closed',
        409,
      );
    }

    const mango = this.getMango(body.mangoId);
    if (!mango || !mango.available) return err('Mango not found or unavailable', 'not_found', 404);

    const now = Date.now();
    this.touchParticipant(body.clientId, false);

    // Idempotent, stale-write-safe upsert: only newer clientRevs win.
    this.sql.exec(
      `INSERT INTO ratings (client_id, mango_id, score, client_rev, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (client_id, mango_id) DO UPDATE SET
         score = excluded.score, client_rev = excluded.client_rev, updated_at = excluded.updated_at
       WHERE excluded.client_rev > ratings.client_rev`,
      body.clientId, body.mangoId, body.score, body.clientRev, now,
    );

    const current = this.sql
      .exec<{ score: number; client_rev: number; updated_at: number }>(
        'SELECT score, client_rev, updated_at FROM ratings WHERE client_id = ? AND mango_id = ?',
        body.clientId, body.mangoId,
      )
      .one();

    this.scheduleStatsBroadcast();
    return json({
      ok: true,
      rating: {
        mangoId: body.mangoId,
        score: current.score,
        clientRev: current.client_rev,
        updatedAt: current.updated_at,
      },
    });
  }

  private async handleSubmit(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<import('../../shared/types').SubmitRequest>;
    if (!isValidClientId(body.clientId)) return err('Invalid clientId', 'invalid', 400);
    const displayName = cleanText(body.displayName, 40);
    if (!displayName) return err('Please enter a name (max 40 characters)', 'invalid', 400);

    if (!this.allowRequest(`submit:${body.clientId}`, 6, 60_000)) {
      return err('Slow down a little', 'rate_limited', 429);
    }

    const event = this.getEvent();
    if (event.status !== 'open') {
      return err('Ranking is not open', event.status === 'paused' ? 'paused' : 'closed', 409);
    }
    if (!event.submissionsOpen) return err('Submissions are closed', 'submissions_closed', 409);

    const existing = this.activeSubmission(body.clientId);
    if (existing && !event.allowResubmit) {
      return err('You have already submitted your ranking', 'already_submitted', 409);
    }

    const available = this.listMangoes(true);
    const ratings = this.clientRatings(body.clientId);
    const rated = available.filter((m) => ratings[m.id]);
    if (rated.length === 0) return err('Rate at least one mango first', 'missing_ratings', 409);

    if (event.requireAll) {
      const missing = available.filter((m) => m.requiredForSubmit && !ratings[m.id]).map((m) => m.name);
      if (missing.length > 0) {
        return err('Some mangoes still need a rating', 'missing_ratings', 409, { missing });
      }
    }

    const now = Date.now();
    if (existing) {
      this.sql.exec(`UPDATE submissions SET status = 'superseded' WHERE id = ?`, existing.id);
    }
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO submissions (id, client_id, display_name, created_at, revision, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      id, body.clientId, displayName, now, event.revision,
    );
    for (const m of rated) {
      this.sql.exec(
        `INSERT INTO submitted_scores (submission_id, mango_id, score, mango_name) VALUES (?, ?, ?, ?)`,
        id, m.id, ratings[m.id].score, m.name,
      );
    }
    this.touchParticipant(body.clientId, false);
    this.scheduleStatsBroadcast();
    if (event.resultsVisible) this.broadcastPatch();

    return json({
      ok: true,
      submission: this.activeSubmission(body.clientId),
      results: event.resultsVisible ? this.computeResults() : null,
    });
  }

  // -------------------------------------------------------------------------
  // Admin endpoints
  // -------------------------------------------------------------------------

  private async handleLogin(request: Request): Promise<Response> {
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    const now = Date.now();
    const fails = this.loginFails.get(ip);
    if (fails && fails.lockedUntil > now) {
      return err('Too many attempts — try again in a few minutes', 'locked_out', 429);
    }

    const body = (await request.json()) as { password?: unknown };
    const given = typeof body.password === 'string' ? body.password : '';
    const expected = this.env.ADMIN_PASSWORD;

    // Constant-time comparison via digest.
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest('SHA-256', enc.encode(given)),
      crypto.subtle.digest('SHA-256', enc.encode(expected)),
    ]);
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];

    if (diff !== 0 || expected.length === 0) {
      const next = { count: (fails?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= 5) {
        next.lockedUntil = now + 5 * 60_000;
        next.count = 0;
      }
      this.loginFails.set(ip, next);
      this.audit('admin.login_failed', `IP ${ip}`);
      return err('Incorrect password', 'bad_password', 401);
    }

    this.loginFails.delete(ip);
    this.audit('admin.login', `IP ${ip}`);
    return json({ ok: true });
  }

  private async handleEventUpdate(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const changes: string[] = [];

    if (body.name !== undefined) {
      const name = cleanText(body.name, 80);
      if (!name) return err('Invalid event name', 'invalid', 400);
      sets.push('name = ?');
      vals.push(name);
      changes.push(`name="${name}"`);
    }
    if (body.status !== undefined) {
      if (!['pre', 'open', 'paused', 'closed'].includes(body.status as string)) {
        return err('Invalid status', 'invalid', 400);
      }
      sets.push('status = ?');
      vals.push(body.status);
      changes.push(`status=${body.status}`);
    }
    for (const [key, col] of [
      ['submissionsOpen', 'submissions_open'],
      ['requireAll', 'require_all'],
      ['allowResubmit', 'allow_resubmit'],
      ['resultsVisible', 'results_visible'],
    ] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') return err(`Invalid ${key}`, 'invalid', 400);
        sets.push(`${col} = ?`);
        vals.push(body[key] ? 1 : 0);
        changes.push(`${key}=${body[key]}`);
      }
    }
    if (body.message !== undefined) {
      if (typeof body.message !== 'string') return err('Invalid message', 'invalid', 400);
      const message = body.message.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200);
      sets.push('message = ?');
      vals.push(message);
      changes.push(message ? `message="${message}"` : 'message cleared');
    }

    if (sets.length === 0) return err('No changes provided', 'invalid', 400);

    const now = Date.now();
    this.sql.exec(
      `UPDATE event SET ${sets.join(', ')}, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ...vals, now, EVENT_ID,
    );
    this.audit('event.updated', changes.join(', '));
    this.broadcastPatch();
    return json({ ok: true, event: this.getEvent() });
  }

  private async handleMangoCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const name = cleanText(body.name, 60);
    if (!name) return err('Mango needs a name (max 60 characters)', 'invalid', 400);
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 400) : '';
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 8000) : '';
    const requiredForSubmit = body.requiredForSubmit === undefined ? true : !!body.requiredForSubmit;

    const now = Date.now();
    const maxOrder =
      this.sql.exec<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM mangoes').one().m ?? 0;
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO mangoes (id, name, description, details, sort_order, available, required_for_submit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id, name, description, details, maxOrder + 10, requiredForSubmit ? 1 : 0, now, now,
    );
    this.bumpRevision();
    this.audit('mango.added', name);
    this.broadcastPatch();
    return json({ ok: true, mango: this.getMango(id) });
  }

  private async handleMangoUpdate(id: string, request: Request): Promise<Response> {
    const mango = this.getMango(id);
    if (!mango) return err('Mango not found', 'not_found', 404);

    const body = (await request.json()) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const changes: string[] = [];

    if (body.name !== undefined) {
      const name = cleanText(body.name, 60);
      if (!name) return err('Invalid name', 'invalid', 400);
      sets.push('name = ?');
      vals.push(name);
      changes.push(`renamed "${mango.name}" → "${name}"`);
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') return err('Invalid description', 'invalid', 400);
      sets.push('description = ?');
      vals.push(body.description.trim().slice(0, 400));
      changes.push('description updated');
    }
    if (body.details !== undefined) {
      if (typeof body.details !== 'string') return err('Invalid details', 'invalid', 400);
      sets.push('details = ?');
      vals.push(body.details.trim().slice(0, 8000));
      changes.push('details updated');
    }
    if (body.available !== undefined) {
      if (typeof body.available !== 'boolean') return err('Invalid available', 'invalid', 400);
      sets.push('available = ?');
      vals.push(body.available ? 1 : 0);
      changes.push(body.available ? `restored "${mango.name}"` : `hid "${mango.name}"`);
    }
    if (body.requiredForSubmit !== undefined) {
      if (typeof body.requiredForSubmit !== 'boolean') return err('Invalid requiredForSubmit', 'invalid', 400);
      sets.push('required_for_submit = ?');
      vals.push(body.requiredForSubmit ? 1 : 0);
      changes.push(`requiredForSubmit=${body.requiredForSubmit} for "${mango.name}"`);
    }
    if (sets.length === 0) return err('No changes provided', 'invalid', 400);

    this.sql.exec(
      `UPDATE mangoes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...vals, Date.now(), id,
    );
    this.bumpRevision();
    this.audit('mango.updated', changes.join(', '));
    this.broadcastPatch();
    return json({ ok: true, mango: this.getMango(id) });
  }

  private handleMangoDelete(id: string): Response {
    const mango = this.getMango(id);
    if (!mango) return err('Mango not found', 'not_found', 404);

    // Permanent deletion is only for accidental entries with no data.
    const drafts = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM ratings WHERE mango_id = ?', id)
      .one().n;
    const submitted = this.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM submitted_scores WHERE mango_id = ?', id)
      .one().n;
    if (drafts > 0 || submitted > 0) {
      return err('This mango has ratings — mark it unavailable instead', 'conflict', 409);
    }

    this.sql.exec('DELETE FROM mangoes WHERE id = ?', id);
    this.bumpRevision();
    this.audit('mango.deleted', mango.name);
    this.broadcastPatch();
    return json({ ok: true });
  }

  private async handleReorder(request: Request): Promise<Response> {
    const body = (await request.json()) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string')) {
      return err('Expected { ids: string[] }', 'invalid', 400);
    }
    const known = new Set(this.listMangoes(false).map((m) => m.id));
    const ids = body.ids as string[];
    if (ids.length !== known.size || ids.some((x) => !known.has(x))) {
      return err('ids must be a permutation of all mango ids', 'invalid', 400);
    }
    const now = Date.now();
    ids.forEach((mid, i) => {
      this.sql.exec('UPDATE mangoes SET sort_order = ?, updated_at = ? WHERE id = ?', (i + 1) * 10, now, mid);
    });
    this.bumpRevision();
    this.audit('mango.reordered', `${ids.length} mangoes`);
    this.broadcastPatch();
    return json({ ok: true });
  }

  private handleExport(format: string): Response {
    const event = this.getEvent();
    const mangoes = this.listMangoes(false);
    const results = this.computeResults();
    const submissions = this.sql
      .exec<{ id: string; client_id: string; display_name: string; created_at: number; status: string }>(
        'SELECT id, client_id, display_name, created_at, status FROM submissions ORDER BY created_at',
      )
      .toArray();
    const scores = this.sql
      .exec<{ submission_id: string; mango_id: string; mango_name: string; score: number }>(
        'SELECT submission_id, mango_id, mango_name, score FROM submitted_scores',
      )
      .toArray();
    const scoresBySub = new Map<string, Map<string, number>>();
    for (const s of scores) {
      let m = scoresBySub.get(s.submission_id);
      if (!m) scoresBySub.set(s.submission_id, (m = new Map()));
      m.set(s.mango_id, s.score);
    }

    if (format === 'csv') {
      const esc = (v: string | number | null) => {
        const s = v === null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['submission_id', 'name', 'submitted_at', 'status', ...mangoes.map((m) => m.name)];
      const lines = [header.map(esc).join(',')];
      for (const sub of submissions) {
        const m = scoresBySub.get(sub.id);
        lines.push(
          [
            sub.id,
            sub.display_name,
            new Date(sub.created_at).toISOString(),
            sub.status,
            ...mangoes.map((mg) => m?.get(mg.id) ?? null),
          ]
            .map(esc)
            .join(','),
        );
      }
      this.audit('export', 'CSV');
      return new Response(lines.join('\n'), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="mango-tango-results.csv"',
        },
      });
    }

    this.audit('export', 'JSON');
    return json({
      event,
      mangoes,
      results,
      submissions: submissions.map((sub) => ({
        id: sub.id,
        displayName: sub.display_name,
        createdAt: sub.created_at,
        status: sub.status,
        scores: Object.fromEntries(scoresBySub.get(sub.id) ?? []),
      })),
      exportedAt: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // WebSockets (hibernation API)
  // -------------------------------------------------------------------------

  private handleWebSocket(request: Request, url: URL, isAdmin: boolean): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return err('Expected a WebSocket upgrade', 'invalid', 426);
    }
    const clientId = url.searchParams.get('clientId');
    if (clientId !== null && !isValidClientId(clientId)) {
      return err('Invalid clientId', 'invalid', 400);
    }
    if (!isAdmin && !clientId) return err('clientId required', 'invalid', 400);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [isAdmin ? 'admin' : 'guest']);
    const attachment: WsAttachment = { clientId, admin: isAdmin };
    server.serializeAttachment(attachment);

    if (clientId) this.touchParticipant(clientId, true);
    server.send(
      JSON.stringify({
        type: 'hello',
        state: isAdmin ? this.adminState() : this.guestState(clientId),
      }),
    );
    this.scheduleStatsBroadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'resync') {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      ws.send(
        JSON.stringify({
          type: 'hello',
          state: att?.admin ? this.adminState() : this.guestState(att?.clientId ?? null),
        }),
      );
    }
  }

  override async webSocketClose(): Promise<void> {
    this.scheduleStatsBroadcast();
  }

  override async webSocketError(): Promise<void> {
    this.scheduleStatsBroadcast();
  }

  private broadcast(message: string, adminOnly: boolean): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (adminOnly && !att?.admin) continue;
      try {
        ws.send(message);
      } catch {
        // Socket already closing; hibernation API will clean it up.
      }
    }
  }

  /** Full event+mango snapshot to everyone after any event-level change. */
  private broadcastPatch(): void {
    const event = this.getEvent();
    const results = this.computeResults();
    const guestMangoes = this.listMangoes(true);
    const base: Omit<PatchMessage, 'results'> = {
      type: 'patch',
      revision: event.revision,
      event,
      mangoes: guestMangoes,
    };
    // Guests only see standings once they've submitted (enforced per socket).
    const guestLocked = JSON.stringify({ ...base, results: null });
    const guestUnlocked = event.resultsVisible
      ? JSON.stringify({ ...base, results })
      : guestLocked;
    const adminStr = JSON.stringify({
      type: 'patch',
      revision: event.revision,
      event,
      mangoes: this.adminMangoes(),
      results,
    } satisfies PatchMessage);

    const submitted = event.resultsVisible ? this.submittedClientIds() : null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      const msg = att?.admin
        ? adminStr
        : submitted && att?.clientId && submitted.has(att.clientId)
          ? guestUnlocked
          : guestLocked;
      try {
        ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  }

  /** Coalesced live-stats push to admin dashboards. */
  private scheduleStatsBroadcast(): void {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      const msg: StatsMessage = {
        type: 'stats',
        stats: this.adminStats(),
        recentSubmissions: this.recentSubmissions(),
        mangoes: this.adminMangoes(),
        results: this.computeResults(),
      };
      this.broadcast(JSON.stringify(msg), true);
    }, 400);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private bumpRevision(): void {
    this.sql.exec('UPDATE event SET revision = revision + 1, updated_at = ? WHERE id = ?', Date.now(), EVENT_ID);
  }

  private touchParticipant(clientId: string, connected: boolean): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO participants (client_id, first_seen, last_seen, last_connected)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         last_connected = COALESCE(excluded.last_connected, participants.last_connected)`,
      clientId, now, now, connected ? now : null,
    );
  }

  private audit(action: string, detail: string): void {
    this.sql.exec('INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)', Date.now(), action, detail);
    // Keep the audit table bounded.
    this.sql.exec('DELETE FROM audit WHERE id < (SELECT MAX(id) FROM audit) - 500');
  }

  /** Simple token bucket, keyed per client+operation. */
  private allowRequest(key: string, capacity: number, refillMs: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: now };
      this.buckets.set(key, bucket);
      if (this.buckets.size > 5000) this.buckets.clear(); // crude memory bound
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / refillMs) * capacity);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
