// Shared one-shot audio playback. Browsers refuse to play until there's been a user
// gesture somewhere on the page; failures here are silent rather than surfaced.

export function playSound(src: string, volume = 0.5): void {
  const audio = new Audio(src);
  audio.volume = volume;
  void audio.play().catch(() => {});
}
