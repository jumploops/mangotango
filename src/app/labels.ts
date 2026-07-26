// Score → words, emoji, and color. Never color alone: every score surface
// shows the number and a label too (init.md §4 + accessibility reqs).

export interface ScoreLook {
  label: string;
  emoji: string;
  /** oklch components for the score color. */
  l: number;
  c: number;
  h: number;
}

/* Score bands (lightness ≤ 0.71 so text reads on white-glass cards):
   1–2 brown, 3–4 yellow, 5–6 green, 7–8 orange, 9 red.
   10 is the whole mango — green+yellow+red at once; the base color below is
   its fallback, the tri-color display lives in CSS behind `.nirvana`. */
export const SCORE_LOOKS: Record<number, ScoreLook> = {
  1: { label: 'compost tier', emoji: '🫠', l: 0.42, c: 0.07, h: 55 },
  2: { label: 'stringy sadness', emoji: '😖', l: 0.48, c: 0.09, h: 60 },
  3: { label: 'meh-ngo', emoji: '😕', l: 0.68, c: 0.15, h: 95 },
  4: { label: 'it’s fine', emoji: '😐', l: 0.71, c: 0.17, h: 98 },
  5: { label: 'solid snack', emoji: '🙂', l: 0.58, c: 0.16, h: 135 },
  6: { label: 'pretty tasty', emoji: '😊', l: 0.53, c: 0.16, h: 148 },
  7: { label: 'juicy business', emoji: '😋', l: 0.66, c: 0.17, h: 65 },
  8: { label: 'dangerously good', emoji: '🤤', l: 0.61, c: 0.2, h: 48 },
  9: { label: 'transcendent', emoji: '🤩', l: 0.55, c: 0.22, h: 30 },
  10: { label: 'MANGO NIRVANA', emoji: '👑', l: 0.56, c: 0.22, h: 30 },
};

export function look(score: number): ScoreLook {
  return SCORE_LOOKS[score] ?? SCORE_LOOKS[5];
}

/** Inline CSS custom props driving a card/slider's score color. */
export function scoreVars(score: number): string {
  const s = look(score);
  return `--sl:${s.l};--sc:${s.c};--sh:${s.h}`;
}
