import { render } from 'preact';
import '../styles/tokens.css';
import '../styles/app.css';
import { App } from './app';
import { initNetworking, refreshState } from './net';
import { startNectar } from './shader';

/** Flip to false when the next event starts. While true, the home page is
    fully static — no /api/state fetch, no WebSocket, no polling — so
    crawlers and stray visitors never wake the Durable Object. */
const EVENT_CLOSED = true;

const bg = document.getElementById('nectar');
if (bg instanceof HTMLCanvasElement) startNectar(bg);

function ClosedPage() {
  return (
    <div class="shell">
      <header class="hero">
        <h1 aria-label="Mango Tango">
          <span class="line1" aria-hidden="true">
            {[...'MANGO'].map((ch, i) => (
              <b style={`--n:${i}`} key={i}>
                {ch}
              </b>
            ))}
          </span>
          <span class="line2" aria-hidden="true">
            TANGO <span class="fruit">🥭</span>
          </span>
        </h1>
        <p class="tag">rate every mango · crown the champion</p>
        <span class="pill off">
          <span class="dot" /> Ranking closed
        </span>
      </header>
      <a class="reportLink" href="/results">
        🏆 The 2026 results are in — <b>see the full report →</b>
      </a>
      <section class="banner">
        🥭 The 2026 tasting has wrapped — thanks for dancing. See you next season.
      </section>
    </div>
  );
}

if (EVENT_CLOSED) {
  render(<ClosedPage />, document.getElementById('app')!);
} else {
  // Fast first paint over HTTP, then the WebSocket takes over.
  void refreshState();
  initNetworking();
  render(<App />, document.getElementById('app')!);
}
