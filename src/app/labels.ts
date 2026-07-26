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

export const SCORE_LOOKS: Record<number, ScoreLook> = {
  1: { label: 'compost tier', emoji: '🫠', l: 0.48, c: 0.06, h: 55 },
  2: { label: 'stringy sadness', emoji: '😖', l: 0.55, c: 0.08, h: 65 },
  3: { label: 'meh-ngo', emoji: '😕', l: 0.63, c: 0.1, h: 78 },
  4: { label: 'it’s fine', emoji: '😐', l: 0.72, c: 0.13, h: 90 },
  5: { label: 'solid snack', emoji: '🙂', l: 0.78, c: 0.15, h: 100 },
  6: { label: 'pretty tasty', emoji: '😊', l: 0.8, c: 0.16, h: 110 },
  7: { label: 'juicy business', emoji: '😋', l: 0.78, c: 0.17, h: 122 },
  8: { label: 'dangerously good', emoji: '🤤', l: 0.75, c: 0.18, h: 135 },
  9: { label: 'transcendent', emoji: '🤩', l: 0.73, c: 0.19, h: 143 },
  10: { label: 'MANGO NIRVANA', emoji: '👑', l: 0.72, c: 0.2, h: 30 },
};

export function look(score: number): ScoreLook {
  return SCORE_LOOKS[score] ?? SCORE_LOOKS[5];
}

/** Inline CSS custom props driving a card/slider's score color. */
export function scoreVars(score: number): string {
  const s = look(score);
  return `--sl:${s.l};--sc:${s.c};--sh:${s.h}`;
}
