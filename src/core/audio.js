// Audio module: tiny synthesized sound effects plus a night ambience loop.
// WebAudio only, no audio files. The AudioContext is created lazily and
// resume() must be called from a user gesture (browsers block autoplay);
// play() is a no-op until the context is running.
// No side effects at import time: everything lives inside createAudio().

const MASTER_VOLUME = 0.22;
const NIGHT_AMBIENCE_GAIN = 0.05; // low rumble + wind, barely there
const DAY_AMBIENCE_GAIN = 0.006; // almost silent by day
const AMBIENCE_FADE = 2; // seconds to cross-fade day/night ambience

// Minimum seconds between two plays of the same sound (anti machine-gun).
const MIN_INTERVAL = {
  place: 0.05,
  demolish: 0.08,
  shot: 0.06,
  'zombie-die': 0.1,
  error: 0.1,
  click: 0.03,
};

/**
 * @returns {{
 *   resume: () => void,
 *   play: (name: string) => void,
 *   setAmbience: (phase: string) => void,
 * }}
 *   play() names: 'place' | 'demolish' | 'shot' | 'zombie-die' | 'error' | 'click'.
 *   setAmbience() phase: 'day' | 'night' (anything non-'night' counts as day).
 */
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null; // 1 s of white noise shared by noise-based sounds
  let ambience = null; // { gain } — persistent nodes, gain-driven on/off
  let pendingPhase = 'day'; // applied when the context finally starts
  const lastPlayed = {}; // sound name -> ctx.currentTime of the last play

  function ensureContext() {
    if (ctx) return true;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  /** Call from a user gesture (click/keydown) to unlock audio. Idempotent. */
  function resume() {
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume();
    applyAmbience(pendingPhase); // catch up on setAmbience() calls made pre-gesture
  }

  // The ambience is a looping noise source through a low-pass filter whose
  // cutoff is slowly swept by an LFO (wind swells). Nodes are created once;
  // day/night only ramps the gain.
  function applyAmbience(phase) {
    if (!ctx) return;
    if (!ambience) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 240;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.09;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 120; // cutoff wanders 120..360 Hz
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start();
      lfo.start();
      ambience = { gain };
    }
    const t = ctx.currentTime;
    const target = phase === 'night' ? NIGHT_AMBIENCE_GAIN : DAY_AMBIENCE_GAIN;
    ambience.gain.gain.cancelScheduledValues(t);
    ambience.gain.gain.setValueAtTime(ambience.gain.gain.value, t);
    ambience.gain.gain.linearRampToValueAtTime(target, t + AMBIENCE_FADE);
  }

  function setAmbience(phase) {
    pendingPhase = phase;
    applyAmbience(phase);
  }

  // --- tiny synth helpers (short-lived nodes are the normal WebAudio way) ---

  function osc(type, freq) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  // Gain node with a fast attack and exponential decay, wired to master.
  function out(peak, decay) {
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    g.connect(master);
    return g;
  }

  function lowpass(freq) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    return f;
  }

  // --- the sounds ---

  function thunk() {
    // 'place': low thud, pitch dropping fast.
    const t = ctx.currentTime;
    const o = osc('sine', 110);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.14);
    o.connect(out(0.7, 0.18));
    o.start(t);
    o.stop(t + 0.2);
  }

  function rumble() {
    // 'demolish': noise burst through a sinking low-pass.
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer;
    const f = lowpass(500);
    f.frequency.exponentialRampToValueAtTime(140, t + 0.35);
    s.connect(f);
    f.connect(out(0.5, 0.4));
    s.start(t);
    s.stop(t + 0.42);
  }

  function snap() {
    // 'shot': short bright click (band-passed noise).
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2600;
    f.Q.value = 5;
    s.connect(f);
    f.connect(out(0.35, 0.07));
    s.start(t);
    s.stop(t + 0.09);
  }

  function descend() {
    // 'zombie-die': very short descending groan.
    const t = ctx.currentTime;
    const o = osc('square', 260);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.22);
    const f = lowpass(900);
    o.connect(f);
    f.connect(out(0.25, 0.24));
    o.start(t);
    o.stop(t + 0.26);
  }

  function buzz() {
    // 'error': two-step low buzz.
    const t = ctx.currentTime;
    const o = osc('sawtooth', 130);
    o.frequency.setValueAtTime(130, t);
    o.frequency.setValueAtTime(98, t + 0.11);
    o.connect(out(0.22, 0.25));
    o.start(t);
    o.stop(t + 0.27);
  }

  function blip() {
    // 'click': tiny UI tick.
    const t = ctx.currentTime;
    const o = osc('sine', 900);
    o.frequency.exponentialRampToValueAtTime(620, t + 0.045);
    o.connect(out(0.18, 0.06));
    o.start(t);
    o.stop(t + 0.08);
  }

  const SOUNDS = {
    place: thunk,
    demolish: rumble,
    shot: snap,
    'zombie-die': descend,
    error: buzz,
    click: blip,
  };

  /** Plays a named sound; no-op before the first user gesture unlocks audio. */
  function play(name) {
    const fn = SOUNDS[name];
    if (!fn || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - (lastPlayed[name] ?? -1) < (MIN_INTERVAL[name] ?? 0.03)) return;
    lastPlayed[name] = now;
    fn();
  }

  return { resume, play, setAmbience };
}
