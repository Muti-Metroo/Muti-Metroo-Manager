// Synthesised UI cues. No audio assets — every sound is generated via
// WebAudio so the bundle stays asset-free. Sounds are short (50–250ms)
// and quiet (master gain ~0.04).

export type SoundKind = 'click' | 'chord' | 'descend' | 'hover' | 'alert';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.04;
  master.connect(ctx.destination);
  return ctx;
}

function tone(
  freq: number,
  startOffsetMs: number,
  durationMs: number,
  type: OscillatorType = 'sine',
  peakGain = 1,
): void {
  const c = ctx;
  const m = master;
  if (!c || !m) return;
  const t0 = c.currentTime + startOffsetMs / 1000;
  const t1 = t0 + durationMs / 1000;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peakGain, t0 + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t1);
  osc.connect(env).connect(m);
  osc.start(t0);
  osc.stop(t1 + 0.02);
}

export function playSound(kind: SoundKind): void {
  if (!ensureContext()) return;
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume();
  }
  switch (kind) {
    case 'click':
      tone(880, 0, 60, 'square', 0.5);
      break;
    case 'hover':
      tone(1320, 0, 35, 'sine', 0.25);
      break;
    case 'chord':
      tone(523.25, 0, 220, 'triangle', 0.55);
      tone(659.25, 30, 220, 'triangle', 0.5);
      tone(783.99, 60, 240, 'triangle', 0.45);
      break;
    case 'descend':
      tone(659.25, 0, 140, 'triangle', 0.55);
      tone(440.0, 90, 200, 'triangle', 0.55);
      break;
    case 'alert':
      tone(196.0, 0, 220, 'sawtooth', 0.4);
      tone(146.83, 100, 260, 'sawtooth', 0.4);
      break;
  }
}
