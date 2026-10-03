/* Sound and music, made in code.
 *
 * There are no audio files. Everything is Web Audio oscillators, noise and
 * envelopes, so there is nothing to download or license, it works offline in
 * the APK, and the music never loops the same way twice.
 *
 * Music is calm space ambient: slow pads moving through four chords, a low
 * drone, and the occasional bell note echoing through a reverb. When your
 * ships are in a fight (a battle, a siege, a conquest under attack) a second
 * layer fades in over a few seconds: a slow drum pulse and a darker chord
 * set. It fades out again when the fight is over.
 *
 * Effects are short synthesized sounds on their own bus, so music and effects
 * have separate switches and volumes in Settings.
 *
 * This replaces the old Reach.AudioSystem and keeps its interface (unlock,
 * play, dispose), so the deck needs no changes to keep working.
 */
(function (SE) {
  'use strict';

  const midi = n => 440 * Math.pow(2, (n - 69) / 12);

  // Calm: D dorian colour. Tense: the same key, darker chords.
  const CALM = [[50, 57, 60, 64, 69], [46, 53, 57, 62, 65], [41, 48, 57, 60, 64], [48, 55, 59, 62, 67]];
  const TENSE = [[50, 57, 60, 65, 69], [46, 53, 58, 62, 65], [43, 50, 55, 58, 62], [45, 52, 57, 61, 64]];
  const BELLS = [74, 76, 77, 79, 81, 84, 86];
  const CHORD_SECS = 14;      // each pad chord lasts this long
  const BEAT = 60 / 72;       // battle pulse tempo
  const LOOKAHEAD = 0.8;      // seconds of music scheduled ahead of the clock

  class AudioSystem {
    constructor(settings) {
      this.settings = settings;
      this.context = null;
      this.voices = 0;
      this.last = {};               // kind -> context time last played, for throttling
      this.intensity = 0;           // battle layer target, 0..1
      this.chord = 0;
      this.nextChord = 0;
      this.nextBell = 0;
      this.nextBeat = 0;
      this.beat = 0;
      this.timer = null;
      this.visibility = () => {
        if (!this.context) return;
        if (document.hidden) void this.context.suspend().catch(() => {});
        else if (this.settings.sound || this.settings.music) void this.context.resume().catch(() => {});
      };
      document.addEventListener('visibilitychange', this.visibility);
    }

    /* Browsers only allow audio after a tap, so the first tap builds the graph. */
    unlock() {
      if (!this.settings.sound && !this.settings.music) return;
      try {
        if (!this.context) this.build();
        if (this.context.state === 'suspended' && !document.hidden) void this.context.resume().catch(() => {});
        this.applySettings();
      } catch (e) {
        this.context = null;
      }
    }

    build() {
      const ctx = this.context = new AudioContext();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14; limiter.ratio.value = 6;
      limiter.connect(ctx.destination);
      this.sfx = ctx.createGain(); this.sfx.connect(limiter);
      this.music = ctx.createGain(); this.music.gain.value = 0; this.music.connect(limiter);
      // One shared reverb: noise with a four-second fade is a passable hall.
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.impulse(2.4);
      this.wet = ctx.createGain(); this.wet.gain.value = 0.55;
      this.reverb.connect(this.wet); this.wet.connect(this.music);
      // Effects get a little of it too, so explosions have somewhere to go.
      this.sfxVerb = ctx.createGain(); this.sfxVerb.gain.value = 0.18;
      this.sfxVerb.connect(this.reverb);
      // Pads go through one slowly breathing low-pass filter.
      this.padFilter = ctx.createBiquadFilter();
      this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 900; this.padFilter.Q.value = 0.7;
      const lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = 0.045; depth.gain.value = 380;
      lfo.connect(depth); depth.connect(this.padFilter.frequency); lfo.start();
      this.padBus = ctx.createGain(); this.padBus.gain.value = 0.9;
      this.padFilter.connect(this.padBus);
      this.padBus.connect(this.music); this.padBus.connect(this.reverb);
      // The battle layer has its own fader.
      this.battle = ctx.createGain(); this.battle.gain.value = 0;
      this.battle.connect(this.music); this.battle.connect(this.reverb);
      this.noise = this.noiseBuffer(1.5);
      this.drone();
      this.nextChord = ctx.currentTime + 0.1;
      this.nextBell = ctx.currentTime + 6;
      this.nextBeat = ctx.currentTime + 0.5;
      this.timer = setInterval(() => this.schedule(), 200);
    }

    applySettings() {
      if (!this.context) return;
      const t = this.context.currentTime;
      this.sfx.gain.setTargetAtTime(this.settings.sound ? (this.settings.volume ?? 0.22) * 2 : 0, t, 0.05);
      this.music.gain.setTargetAtTime(this.settings.music ? (this.settings.musicVolume ?? 0.5) * 0.55 : 0, t, 0.8);
      if (!this.settings.sound && !this.settings.music) void this.context.suspend().catch(() => {});
    }

    impulse(seconds) {
      const ctx = this.context, n = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, n, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
      }
      return buf;
    }

    noiseBuffer(seconds) {
      const ctx = this.context, n = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    /* ---- Music ----------------------------------------------------------- */
    drone() {
      const ctx = this.context;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = midi(38);
      g.gain.value = 0.05;
      o.connect(g); g.connect(this.music); o.start();
      this.droneOsc = o;
    }

    // Battle layer target: set by the host from what is happening.
    setIntensity(v) {
      v = Math.max(0, Math.min(1, v));
      if (v === this.intensity || !this.context) { this.intensity = v; return; }
      this.intensity = v;
      this.battle.gain.setTargetAtTime(v * 0.9, this.context.currentTime, 1.4);
      this.padFilter.frequency.setTargetAtTime(v > 0.5 ? 650 : 900, this.context.currentTime, 2);
    }

    schedule() {
      const ctx = this.context;
      if (!ctx || ctx.state !== 'running' || !this.settings.music) return;
      const horizon = ctx.currentTime + LOOKAHEAD;
      while (this.nextChord < horizon) {
        const set = this.intensity > 0.5 ? TENSE : CALM;
        this.pad(set[this.chord % set.length], this.nextChord, CHORD_SECS);
        this.droneOsc.frequency.setTargetAtTime(midi(set[this.chord % set.length][0] - 12), this.nextChord, 3);
        this.chord++;
        this.nextChord += CHORD_SECS;
      }
      while (this.nextBell < horizon) {
        if (this.intensity < 0.5) this.bell(BELLS[Math.floor(Math.random() * BELLS.length)], this.nextBell);
        this.nextBell += 2.5 + Math.random() * 5;
      }
      while (this.nextBeat < horizon) {
        if (this.intensity > 0.05) this.drum(this.beat, this.nextBeat);
        this.beat++;
        this.nextBeat += BEAT;
      }
    }

    // A chord as slow-attack detuned voices, overlapping the next one.
    pad(notes, at, secs) {
      const ctx = this.context;
      const attack = 4, release = 6, end = at + secs + release;
      notes.forEach((n, i) => {
        for (const detune of [-7, 7]) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = i === 0 ? 'triangle' : 'sawtooth';
          o.frequency.value = midi(n); o.detune.value = detune;
          const peak = (i === 0 ? 0.05 : 0.022);
          g.gain.setValueAtTime(0, at);
          g.gain.linearRampToValueAtTime(peak, at + attack);
          g.gain.setValueAtTime(peak, at + secs);
          g.gain.linearRampToValueAtTime(0, end);
          o.connect(g); g.connect(this.padFilter);
          o.start(at); o.stop(end + 0.1);
        }
      });
    }

    // A soft bell: a sine and a quieter inharmonic partial, long decay.
    bell(n, at) {
      const ctx = this.context;
      for (const [ratio, level] of [[1, 0.06], [2.76, 0.018], [5.4, 0.006]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = midi(n) * ratio;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(level, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 3.5 / ratio);
        o.connect(g); g.connect(this.music); g.connect(this.reverb);
        o.start(at); o.stop(at + 3.6);
      }
    }

    // The battle pulse: a low drum on every beat, a tom on the off-pattern.
    drum(i, at) {
      const ctx = this.context, bar = i % 8;
      const kick = bar === 0 || bar === 3 || bar === 4 || bar === 6;
      if (kick) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(110, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.3);
        g.gain.setValueAtTime(0.5, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
        o.connect(g); g.connect(this.battle); o.start(at); o.stop(at + 0.55);
      }
      if (bar === 2 || bar === 7) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(190, at); o.frequency.exponentialRampToValueAtTime(120, at + 0.25);
        g.gain.setValueAtTime(0.18, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
        o.connect(g); g.connect(this.battle); o.start(at); o.stop(at + 0.4);
      }
      // A low tension note every two bars.
      if (i % 16 === 0) {
        const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = midi(39);
        f.type = 'lowpass'; f.frequency.value = 300;
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.06, at + 2); g.gain.linearRampToValueAtTime(0, at + BEAT * 16);
        o.connect(f); f.connect(g); g.connect(this.battle); o.start(at); o.stop(at + BEAT * 16 + 0.1);
      }
    }

    /* ---- Effects --------------------------------------------------------- */
    ready(kind, gap) {
      const ctx = this.context;
      if (!ctx || ctx.state !== 'running' || !this.settings.sound || this.voices > 24) return false;
      if (gap && ctx.currentTime - (this.last[kind] || -1) < gap) return false;
      this.last[kind] = ctx.currentTime;
      return true;
    }

    tone(type, from, to, secs, level, at, dest) {
      const ctx = this.context, t = at ?? ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(from, t);
      if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + secs);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + Math.min(0.012, secs / 4));
      g.gain.exponentialRampToValueAtTime(0.0001, t + secs);
      o.connect(g); g.connect(dest || this.sfx);
      ++this.voices; o.onended = () => { --this.voices; o.disconnect(); g.disconnect(); };
      o.start(t); o.stop(t + secs + 0.02);
      return g;
    }

    hiss(secs, level, f0, f1, at, q) {
      const ctx = this.context, t = at ?? ctx.currentTime;
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = this.noise; src.loop = true;
      f.type = 'lowpass'; f.Q.value = q || 0.8;
      f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + secs);
      g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.0001, t + secs);
      src.connect(f); f.connect(g); g.connect(this.sfx); g.connect(this.sfxVerb);
      ++this.voices; src.onended = () => { --this.voices; src.disconnect(); };
      src.start(t, Math.random()); src.stop(t + secs + 0.02);
    }

    arp(notes, step, secs, level, type) {
      const t = this.context.currentTime;
      notes.forEach((n, i) => { const g = this.tone(type || 'sine', midi(n), midi(n), secs, level, t + i * step); g.connect(this.sfxVerb); });
    }

    play(kind) {
      switch (kind) {
        // Interface
        case 'click': if (this.ready(kind, 0.05)) this.tone('sine', 880, 660, 0.05, 0.05); break;
        case 'tap': if (this.ready(kind, 0.05)) this.tone('triangle', 660, 990, 0.08, 0.07); break;
        case 'error': if (this.ready(kind, 0.2)) { this.tone('square', 220, 200, 0.09, 0.04); this.tone('square', 180, 165, 0.12, 0.04, this.context.currentTime + 0.11); } break;
        case 'trade': if (this.ready(kind, 0.08)) this.arp([84, 88, 91], 0.05, 0.25, 0.06); break;
        case 'ready': if (this.ready(kind, 0.3)) this.arp([79, 84, 88], 0.09, 0.5, 0.07); break;
        // Moments
        case 'reward': if (this.ready(kind, 0.3)) this.arp([72, 76, 79, 84], 0.08, 0.6, 0.08); break;
        case 'fanfare': if (this.ready(kind, 1)) { this.arp([60, 64, 67, 72], 0.14, 1.6, 0.07, 'sawtooth'); this.arp([72, 76, 79, 84], 0.14, 1.8, 0.05); } break;
        case 'alert': if (this.ready(kind, 1.5)) for (let i = 0; i < 2; i++) { const t = this.context.currentTime + i * 0.32; this.tone('square', 740, 740, 0.14, 0.05, t); this.tone('square', 554, 554, 0.14, 0.05, t + 0.16); } break;
        case 'loss': if (this.ready(kind, 0.8)) this.arp([62, 58, 53], 0.18, 0.9, 0.06, 'triangle'); break;
        // Travel
        case 'jump': if (this.ready(kind, 0.6)) { this.hiss(1.1, 0.25, 300, 4000, undefined, 3); this.tone('sine', 120, 480, 0.9, 0.08); } break;
        case 'arrive': if (this.ready(kind, 0.6)) { this.hiss(0.8, 0.18, 3000, 200, undefined, 2); this.arp([67, 74], 0.12, 0.7, 0.06); } break;
        // Combat
        case 'hit': if (this.ready(kind, 0.25)) this.hiss(0.12, 0.12, 2400, 600); break;
        case 'shot': if (this.ready(kind, 0.07)) this.tone('square', 1300, 380, 0.07, 0.025); break;
        case 'explosion': if (this.ready(kind, 0.12)) { this.hiss(1.2, 0.5, 1800, 60, undefined, 0.5); this.tone('sine', 90, 30, 0.8, 0.3); } break;
        case 'boom': if (this.ready(kind, 0.3)) { this.hiss(2.2, 0.7, 1200, 40, undefined, 0.5); this.tone('sine', 70, 22, 1.6, 0.4); } break;
      }
    }

    // A shot in the system you are watching, voiced by the weapon that fired it.
    /* At most about eight gunshots a second across the whole fight: a battle
       fires dozens a second, and a sound for each one cost half the frame
       rate in testing. The ear cannot tell the difference. */
    shot(weapon) {
      if (!this.ready('shot', 0.12)) return;
      if (weapon.damage >= 18) this.tone('sawtooth', 300, 70, 0.2, 0.04);
      else this.tone('square', 1500 + Math.random() * 300, 420, 0.06, 0.02);
    }

    dispose() {
      document.removeEventListener('visibilitychange', this.visibility);
      clearInterval(this.timer);
      if (this.context) void this.context.close().catch(() => {});
      this.context = null;
    }
  }

  Reach.AudioSystem = AudioSystem;
})(window.SE = window.SE || {});
