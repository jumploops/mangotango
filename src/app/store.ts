// Client-side state for the guest app, built on Preact signals.

import { computed, signal } from '@preact/signals';
import type {
  EventConfig,
  GuestState,
  Mango,
  MangoResult,
  RatingEntry,
  SubmissionSummary,
} from '../../shared/types';

export const clientId: string = (() => {
  const KEY = 'mt.clientId';
  let id = localStorage.getItem(KEY);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
})();

export type ConnState = 'connecting' | 'live' | 'offline';
export type SaveState = 'idle' | 'saving' | 'saved' | 'offline';

export const event = signal<EventConfig | null>(null);
export const mangoes = signal<Mango[]>([]);
export const ratings = signal<Record<string, RatingEntry>>({});
export const submission = signal<SubmissionSummary | null>(null);
export const results = signal<MangoResult[] | null>(null);
export const conn = signal<ConnState>('connecting');
export const saveState = signal<SaveState>('idle');
export const loaded = signal(false);
export const expandedId = signal<string | null>(null);
export const sheetOpen = signal(false);
export const celebrating = signal(false);
/** Mango ids that appeared live mid-event — get a "NEW" flourish. */
export const newIds = signal<Set<string>>(new Set());

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'party';
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t: Toast = { id: ++toastSeq, text, kind };
  toasts.value = [...toasts.value, t];
  setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== t.id);
  }, 4200);
}

export const ratedCount = computed(
  () => mangoes.value.filter((m) => ratings.value[m.id]).length,
);

export const missingRequired = computed(() => {
  const ev = event.value;
  if (!ev?.requireAll) return [] as Mango[];
  return mangoes.value.filter((m) => m.requiredForSubmit && !ratings.value[m.id]);
});

export const canSubmit = computed(() => {
  const ev = event.value;
  if (!ev || ev.status !== 'open' || !ev.submissionsOpen) return false;
  if (submission.value && !ev.allowResubmit) return false;
  if (ratedCount.value === 0) return false;
  return missingRequired.value.length === 0;
});

/**
 * Apply an authoritative server snapshot of event + mango list (+ results).
 * Used by both `hello` and `patch` messages and the polling fallback.
 */
export function applyEventSnapshot(
  ev: EventConfig,
  list: Mango[],
  res: MangoResult[] | null,
): void {
  const before = event.value;
  const prevIds = new Set(mangoes.value.map((m) => m.id));

  if (loaded.value) {
    const added = list.filter((m) => !prevIds.has(m.id));
    if (added.length > 0) {
      const next = new Set(newIds.value);
      for (const m of added) next.add(m.id);
      newIds.value = next;
      toast(
        added.length === 1
          ? `🥭 New mango just dropped: ${added[0].name}`
          : `🥭 ${added.length} new mangoes just dropped!`,
        'party',
      );
    }
    if (before && before.status !== ev.status) {
      if (ev.status === 'paused') toast('⏸️ Ranking is paused', 'warn');
      if (ev.status === 'open' && before.status !== 'open') toast('🟢 Ranking is open!', 'party');
      if (ev.status === 'closed') toast('🏁 Ranking has closed', 'warn');
    }
    if (before && !before.resultsVisible && ev.resultsVisible && submission.value) {
      toast('📊 Live results are up!', 'party');
    }
    if (before && before.message !== ev.message && ev.message) {
      toast(`📣 ${ev.message}`, 'info');
    }
    if (before && before.epoch !== ev.epoch) {
      toast('🧹 Fresh start! The board is clean — happy tasting!', 'party');
    }
  }

  event.value = ev;
  mangoes.value = list;
  results.value = res;
  if (expandedId.value && !list.some((m) => m.id === expandedId.value)) {
    expandedId.value = null;
  }
}

/** Apply a full guest state (initial load / reconnect resync). */
export function applyFullState(
  state: GuestState,
  pendingIds: Set<string>,
  pendingClears: Set<string> = new Set(),
): void {
  applyEventSnapshot(state.event, state.mangoes, state.results);
  // Server is authoritative except for ratings we haven't flushed yet.
  const merged: Record<string, RatingEntry> = { ...state.ratings };
  for (const id of pendingIds) {
    const local = ratings.value[id];
    if (local && (!merged[id] || local.clientRev > merged[id].clientRev)) {
      merged[id] = local;
    }
  }
  // Unflushed clears: the server snapshot still holds the old score — drop it.
  for (const id of pendingClears) delete merged[id];
  ratings.value = merged;
  submission.value = state.submission;
  loaded.value = true;
}
