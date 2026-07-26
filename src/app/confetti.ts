// Submission celebration: a 2D-canvas burst of mango slices. Cheap, joyful,
// self-removing, and skipped entirely under prefers-reduced-motion.

const GLYPHS = ['🥭', '🥭', '🥭', '💛', '🧡', '💚', '✨'];

export function mangoBurst(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }

  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);

  interface P {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    vr: number;
    size: number;
    glyph: string;
  }

  const cx = innerWidth / 2;
  const cy = innerHeight * 0.72;
  const parts: P[] = Array.from({ length: 90 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const speed = 380 + Math.random() * 620;
    return {
      x: cx + (Math.random() - 0.5) * 90,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 10,
      size: 16 + Math.random() * 22,
      glyph: GLYPHS[(Math.random() * GLYPHS.length) | 0],
    };
  });

  const started = performance.now();
  let prev = started;
  const DURATION = 2400;

  const frame = (now: number): void => {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;
    const elapsed = now - started;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const fade = elapsed > DURATION - 500 ? Math.max(0, (DURATION - elapsed) / 500) : 1;
    ctx.globalAlpha = fade;

    for (const p of parts) {
      p.vy += 1300 * dt;
      p.vx *= 0.995;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.font = `${p.size}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.glyph, 0, 0);
      ctx.restore();
    }

    if (elapsed < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
