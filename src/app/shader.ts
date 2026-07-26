// "Mango nectar" WebGL background: slow domain-warped fbm flowing through a
// mango-flesh palette. Rendered at reduced resolution, throttled to ~30fps,
// paused when the tab is hidden, and frozen to a single frame when the user
// prefers reduced motion. If WebGL is unavailable the canvas stays empty and
// the CSS gradient behind it takes over.

const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_t;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(11.3, -7.1);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * 1.6;
  float t = u_t * 0.045;

  // Domain warp: nectar swirl.
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t * 0.7));
  vec2 r = vec2(fbm(p + 2.6 * q + vec2(1.7, 9.2) + t * 0.4),
                fbm(p + 2.6 * q + vec2(8.3, 2.8) - t * 0.3));
  float f = fbm(p + 3.0 * r);

  // Palette: deep jungle night -> mango flesh -> sunrise blush.
  vec3 night  = vec3(0.055, 0.045, 0.03);
  vec3 jungle = vec3(0.06, 0.13, 0.07);
  vec3 mango  = vec3(0.95, 0.62, 0.12);
  vec3 blush  = vec3(0.88, 0.25, 0.14);
  vec3 lime   = vec3(0.55, 0.75, 0.2);

  vec3 col = mix(night, jungle, smoothstep(0.1, 0.55, f));
  col = mix(col, mango * 0.55, smoothstep(0.45, 0.78, f) * 0.8);
  col = mix(col, blush * 0.5, smoothstep(0.68, 0.95, length(q) * f) * 0.7);
  col = mix(col, lime * 0.35, smoothstep(0.5, 0.9, r.y) * 0.35);

  // Gentle top-glow vignette so cards stay readable.
  col *= 0.55 + 0.45 * smoothstep(1.25, 0.15, length(uv - vec2(0.5, 0.85)));

  gl_FragColor = vec4(col, 1.0);
}
`;

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

export function startNectar(canvas: HTMLCanvasElement): void {
  const gl =
    canvas.getContext('webgl', { antialias: false, depth: false, stencil: false }) ??
    (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
  if (!gl) return;

  // If the browser reclaims the GPU context (common on mobile under memory
  // pressure), hide the canvas so the CSS gradient fallback shows instead of
  // a broken frame.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    canvas.style.display = 'none';
  });

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uT = gl.getUniformLocation(prog, 'u_t');

  // Half-resolution render, CSS upscales — nectar is soft anyway.
  const SCALE = 0.5;
  const resize = (): void => {
    const w = Math.max(2, Math.floor(innerWidth * SCALE));
    const h = Math.max(2, Math.floor(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  resize();
  addEventListener('resize', resize);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const start = performance.now();
  let raf = 0;
  let lastFrame = 0;

  const draw = (t: number): void => {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastFrame < 33) return; // ~30fps is plenty for nectar
    lastFrame = now;
    draw((now - start) / 1000);
  };

  const play = (): void => {
    cancelAnimationFrame(raf);
    if (reduced.matches) {
      draw(12.0); // one pretty, static frame
    } else {
      raf = requestAnimationFrame(frame);
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else play();
  });
  reduced.addEventListener?.('change', play);
  play();
}
