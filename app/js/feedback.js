/**
 * app/js/feedback.js
 * ───────────────────
 * Short synthesized sound cues (WebAudio, no files → nothing for the CSP to
 * allow). Played for GLOBAL hotkey events only: that is exactly when the player
 * is looking at the game, not at this window, and needs to know the key landed.
 *
 * Each cue is a list of notes [frequencyHz, startSec, durationSec, wave?].
 * Distinct shapes so they can be told apart without thinking:
 *   allocate  one bright tick         stepDone  rising two-note
 *   treeDone  major arpeggio          undo      one low tick
 *   denied    low buzz (tree complete / no data)
 *   armed / disarmed  quick up / down blip (arm-first mode)
 */

const CUES = {
  allocate: [[880, 0, 0.07]],
  stepDone: [[660, 0, 0.07], [990, 0.075, 0.11]],
  treeDone: [[523, 0, 0.12], [659, 0.09, 0.12], [784, 0.18, 0.12], [1047, 0.27, 0.22]],
  undo: [[392, 0, 0.08]],
  denied: [[150, 0, 0.18, 'square']],
  armed: [[740, 0, 0.05], [1109, 0.06, 0.06]],
  disarmed: [[1109, 0, 0.05], [740, 0.06, 0.06]],
};

let ctx = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * @param {keyof CUES} name
 * @param {number} volume 0–1
 */
export function playCue(name, volume = 0.6) {
  const notes = CUES[name];
  const ac = notes && volume > 0 ? audio() : null;
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  const peak = 0.22 * Math.min(1, Math.max(0, volume)); // square waves are loud: keep headroom
  for (const [freq, start, dur, wave = 'triangle'] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    const at = t0 + start;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(wave === 'square' ? peak * 0.4 : peak, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}
