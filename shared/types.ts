// Shared protocol types between the Worker/Durable Object backend and the
// guest + admin frontends. Keep this file free of DOM or Workers types.

export type EventStatus = 'pre' | 'open' | 'paused' | 'closed';

export interface EventConfig {
  id: string;
  name: string;
  status: EventStatus;
  submissionsOpen: boolean;
  requireAll: boolean;
  allowResubmit: boolean;
  resultsVisible: boolean;
  message: string;
  revision: number;
  /** "Fresh start" timestamp — data written before this is hidden, not deleted. */
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

export interface Mango {
  id: string;
  name: string;
  /** Short summary shown on the card. */
  description: string;
  /** Long-form description in markdown, shown in the "read more" popup. */
  details: string;
  sortOrder: number;
  available: boolean;
  requiredForSubmit: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RatingEntry {
  mangoId: string;
  score: number;
  clientRev: number;
  updatedAt: number;
}

export interface SubmittedScore {
  mangoId: string;
  mangoName: string;
  score: number;
}

export interface SubmissionSummary {
  id: string;
  displayName: string;
  createdAt: number;
  revision: number;
  status: 'active' | 'superseded';
  scores: SubmittedScore[];
}

export interface MangoResult {
  mangoId: string;
  name: string;
  count: number;
  average: number | null;
  median: number | null;
  /** Histogram of submitted scores, index 0 = score 1 … index 9 = score 10. */
  distribution: number[];
  rank: number | null;
}

export interface GuestState {
  role: 'guest';
  event: EventConfig;
  /** Available mangoes only, in display order. */
  mangoes: Mango[];
  /** This client's draft ratings, keyed by mangoId (may include hidden mangoes). */
  ratings: Record<string, RatingEntry>;
  /** This client's active submission, if any. */
  submission: SubmissionSummary | null;
  /** Present only when event.resultsVisible is true AND this client has an active submission. */
  results: MangoResult[] | null;
  serverTime: number;
}

export interface MangoAdminInfo extends Mango {
  draftCount: number;
  submittedCount: number;
}

export interface AdminStats {
  connected: number;
  participants: number;
  draftParticipants: number;
  activeSubmissions: number;
  totalSubmissions: number;
}

export interface RecentSubmission {
  id: string;
  displayName: string;
  createdAt: number;
  status: 'active' | 'superseded';
  scoreCount: number;
}

export interface AuditEntry {
  id: number;
  at: number;
  action: string;
  detail: string;
}

export interface AdminState {
  role: 'admin';
  event: EventConfig;
  /** All mangoes including unavailable, in display order. */
  mangoes: MangoAdminInfo[];
  stats: AdminStats;
  results: MangoResult[];
  recentSubmissions: RecentSubmission[];
  audit: AuditEntry[];
  serverTime: number;
}

// ---------------------------------------------------------------------------
// WebSocket messages (server → client)
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  state: GuestState | AdminState;
}

/**
 * Sent to every connected client whenever event config or the mango list
 * changes. Carries a full authoritative snapshot of both (the list is small),
 * so clients can never drift — `revision` lets them detect staleness anyway.
 */
export interface PatchMessage {
  type: 'patch';
  revision: number;
  event: EventConfig;
  mangoes: Mango[]; // guests: available only; admins get MangoAdminInfo[]
  results: MangoResult[] | null;
}

export interface StatsMessage {
  type: 'stats';
  stats: AdminStats;
  recentSubmissions: RecentSubmission[];
  mangoes: MangoAdminInfo[];
  results: MangoResult[];
}

export type ServerMessage = HelloMessage | PatchMessage | StatsMessage;

// ---------------------------------------------------------------------------
// HTTP payloads
// ---------------------------------------------------------------------------

export interface RateRequest {
  clientId: string;
  mangoId: string;
  /** 1-10, or 0 to clear a previously set rating (rev-guarded tombstone). */
  score: number;
  clientRev: number;
}

export interface RateResponse {
  ok: true;
  rating: RatingEntry;
}

export interface SubmitRequest {
  clientId: string;
  displayName: string;
}

export interface SubmitResponse {
  ok: true;
  submission: SubmissionSummary;
  /** Standings unlock on submission — included when event.resultsVisible. */
  results: MangoResult[] | null;
}

export interface ApiError {
  ok?: false;
  error: string;
  code?:
    | 'closed'
    | 'paused'
    | 'submissions_closed'
    | 'missing_ratings'
    | 'already_submitted'
    | 'rate_limited'
    | 'locked_out'
    | 'bad_password'
    | 'invalid'
    | 'not_found'
    | 'conflict'
    | 'unauthorized';
  /** For missing_ratings: names of mangoes still needing a score. */
  missing?: string[];
}

export const SCORE_MIN = 1;
export const SCORE_MAX = 10;

export function isValidScore(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= SCORE_MIN && n <= SCORE_MAX;
}

export function isValidClientId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
}
