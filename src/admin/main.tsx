// Mango Tango host console. Password → HttpOnly session cookie → live
// dashboard over the same WebSocket channel guests use (admin-tagged).

import { render } from 'preact';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type {
  AdminState,
  ApiError,
  EventStatus,
  MangoAdminInfo,
  ServerMessage,
} from '../../shared/types';
import '../styles/tokens.css';
import './admin.css';

type Screen = 'checking' | 'login' | 'dashboard';

const screen = signal<Screen>('checking');
const state = signal<AdminState | null>(null);
const conn = signal<'live' | 'offline'>('offline');
const flash = signal<string | null>(null);

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function say(text: string): void {
  flash.value = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.value = null), 3000);
}

// ---------------------------------------------------------------------------
// API + live channel
// ---------------------------------------------------------------------------

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    screen.value = 'login';
    throw new Error('Session expired — log in again');
  }
  const data = (await res.json()) as T & Partial<ApiError>;
  if (!res.ok) throw new Error((data as ApiError).error ?? `Request failed (${res.status})`);
  return data;
}

let ws: WebSocket | null = null;
let reconnectDelay = 1000;

function connectLive(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    conn.value = 'live';
    reconnectDelay = 1000;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data === 'pong') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    const cur = state.value;
    if (msg.type === 'hello' && msg.state.role === 'admin') {
      state.value = msg.state;
    } else if (msg.type === 'patch' && cur) {
      state.value = {
        ...cur,
        event: msg.event,
        mangoes: msg.mangoes as MangoAdminInfo[],
        results: msg.results ?? cur.results,
        allResults: msg.allResults ?? cur.allResults,
      };
    } else if (msg.type === 'stats' && cur) {
      state.value = {
        ...cur,
        stats: msg.stats,
        recentSubmissions: msg.recentSubmissions,
        mangoes: msg.mangoes,
        results: msg.results,
        allResults: msg.allResults,
      };
    }
  };
  ws.onclose = () => {
    conn.value = 'offline';
    scheduleReconnect();
  };
  ws.onerror = () => ws?.close();
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
  }, 25_000);
}

function scheduleReconnect(): void {
  if (screen.value !== 'dashboard') return;
  setTimeout(() => {
    if (screen.value === 'dashboard') connectLive();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.8, 15_000);
}

async function enterDashboard(): Promise<void> {
  state.value = await api<AdminState>('/api/admin/state');
  screen.value = 'dashboard';
  connectLive();
}

async function boot(): Promise<void> {
  try {
    const s = await api<{ admin: boolean }>('/api/admin/session');
    if (s.admin) await enterDashboard();
    else screen.value = 'login';
  } catch {
    screen.value = 'login';
  }
}

async function refresh(): Promise<void> {
  state.value = await api<AdminState>('/api/admin/state');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function Login() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/login', { password });
      await enterDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="loginWrap">
      <form class="loginCard" onSubmit={submit}>
        <h1>🥭 Host Console</h1>
        <p>Enter the host password to run the show.</p>
        <input
          type="password"
          value={password}
          placeholder="Host password"
          autocomplete="current-password"
          onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
        />
        {error ? <p class="err">⚠️ {error}</p> : null}
        <button class="cta" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Let me in'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard sections
// ---------------------------------------------------------------------------

function StatTiles() {
  const s = state.value!.stats;
  const tiles: Array<[string, number, string]> = [
    ['Connected now', s.connected, '📶'],
    ['Tasters with ratings', s.draftParticipants, '👅'],
    ['Active ballots', s.activeSubmissions, '🗳️'],
    ['Total submissions', s.totalSubmissions, '📚'],
  ];
  return (
    <div class="tiles">
      {tiles.map(([label, n, icon]) => (
        <div class="tile" key={label}>
          <span class="tileIcon">{icon}</span>
          <b>{n}</b>
          <span class="tileLabel">{label}</span>
        </div>
      ))}
    </div>
  );
}

function EventControls() {
  const ev = state.value!.event;
  const [message, setMessage] = useState<string | null>(null);

  const update = async (patch: Record<string, unknown>) => {
    try {
      await api('/api/admin/event', patch);
      say('Saved');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Failed');
    }
  };

  const Toggle = ({ label, field, value }: { label: string; field: string; value: boolean }) => (
    <label class="toggle">
      <input type="checkbox" checked={value} onChange={() => void update({ [field]: !value })} />
      <span class="knob" aria-hidden="true" />
      {label}
    </label>
  );

  return (
    <section class="panel">
      <h2>🎛️ Event controls</h2>
      <div class="segmented" role="group" aria-label="Ranking status">
        {(['pre', 'open', 'paused', 'closed'] as EventStatus[]).map((st) => (
          <button
            key={st}
            class={ev.status === st ? 'on' : ''}
            onClick={() => void update({ status: st })}
          >
            {st === 'pre' ? '🌅 pre' : st === 'open' ? '🟢 open' : st === 'paused' ? '⏸ paused' : '🏁 closed'}
          </button>
        ))}
      </div>
      <div class="toggles">
        <Toggle label="Submissions open" field="submissionsOpen" value={ev.submissionsOpen} />
        <Toggle label="Require every mango rated" field="requireAll" value={ev.requireAll} />
        <Toggle label="Allow resubmission" field="allowResubmit" value={ev.allowResubmit} />
        <Toggle label="Show live results to guests" field="resultsVisible" value={ev.resultsVisible} />
      </div>
      <div class="msgRow">
        <input
          type="text"
          placeholder="Announcement for guests (e.g. “Kent just hit the table!”)"
          maxLength={200}
          value={message ?? ev.message}
          onInput={(e) => setMessage((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          class="mini"
          onClick={() => {
            void update({ message: message ?? ev.message });
            setMessage(null);
          }}
        >
          Post
        </button>
        {ev.message ? (
          <button
            class="mini ghost"
            onClick={() => {
              void update({ message: '' });
              setMessage(null);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div class="resetRow">
        <button
          class="mini danger"
          onClick={() => {
            if (
              !confirm(
                'Fresh start? All votes and submissions so far will be hidden from results and stats. Mangoes are untouched, and the old data stays in the database.',
              )
            ) {
              return;
            }
            api('/api/admin/reset', {}).then(
              () => say('Fresh start — the board is clean'),
              (e: unknown) => say(e instanceof Error ? e.message : 'Failed'),
            );
          }}
        >
          🧹 Fresh start
        </button>
        <span class="dim resetHint">
          Hides all votes so far (e.g. test data) without deleting anything. Mangoes stay.
          {ev.epoch ? ` Last fresh start: ${new Date(ev.epoch).toLocaleString()}.` : ''}
        </span>
      </div>
    </section>
  );
}

function MangoEditor({ mango, onDone }: { mango: MangoAdminInfo; onDone: () => void }) {
  const [name, setName] = useState(mango.name);
  const [description, setDescription] = useState(mango.description);
  const [details, setDetails] = useState(mango.details);
  const save = async (e: Event) => {
    e.preventDefault();
    try {
      await api(`/api/admin/mango/${mango.id}`, { name, description, details });
      say('Mango updated');
      onDone();
    } catch (err) {
      say(err instanceof Error ? err.message : 'Failed');
    }
  };
  return (
    <form class="editRow" onSubmit={save}>
      <input value={name} maxLength={60} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      <textarea
        value={description}
        maxLength={400}
        rows={2}
        placeholder="Short summary guests see on the card"
        onInput={(e) => setDescription((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <textarea
        value={details}
        maxLength={8000}
        rows={6}
        placeholder="Long description (markdown) for the read-more popup"
        onInput={(e) => setDetails((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <div class="rowBtns">
        <button class="mini" type="submit">Save</button>
        <button class="mini ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function MangoManager() {
  const mangoes = state.value!.mangoes;
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const move = async (index: number, dir: -1 | 1) => {
    const ids = mangoes.map((m) => m.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      await api('/api/admin/reorder', { ids });
    } catch (e) {
      say(e instanceof Error ? e.message : 'Failed');
    }
  };

  const add = async (e: Event) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api('/api/admin/mango', { name: newName.trim(), description: newDesc.trim() });
      setNewName('');
      setNewDesc('');
      say('Mango added — guests see it now');
    } catch (err) {
      say(err instanceof Error ? err.message : 'Failed');
    }
  };

  const setField = (id: string, patch: Record<string, unknown>) =>
    api(`/api/admin/mango/${id}`, patch).then(
      () => say('Saved'),
      (e: unknown) => say(e instanceof Error ? e.message : 'Failed'),
    );

  const remove = async (m: MangoAdminInfo) => {
    if (!confirm(`Permanently delete “${m.name}”? Only possible while it has no ratings.`)) return;
    try {
      await api(`/api/admin/mango/${m.id}/delete`, {});
      say('Deleted');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <section class="panel">
      <h2>🥭 Mangoes</h2>
      <div class="mangoRows">
        {mangoes.map((m, i) => (
          <div class={`mangoRow ${m.available ? '' : 'hidden'}`} key={m.id}>
            <div class="orderBtns">
              <button class="mini icon" aria-label={`Move ${m.name} up`} disabled={i === 0} onClick={() => void move(i, -1)}>↑</button>
              <button class="mini icon" aria-label={`Move ${m.name} down`} disabled={i === mangoes.length - 1} onClick={() => void move(i, 1)}>↓</button>
            </div>
            <div class="mangoInfo">
              {editing === m.id ? (
                <MangoEditor mango={m} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <b>
                    {m.name}
                    {!m.available ? <span class="hiddenTag">hidden</span> : null}
                    {!m.requiredForSubmit ? <span class="optTag">optional</span> : null}
                  </b>
                  <span class="counts">
                    {m.draftCount} draft · {m.submittedCount} submitted
                  </span>
                </>
              )}
            </div>
            {editing === m.id ? null : (
              <div class="rowBtns">
                <button class="mini" onClick={() => setEditing(m.id)}>Edit</button>
                <button class="mini" onClick={() => void setField(m.id, { available: !m.available })}>
                  {m.available ? 'Hide' : 'Restore'}
                </button>
                <button
                  class="mini"
                  title="Toggle whether this mango is required for submission"
                  onClick={() => void setField(m.id, { requiredForSubmit: !m.requiredForSubmit })}
                >
                  {m.requiredForSubmit ? 'Make optional' : 'Make required'}
                </button>
                {m.draftCount === 0 && m.submittedCount === 0 ? (
                  <button class="mini danger" onClick={() => void remove(m)}>Delete</button>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>
      <form class="addRow" onSubmit={add}>
        <input
          placeholder="New mango name"
          value={newName}
          maxLength={60}
          onInput={(e) => setNewName((e.currentTarget as HTMLInputElement).value)}
        />
        <input
          placeholder="Description (optional)"
          value={newDesc}
          maxLength={400}
          onInput={(e) => setNewDesc((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="cta mini" disabled={!newName.trim()}>Add mango</button>
      </form>
    </section>
  );
}

function ResultsPanel() {
  const s = state.value!;
  // 'ballots' = formally submitted rankings; 'all' = every current vote in
  // the ratings table, including drafts that were never submitted.
  const [view, setView] = useState<'ballots' | 'all'>('ballots');
  const res = view === 'all' ? s.allResults : s.results;
  const ranked = [...res].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const top = ranked.find((r) => r.rank === 1)?.average ?? 10;
  return (
    <section class="panel">
      <h2>
        🏆 Results{' '}
        <small>{view === 'all' ? '(every vote, drafts included)' : '(active ballots only)'}</small>
      </h2>
      <div class="segmented two" role="group" aria-label="Results source">
        <button class={view === 'ballots' ? 'on' : ''} onClick={() => setView('ballots')}>
          🗳 Submitted ballots
        </button>
        <button class={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>
          👀 All votes
        </button>
      </div>
      {ranked.every((r) => r.count === 0) ? (
        <p class="dim">{view === 'all' ? 'No votes yet.' : 'No submitted ballots yet.'}</p>
      ) : (
        <div class="resTable">
          {ranked.map((r) => (
            <div class="resLine" key={r.mangoId}>
              <span class="rk">{r.rank ?? '—'}</span>
              <span class="nm">{r.name}</span>
              <span class="bar">
                <i style={`width:${r.average ? Math.max(4, (r.average / Math.max(top, 1)) * 100) : 0}%`} />
              </span>
              <span class="nums">
                {r.average === null ? '—' : r.average.toFixed(2)}
                <small> avg · {r.median ?? '—'} med · n={r.count}</small>
              </span>
              <span class="dist" aria-hidden="true">
                {r.distribution.map((n, i) => {
                  const max = Math.max(...r.distribution, 1);
                  return <i key={i} style={`height:${(n / max) * 100}%`} title={`${i + 1}: ${n}`} />;
                })}
              </span>
            </div>
          ))}
        </div>
      )}
      <div class="exports">
        <a class="mini btnLike" href={`/api/admin/export?format=csv${view === 'all' ? '&scope=all' : ''}`} download>
          ⬇ Export CSV
        </a>
        <a
          class="mini btnLike"
          href={`/api/admin/export?format=json${view === 'all' ? '&scope=all' : ''}`}
          download={view === 'all' ? 'mango-tango-all-votes.json' : 'mango-tango-export.json'}
        >
          ⬇ Export JSON
        </a>
        <span class="dim exportHint">
          {view === 'all' ? 'exports every vote, drafts included' : 'exports submitted ballots'}
        </span>
      </div>
    </section>
  );
}

function ActivityPanel() {
  const s = state.value!;
  const fmt = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <section class="panel">
      <h2>📡 Activity</h2>
      <div class="twoCol">
        <div>
          <h3>Recent ballots</h3>
          {s.recentSubmissions.length === 0 ? <p class="dim">None yet.</p> : null}
          <ul class="plain">
            {s.recentSubmissions.map((r) => (
              <li key={r.id} class={r.status === 'superseded' ? 'super' : ''}>
                <b>{r.displayName}</b> · {r.scoreCount} scores · {fmt(r.createdAt)}
                {r.status === 'superseded' ? ' · superseded' : ''}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Audit log</h3>
          <ul class="plain">
            {s.audit.map((a) => (
              <li key={a.id}>
                <b>{a.action}</b> {a.detail ? `· ${a.detail}` : ''} · {fmt(a.at)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Dashboard() {
  const s = state.value;
  if (!s) return null;
  return (
    <div class="dash">
      <header class="dashHead">
        <h1>🥭 {s.event.name} — Host Console</h1>
        <div class="headRight">
          <span class={`pill ${conn.value === 'live' ? 'ok' : 'off'}`}>
            <i class="dot" /> {conn.value === 'live' ? 'Live' : 'Reconnecting…'}
          </span>
          <button class="mini ghost" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            class="mini ghost"
            onClick={async () => {
              await api('/api/admin/logout', {});
              location.reload();
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <StatTiles />
      <EventControls />
      <MangoManager />
      <ResultsPanel />
      <ActivityPanel />
      {flash.value ? <div class="flash">{flash.value}</div> : null}
    </div>
  );
}

function AdminApp() {
  if (screen.value === 'checking') return <div class="loginWrap"><p class="dim">Checking session…</p></div>;
  if (screen.value === 'login') return <Login />;
  return <Dashboard />;
}

void boot();
render(<AdminApp />, document.getElementById('app')!);
