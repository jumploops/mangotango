// Networking for the guest app: WebSocket live channel with reconnect +
// heartbeat, polling fallback, and a durable autosave queue for ratings.

import type {
  ApiError,
  GuestState,
  RateResponse,
  ServerMessage,
  SubmissionSummary,
  SubmitResponse,
} from '../../shared/types';
import {
  applyEventSnapshot,
  applyFullState,
  clientId,
  conn,
  ratings,
  results,
  saveState,
  submission,
  toast,
} from './store';

// ---------------------------------------------------------------------------
// Autosave queue (persisted so a refresh can't lose unsent ratings)
// ---------------------------------------------------------------------------

const PENDING_KEY = 'mt.pending';
const REV_KEY = 'mt.rev';

interface PendingRating {
  score: number;
  clientRev: number;
}

const pending = new Map<string, PendingRating>(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}')) as Array<
        [string, PendingRating]
      >;
    } catch {
      return [];
    }
  })(),
);

let revCounter = Number(localStorage.getItem(REV_KEY) ?? '0') || 0;

function nextRev(): number {
  revCounter += 1;
  localStorage.setItem(REV_KEY, String(revCounter));
  return revCounter;
}

function persistPending(): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(pending)));
}

export function pendingIds(): Set<string> {
  return new Set(pending.keys());
}

export function hasPending(): boolean {
  return pending.size > 0;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let retryDelay = 1000;

/** Record a rating locally and schedule the debounced autosave. */
export function setRating(mangoId: string, score: number): void {
  const clientRev = nextRev();
  ratings.value = {
    ...ratings.value,
    [mangoId]: { mangoId, score, clientRev, updatedAt: Date.now() },
  };
  pending.set(mangoId, { score, clientRev });
  persistPending();
  saveState.value = 'saving';
  scheduleFlush(650);
}

/** Undo a rating ("haven't tried it yet") — queued like any other write,
    sent as the score-0 tombstone so stale writes can't resurrect it. */
export function clearRating(mangoId: string): void {
  const clientRev = nextRev();
  const next = { ...ratings.value };
  delete next[mangoId];
  ratings.value = next;
  pending.set(mangoId, { score: 0, clientRev });
  persistPending();
  saveState.value = 'saving';
  scheduleFlush(300);
}

/** Mango ids with an unflushed clear — their server rating is already stale. */
export function pendingClearIds(): Set<string> {
  const out = new Set<string>();
  for (const [id, p] of pending) if (p.score === 0) out.add(id);
  return out;
}

export function flushNow(): void {
  scheduleFlush(0);
}

function scheduleFlush(delay: number): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (flushing || pending.size === 0) return;
  flushing = true;
  try {
    while (pending.size > 0) {
      const [mangoId, entry] = pending.entries().next().value as [string, PendingRating];
      const res = await fetch('/api/rate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, mangoId, score: entry.score, clientRev: entry.clientRev }),
      });

      if (res.ok) {
        const data = (await res.json()) as RateResponse;
        // Only clear if the guest hasn't moved the slider again meanwhile.
        const latest = pending.get(mangoId);
        if (latest && latest.clientRev === entry.clientRev) {
          pending.delete(mangoId);
          persistPending();
        }
        // Server wins if it holds something newer (e.g. another tab).
        const local = ratings.value[mangoId];
        if (!local || data.rating.clientRev >= local.clientRev) {
          if (data.rating.score === 0) {
            const next = { ...ratings.value };
            delete next[mangoId];
            ratings.value = next;
          } else {
            ratings.value = { ...ratings.value, [mangoId]: data.rating };
          }
        }
        retryDelay = 1000;
      } else if (res.status === 409) {
        // Ranking paused/closed — keep the local value, stop pushing.
        const e = (await res.json()) as ApiError;
        toast(e.error, 'warn');
        break;
      } else if (res.status === 429) {
        scheduleFlush(3000);
        break;
      } else if (res.status >= 400 && res.status < 500) {
        // Unrecoverable for this entry (e.g. mango was hidden) — drop it.
        pending.delete(mangoId);
        persistPending();
      } else {
        throw new Error(`save failed: ${res.status}`);
      }
    }
    if (pending.size === 0) saveState.value = 'saved';
  } catch {
    saveState.value = 'offline';
    scheduleFlush(retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15_000);
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Live channel
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectDelay = 800;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeard = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/ws?clientId=${encodeURIComponent(clientId)}`;
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  conn.value = conn.value === 'live' ? 'live' : 'connecting';

  try {
    ws = new WebSocket(wsUrl());
  } catch {
    onDisconnected();
    return;
  }

  ws.onopen = () => {
    conn.value = 'live';
    reconnectDelay = 800;
    lastHeard = Date.now();
    stopPolling();
    if (pending.size > 0) flushNow();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeard > 45_000) {
        ws.close();
        return;
      }
      ws.send('ping');
    }, 20_000);
  };

  ws.onmessage = (e) => {
    lastHeard = Date.now();
    if (typeof e.data !== 'string' || e.data === 'pong') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'hello' && msg.state.role === 'guest') {
      applyFullState(msg.state, pendingIds(), pendingClearIds());
    } else if (msg.type === 'patch') {
      applyEventSnapshot(msg.event, msg.mangoes, msg.results);
    }
  };

  ws.onclose = onDisconnected;
  ws.onerror = () => ws?.close();
}

function onDisconnected(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  conn.value = 'offline';
  startPolling();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const jitter = Math.random() * 400;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay + jitter);
  reconnectDelay = Math.min(reconnectDelay * 1.8, 20_000);
}

/** HTTP fallback so a broken WebSocket never strands guests on stale data. */
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshState(), 15_000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function refreshState(): Promise<void> {
  try {
    const res = await fetch(`/api/state?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) return;
    const state = (await res.json()) as GuestState;
    applyFullState(state, pendingIds(), pendingClearIds());
    if (conn.value !== 'live') conn.value = 'offline';
    if (pending.size > 0) flushNow();
  } catch {
    /* still offline */
  }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export async function submitRanking(displayName: string): Promise<SubmissionSummary> {
  // Make sure the freshest scores are on the server before snapshotting.
  if (pending.size > 0) {
    flushNow();
    await new Promise((r) => setTimeout(r, 400));
  }
  const res = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, displayName }),
  });
  const data = (await res.json()) as SubmitResponse | ApiError;
  if (!res.ok || !('submission' in data)) {
    const e = data as ApiError;
    const detail = e.missing?.length ? ` (${e.missing.join(', ')})` : '';
    throw new Error(`${e.error ?? 'Submission failed'}${detail}`);
  }
  submission.value = data.submission;
  // Submitting unlocks the live standings (when the host has them on).
  results.value = data.results;
  return data.submission;
}

// ---------------------------------------------------------------------------
// Lifecycle wiring
// ---------------------------------------------------------------------------

export function initNetworking(): void {
  connect();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Catch up after the phone was locked / app was backgrounded.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
      } else {
        ws.send(JSON.stringify({ type: 'resync' }));
      }
      if (pending.size > 0) flushNow();
    }
  });

  window.addEventListener('online', () => {
    connect();
    if (pending.size > 0) flushNow();
  });

  window.addEventListener('beforeunload', (e) => {
    if (pending.size > 0) {
      e.preventDefault();
    }
  });

  if (pending.size > 0) {
    saveState.value = 'saving';
    flushNow();
  }
}
