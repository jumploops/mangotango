import { useEffect, useRef, useState } from 'preact/hooks';
import type { Mango } from '../../shared/types';
import { mangoBurst } from './confetti';
import { thump, tick } from './haptics';
import { look, scoreVars } from './labels';
import { flushNow, hasPending, setRating, submitRanking } from './net';
import {
  canSubmit,
  celebrating,
  conn,
  event,
  expandedId,
  loaded,
  mangoes,
  missingRequired,
  newIds,
  ratedCount,
  ratings,
  results,
  saveState,
  sheetOpen,
  submission,
  toast,
  toasts,
} from './store';

// ---------------------------------------------------------------------------

function StatusPill() {
  const c = conn.value;
  const s = saveState.value;
  let text: string;
  let cls: string;
  if (c !== 'live' && (s === 'offline' || hasPending())) {
    text = 'Offline — will retry';
    cls = 'off';
  } else if (c !== 'live') {
    text = c === 'connecting' ? 'Connecting…' : 'Reconnecting…';
    cls = 'warn';
  } else if (s === 'saving') {
    text = 'Saving…';
    cls = 'busy';
  } else if (s === 'saved') {
    text = 'Saved ✓';
    cls = 'ok';
  } else {
    text = 'Live';
    cls = 'ok';
  }
  return (
    <span class={`pill ${cls}`} role="status" aria-live="polite">
      <i class="dot" /> {text}
    </span>
  );
}

function Header() {
  const name = event.value?.name ?? 'Mango Tango';
  const word = name.split(/\s+/)[0].toUpperCase();
  const rest = name.slice(word.length).trim().toUpperCase() || 'TANGO';
  return (
    <header class="hero">
      <h1 aria-label={name}>
        <span class="line1" aria-hidden="true">
          {[...word].map((ch, i) => (
            <b style={`--n:${i}`} key={i}>
              {ch}
            </b>
          ))}
        </span>
        <span class="line2" aria-hidden="true">
          {rest} <span class="fruit">🥭</span>
        </span>
      </h1>
      <p class="tag">rate every mango · crown the champion</p>
      <StatusPill />
    </header>
  );
}

function Banners() {
  const ev = event.value;
  if (!ev) return null;
  return (
    <div class="banners">
      {ev.message ? <div class="banner note">📣 {ev.message}</div> : null}
      {ev.status === 'pre' ? (
        <div class="banner wait">🌅 Ranking hasn’t opened yet — sharpen your palate.</div>
      ) : null}
      {ev.status === 'paused' ? (
        <div class="banner warn">⏸️ Ranking is paused — sliders are locked for a moment.</div>
      ) : null}
      {ev.status === 'closed' ? <div class="banner warn">🏁 Ranking has closed. Thanks for tasting!</div> : null}
      {!ev.submissionsOpen && ev.status === 'open' ? (
        <div class="banner warn">📦 Submissions are closed, but you can keep tweaking scores.</div>
      ) : null}
      {conn.value !== 'live' && hasPending() ? (
        <div class="banner off">📴 Some ratings haven’t reached the server — we’ll keep retrying.</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RatingSlider({ mango, disabled }: { mango: Mango; disabled: boolean }) {
  const current = ratings.value[mango.id]?.score ?? null;
  const [preview, setPreview] = useState<number | null>(null);
  const score = preview ?? current;
  const s = look(score ?? 5);

  const onInput = (e: Event) => {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (v !== score) tick();
    setPreview(v);
    setRating(mango.id, v);
  };

  return (
    <div class={`rate ${score === null ? 'unrated' : ''}`} style={score !== null ? scoreVars(score) : ''}>
      <div class="readout" aria-hidden="true">
        {score === null ? (
          <span class="hint">slide to rate ↓</span>
        ) : (
          <>
            <span class="big" key={score}>
              {score}
            </span>
            <span class="word" key={`w${score}`}>
              {s.emoji} {s.label}
            </span>
          </>
        )}
      </div>
      <input
        type="range"
        min={1}
        max={10}
        step={1}
        value={score ?? 5}
        disabled={disabled}
        aria-label={`Rating for ${mango.name}, 1 is worst and 10 is best`}
        aria-valuetext={score === null ? 'not rated yet' : `${score} out of 10 — ${s.label}`}
        onInput={onInput}
        onPointerUp={() => flushNow()}
        onKeyUp={() => flushNow()}
      />
      <div class="scale" aria-hidden="true">
        <span>1 · worst</span>
        <span>10 · best</span>
      </div>
    </div>
  );
}

function MangoCard({ mango, index }: { mango: Mango; index: number }) {
  const rated = ratings.value[mango.id];
  const open = expandedId.value === mango.id;
  const isNew = newIds.value.has(mango.id);
  const ev = event.value;
  const locked = !ev || ev.status !== 'open';
  const s = rated ? look(rated.score) : null;

  return (
    <article
      class={`card ${open ? 'open' : ''} ${rated ? 'rated' : 'todo'} ${isNew ? 'fresh' : ''}`}
      style={`--i:${index};${rated ? scoreVars(rated.score) : ''}`}
    >
      <button
        class="cardHead"
        aria-expanded={open}
        onClick={() => {
          expandedId.value = open ? null : mango.id;
        }}
      >
        <span class="num" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span class="titleWrap">
          <span class="name">{mango.name}</span>
          {isNew ? <span class="newTag">NEW</span> : null}
          <span class="sub">
            {rated ? (
              <span class="scoreChip">
                <b>{rated.score}</b>/10 · {s!.emoji} {s!.label}
              </span>
            ) : (
              <span class="needs">needs your verdict</span>
            )}
          </span>
        </span>
        <span class={`badge ${rated ? 'done' : ''}`} aria-hidden="true">
          {rated ? rated.score : '?'}
        </span>
      </button>
      <div class="cardBody">
        <div class="cardBodyInner">
          {mango.description ? <p class="desc">{mango.description}</p> : null}
          <RatingSlider mango={mango} disabled={locked} />
        </div>
      </div>
    </article>
  );
}

function MangoList() {
  const list = mangoes.value;
  if (!loaded.value) {
    return (
      <div class="empty">
        <span class="spin" aria-hidden="true">
          🥭
        </span>
        <p>Slicing the mangoes…</p>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div class="empty">
        <span aria-hidden="true">🧺</span>
        <p>No mangoes on the table yet. They’re coming.</p>
      </div>
    );
  }
  return (
    <main class="list">
      {list.map((m, i) => (
        <MangoCard key={m.id} mango={m} index={i} />
      ))}
    </main>
  );
}

function Results() {
  const res = results.value;
  const ev = event.value;
  if (!ev?.resultsVisible) return null;
  // Standings unlock after this guest submits — until then, just a teaser.
  if (!res || !submission.value) {
    if (!loaded.value || mangoes.value.length === 0) return null;
    return (
      <section class="resultsPanel locked">
        <h2>🔒 Live standings</h2>
        <p class="lockedHint">Submit your ranking to unlock the leaderboard.</p>
      </section>
    );
  }
  const ranked = res.filter((r) => r.count > 0).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (ranked.length === 0) return null;
  const top = ranked[0].average ?? 10;
  const medal = (rank: number | null) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`);
  return (
    <section class="resultsPanel">
      <h2>🏆 Live standings</h2>
      {ranked.map((r) => (
        <div class="resRow" key={r.mangoId}>
          <span class="resRank">{medal(r.rank)}</span>
          <span class="resName">{r.name}</span>
          <span class="resBarTrack">
            <span class="resBar" style={`width:${Math.max(6, ((r.average ?? 0) / Math.max(top, 1)) * 100)}%`} />
          </span>
          <span class="resAvg">
            {(r.average ?? 0).toFixed(1)}
            <small> ({r.count})</small>
          </span>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------

function SubmitSheet() {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(localStorage.getItem('mt.name') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (sheetOpen.value && !d.open) d.showModal();
    if (!sheetOpen.value && d.open) d.close();
  });

  const list = mangoes.value
    .filter((m) => ratings.value[m.id])
    .sort((a, b) => ratings.value[b.id].score - ratings.value[a.id].score);

  const doSubmit = async (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('mt.name', trimmed);
      await submitRanking(trimmed);
      sheetOpen.value = false;
      celebrating.value = true;
      thump();
      mangoBurst();
      toast('🎉 Ranking submitted — you legend!', 'party');
      setTimeout(() => (celebrating.value = false), 2600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog class="sheet" ref={ref} onClose={() => (sheetOpen.value = false)} closedby="any">
      <form onSubmit={doSubmit}>
        <div class="grabber" aria-hidden="true" />
        <h2>Lock in your ranking</h2>
        <label class="nameLabel">
          Your name for the leaderboard
          <input
            type="text"
            value={name}
            maxLength={40}
            required
            placeholder="Mango Maradona"
            autocomplete="nickname"
            enterkeyhint="done"
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="summary">
          {list.map((m) => {
            const r = ratings.value[m.id];
            const s = look(r.score);
            return (
              <div class="sumRow" key={m.id} style={scoreVars(r.score)}>
                <span class="sumName">{m.name}</span>
                <span class="sumScore">
                  {r.score} <small>{s.emoji}</small>
                </span>
              </div>
            );
          })}
        </div>
        {error ? <p class="formError">⚠️ {error}</p> : null}
        <div class="sheetBtns">
          <button type="button" class="ghost" onClick={() => (sheetOpen.value = false)} disabled={busy}>
            Keep tasting
          </button>
          <button type="submit" class="cta" disabled={busy || !name.trim()}>
            {busy ? 'Submitting…' : submission.value ? 'Resubmit 🥭' : 'Submit 🥭'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function SubmitBar() {
  // Secret host entrance: 5 quick taps on the progress ring → /admin.
  const taps = useRef({ count: 0, last: 0 });
  const secretTap = () => {
    const now = Date.now();
    taps.current =
      now - taps.current.last > 700
        ? { count: 1, last: now }
        : { count: taps.current.count + 1, last: now };
    if (taps.current.count >= 5) {
      thump();
      location.href = '/admin';
    } else if (taps.current.count >= 3) {
      tick();
    }
  };

  const ev = event.value;
  if (!ev || !loaded.value || mangoes.value.length === 0) return null;
  const total = mangoes.value.length;
  const done = ratedCount.value;
  const sub = submission.value;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  let cta: preact.JSX.Element;
  if (sub && !ev.allowResubmit) {
    cta = (
      <div class="submitted">
        ✅ Submitted as <b>{sub.displayName}</b>
      </div>
    );
  } else {
    const missing = missingRequired.value.length;
    const label = sub ? 'Update my ranking' : 'Submit my ranking';
    const blocked = !canSubmit.value;
    let hint: string | null = null;
    if (ev.status !== 'open') hint = 'ranking is closed';
    else if (!ev.submissionsOpen) hint = 'submissions are closed';
    else if (done === 0) hint = 'rate a mango to begin';
    else if (missing > 0) hint = `${missing} mango${missing > 1 ? 'es' : ''} still unrated`;
    cta = (
      <button
        class="cta big"
        disabled={blocked}
        onClick={() => {
          sheetOpen.value = true;
        }}
      >
        {blocked && hint ? hint : `${label} →`}
      </button>
    );
  }

  return (
    <footer class="submitBar" style={`--pct:${pct}`}>
      <div
        class="progress"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        onClick={secretTap}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="15.5" />
          <circle class="fill" cx="18" cy="18" r="15.5" />
        </svg>
        <span class="count">
          {done}
          <small>/{total}</small>
        </span>
      </div>
      {cta}
    </footer>
  );
}

function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => (
        <div class={`toast ${t.kind}`} key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  return (
    <div class={`shell ${celebrating.value ? 'party' : ''}`}>
      <Header />
      <Banners />
      <Results />
      <MangoList />
      <SubmitBar />
      <SubmitSheet />
      <Toasts />
    </div>
  );
}
