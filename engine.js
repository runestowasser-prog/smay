class SamplerEngine {

  constructor() {
    this.audioCtx = null;
    this.masterGain = null;

    this.slots = [];
    this.activeVoices = {};
    this.audioCache = {};

    this.currentPitchBend = 0;

    this.sustainPedal = false;
    this.sustainedNotes = new Set();
    this.heldNotes = new Set();
    this.sustainActive = false;
    this.sustainedVoices = []; // voices holdt af pedal
    this.modWheel = 0; // 0-127
  }

  async initAudio() {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = 0.8;
    this.masterGain.connect(this.audioCtx.destination);
    console.log("Audio ready");
  }

  async loadSample(name, url) {

    if (this.audioCache[name]) return this.audioCache[name];

    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = await this.audioCtx.decodeAudioData(arrayBuffer);

    this.audioCache[name] = buffer;
    return buffer;
  }

  async load(session) {

    this.session = session;
    this.slots = session.slots; // 🔥 reference, ikke kopi

    for (let slot of this.slots) {

      if (!slot.buffer) {
        slot.buffer = await this.loadSample(
          slot.sample,
          "samples/" + slot.sample
        );
      }

    }

    console.log("Config loaded");
  }

  async reloadSlotSample(slot) {
    slot.buffer = await this.loadSample(
      slot.sample,
      "samples/" + slot.sample
    );
  }

    async changeSlotSample(slotIndex, sampleName) {
      const slot = this.session.slots[slotIndex];
      slot.sample = sampleName;
      slot.buffer = this.audioCache[sampleName] || null;
    }

  playNote(note, velocity = 127) {

  const capturedPitchBend = this.currentPitchBend;

  for (let slot of this.slots) {
    if (!slot.buffer) continue;
    if (note < slot.startKey) continue;
    if (note > slot.endKey) continue;
    if (velocity < (slot.velMin ?? 0)) continue;
    if (velocity > (slot.velMax ?? 127)) continue;

    // schedule play
    this._processSlotEvent(
      slot,
      (n, v) => this._playSlot(slot, n, v, capturedPitchBend),
      note,
      velocity
    );
  }
}

stopNote(note) {
  if (!this.activeVoices[note]) return;

  for (let slot of this.slots) {
    this._processSlotEvent(
      slot,
      (n) => this._releaseVoicesForSlot(n, slot),
      note
    );
  }
}

/**
 * Generic scheduler for a slot event
 */
_processSlotEvent(slot, fn, note, velocity) {
  const delay = (slot.midiDelay || 0); // delay i ms

  if (delay <= 0) {
    fn(note, velocity);
  } else {
    setTimeout(() => fn(note, velocity), delay);
  }
}
  setPitchBend(value14bit) {

    const normalized = (value14bit - 8192) / 8192;

    for (let slot of this.slots) {

      this._processSlotEvent(slot, () => {

        const now = this.audioCtx.currentTime;

        for (let note in this.activeVoices) {

          for (let voice of this.activeVoices[note]) {

            if (voice.slot !== slot) continue;

            const pitchRatio = Math.pow(
              2,
              (note - slot.rootNote + slot.transpose) / 12
            );

            const bendRatio = Math.pow(
              2,
              (normalized * slot.pitchbendRange) / 12
            );

            voice.source.playbackRate.setValueAtTime(
              pitchRatio * bendRatio,
              now
            );
          }
        }
      });
    }

    this.currentPitchBend = normalized;
  }

  _releaseVoices(note) {

    if (!this.activeVoices[note]) return;

    const now = this.audioCtx.currentTime;

    for (let voice of this.activeVoices[note]) {

      const release = voice.slot.release;

      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(
        voice.gain.gain.value,
        now
      );

      voice.gain.gain.linearRampToValueAtTime(
        0,
        now + release
      );

      voice.source.stop(now + release + 0.01);
    }

    delete this.activeVoices[note];
  }

  handleCC(cc, value) {

  if (cc === 1) { // modwheel
      this.modWheel = value;
      this.updateVibratoDepth();
  }

  if (cc === 64) {
    this.handleSustain(value);
  }
}

  updateVibratoDepth() {

    for (let note in this.activeVoices) {
      for (let voice of this.activeVoices[note]) {

        if (!voice.lfoGain) continue;

        const slot = voice.slot;

        const totalDepth =
          slot.vibratoDepth +
          (this.modWheel / 127) * slot.vibratoModDepth;

        const depthInRate =
          Math.pow(2, totalDepth / 12) - 1;

        voice.lfoGain.gain.setValueAtTime(
          depthInRate,
          this.audioCtx.currentTime
        );
      }
    }
  }
  
  handleSustain(value) {
    const now = this.audioCtx.currentTime;

    this.sustainActive = value >= 64;

    // Hvis pedal slippes, frigiv alle sustained voices
    if (!this.sustainActive) {
      for (let voice of this.sustainedVoices) {
        const slot = voice.slot;
        const release = slot.release;

        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + release);

        voice.source.stop(now + release + 0.01);
      }
      this.sustainedVoices = [];
    }
  }
  

  _playSlot(slot, note, velocity, pitchBendValue) {
  if (!slot.buffer) return;
  const now = this.audioCtx.currentTime;
  const scheduledTime = now;
    
  // Audio nodes
  const source = this.audioCtx.createBufferSource();
  const gain = this.audioCtx.createGain();
  source.buffer = slot.buffer;

  // 🎹 Pitch (note + transpose + pitchbend)
  const pitchRatio = Math.pow(2, (note - slot.rootNote + (slot.transpose || 0)) / 12);
  const bendRatio  = Math.pow(2, (pitchBendValue * (slot.pitchbendRange || 2)) / 12);
  source.playbackRate.setValueAtTime(pitchRatio * bendRatio, scheduledTime);

  // 🎚 Velocity + slot volume + optional velocityDepth
  const velNorm = velocity / 127;
const velocityDepth = slot.velocityDepth ?? 1;

let velocityTarget;

if (velocityDepth >= 0) {
  velocityTarget = velNorm;
} else {
  velocityTarget = 1 - velNorm;
}

const depth = Math.min(1, Math.abs(velocityDepth));
const velocityGain = (1 - depth) + (velocityTarget * depth);

const finalGain = velocityGain * (slot.volume ?? 1);

  gain.gain.setValueAtTime(0, scheduledTime);
  gain.gain.linearRampToValueAtTime(finalGain, scheduledTime + (slot.attack || 0));

const decay = slot.decay ?? 0;
const sustainLevel = slot.sustainLevel ?? 1;

if (decay > 0) {
  gain.gain.linearRampToValueAtTime(
    finalGain * sustainLevel,
    scheduledTime + (slot.attack || 0) + decay
  );
}

  // Connect nodes
  source.connect(gain).connect(this.masterGain);

  // ⚡ Voice object (må defineres før vibrato)
  const voice = { source, gain, slot };

  // 🎛 Vibrato + fade + modwheel
  if ((slot.vibratoDepth || 0) !== 0 || (slot.vibratoModDepth || 0) !== 0) {
    const lfo = this.audioCtx.createOscillator();
    const lfoGain = this.audioCtx.createGain();

    lfo.type = "sine";
    lfo.frequency.value = slot.vibratoRate || 5;

    const totalDepth = (slot.vibratoDepth || 0) + (this.modWheel / 127) * (slot.vibratoModDepth || 0);
    const depthInRate = Math.pow(2, totalDepth / 12) - 1;

    // Start fade (kan også + slot.attack hvis du vil fade efter attack)
    lfoGain.gain.setValueAtTime(0, scheduledTime);
    lfoGain.gain.linearRampToValueAtTime(depthInRate, scheduledTime + (slot.vibratoFade || 0));

    lfo.connect(lfoGain);
    lfoGain.connect(source.playbackRate);

    lfo.start(scheduledTime);

    voice.lfo = lfo;
    voice.lfoGain = lfoGain;
  }
  source.loop = slot.playbackMode === "loop";

  if (source.loop) {
    source.loopStart = slot.loopStart || 0;
    source.loopEnd = slot.loopEnd || slot.buffer.duration;
  }
  // 🎯 Velocity → Sample Start Offset
  let startOffset = 0;

  if (slot.velocityStartDepth) {

    const velNorm = velocity / 127;

    // depth i sekunder (fx 0.05 = 50ms max offset)
    const maxOffset = slot.velocityStartDepth;

    startOffset = (1 - velNorm) * maxOffset;
  }
  // Start note
  source.start(scheduledTime, startOffset);

  // Gem i activeVoices
  if (!this.activeVoices[note]) this.activeVoices[note] = [];
  this.activeVoices[note].push(voice);
}

  _releaseVoicesForSlot(note, slot) {
    if (!this.activeVoices[note]) return;

    const now = this.audioCtx.currentTime;

    this.activeVoices[note] =
      this.activeVoices[note].filter(voice => {

        if (voice.slot !== slot) return true;

        // Hvis sustain er aktiv, læg i sustained array i stedet for at stoppe
        if (this.sustainActive) {
          this.sustainedVoices.push(voice);
          return false; // fjerner fra activeVoices, men stopper ikke
        }

        // ellers normal release
        const release = slot.release;

        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + release);

        voice.source.stop(now + release + 0.01);
        if (voice.lfo) {
          voice.lfo.stop(this.audioCtx.currentTime + slot.release + 0.1);
        }

        return false;
      });
  }

}

