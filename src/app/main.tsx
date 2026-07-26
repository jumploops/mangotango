import { render } from 'preact';
import '../styles/tokens.css';
import '../styles/app.css';
import { App } from './app';
import { initNetworking, refreshState } from './net';
import { startNectar } from './shader';

const bg = document.getElementById('nectar');
if (bg instanceof HTMLCanvasElement) startNectar(bg);

// Fast first paint over HTTP, then the WebSocket takes over.
void refreshState();
initNetworking();

render(<App />, document.getElementById('app')!);
