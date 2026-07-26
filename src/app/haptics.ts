// Tiny haptic tick on slider detents (Android Chrome; harmless no-op elsewhere).

let enabled = true;

export function tick(): void {
  if (!enabled || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(8);
  } catch {
    enabled = false;
  }
}

export function thump(): void {
  if (!enabled || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate([12, 40, 18]);
  } catch {
    enabled = false;
  }
}
