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
  this.currentPitchBend = normalized;

  for (const slot of this.slots) {
    this._processSlotEvent(slot, () => {
      slot.delayedPitchBend = normalized;

      const now = this.audioCtx.currentTime;

      for (let note in this.activeVoices) {
        for (let voice of this.activeVoices[note]) {
          if (voice.slot !== slot) continue;

          voice.currentPitchBend = normalized;

          const pitchRatio = Math.pow(
            2,
            (note - slot.rootNote + (slot.transpose || 0)) / 12
          );

          const bendRatio = Math.pow(
            2,
            (normalized * (slot.pitchbendRange || 2)) / 12
          );

          const newPlaybackRate = pitchRatio * bendRatio;

          if (voice.source && voice.source.playbackRate) {
            voice.source.playbackRate.setValueAtTime(newPlaybackRate, now);
          }

          if (voice.sources && Array.isArray(voice.sources)) {
            for (const src of voice.sources) {
              if (src && src.playbackRate) {
                src.playbackRate.setValueAtTime(newPlaybackRate, now);
              }
            }
          }

          voice.playbackRate = newPlaybackRate;
        }
      }
    });
  }
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
	  console.log("CC:"+cc+value);
	
  if (cc === 1) { // modwheel
      this.modWheel = value;
      this.updateVibratoDepth();
  }

  if (cc === 64) {
    this.handleSustain(value);
  }
}

	updateVibratoDepth() {
	  const now = this.audioCtx.currentTime;
	  console.log("Updating vibrato", this.modWheel);

	  for (let note in this.activeVoices) {
		for (let voice of this.activeVoices[note]) {
		  if (!voice.lfoGain) continue;

		  const slot = voice.slot;

		  const totalDepth =
			(slot.vibratoDepth || 0) +
			(this.modWheel / 127) * (slot.vibratoModDepth || 0);

		  const depthInRate =
			Math.pow(2, totalDepth / 12) - 1;

		  voice.lfoGain.gain.setValueAtTime(depthInRate, now);
		}
	  }
	}

  handleSustain(value) {
	  const now = this.audioCtx.currentTime;

	  this.sustainActive = value >= 64;

	  if (!this.sustainActive) {
		for (let voice of this.sustainedVoices) {
		  const slot = voice.slot;
		  const release = slot.release || 0;

		  if (voice.timers) {
			voice.timers.forEach(t => clearTimeout(t));
			voice.timers = [];
		  }

		  voice.stopped = true;

		  if (voice.gain?.gain) {
			voice.gain.gain.cancelScheduledValues(now);
			voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
			voice.gain.gain.linearRampToValueAtTime(0, now + release);
		  }

		  if (voice.source) {
			try {
			  voice.source.stop(now + release + 0.01);
			} catch {}
		  }

		  if (voice.sources && Array.isArray(voice.sources)) {
			for (const src of voice.sources) {
			  try {
				src.stop(now + release + 0.02);
			  } catch {}
			}
		  }

		  if (voice.lfo) {
			try {
			  voice.lfo.stop(now + release + 0.1);
			} catch {}
		  }
		}

		this.sustainedVoices = [];
	  }
	}
  

 _playSlot(slot, note, velocity, pitchBendValue) {
  if (!slot.buffer) return;

  const now = this.audioCtx.currentTime;
  const scheduledTime = now;

  // 🎯 Velocity → Sample Start Offset
  let startOffset = 0;

  if (slot.velocityStartDepth) {
    const velNorm = velocity / 127;
    const maxOffset = slot.velocityStartDepth;
    startOffset = (1 - velNorm) * maxOffset;
  }

  // 🔁 Crossfade loop skal håndteres FØR normal source oprettes
  const effectivePitchBend =
	  (slot.delayedPitchBend ?? pitchBendValue ?? 0);

	if (slot.crossfadeMs > 0 && slot.playbackMode === "loop") {
	  return this._playCrossfadeLoopSlot(
		slot,
		note,
		velocity,
		effectivePitchBend,
		scheduledTime,
		startOffset
	  );
	}

  // ---- Normal playback herfra ----

  const source = this.audioCtx.createBufferSource();
  const gain = this.audioCtx.createGain();

  source.buffer = slot.buffer;

  // 🎹 Pitch
  const pitchRatio = Math.pow(
    2,
    (note - slot.rootNote + (slot.transpose || 0)) / 12
  );

  const bendRatio = Math.pow(
    2,
    (effectivePitchBend * (slot.pitchbendRange || 2)) / 12
  );

  source.playbackRate.setValueAtTime(
    pitchRatio * bendRatio,
    scheduledTime
  );

  // 🎚 Velocity + volume
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
  gain.gain.linearRampToValueAtTime(
    finalGain,
    scheduledTime + (slot.attack || 0)
  );

  const decay = slot.decay ?? 0;
  const sustainLevel = slot.sustainLevel ?? 1;

  if (decay > 0) {
    gain.gain.linearRampToValueAtTime(
      finalGain * sustainLevel,
      scheduledTime + (slot.attack || 0) + decay
    );
  }

  source.connect(gain).connect(this.masterGain);

  const voice = { source, gain, slot, currentPitchBend: effectivePitchBend };

  // 🎛 Vibrato
  if ((slot.vibratoDepth || 0) !== 0 || (slot.vibratoModDepth || 0) !== 0) {
    const lfo = this.audioCtx.createOscillator();
    const lfoGain = this.audioCtx.createGain();

    lfo.type = "sine";
    lfo.frequency.value = slot.vibratoRate || 5;

    const totalDepth =
      (slot.vibratoDepth || 0) +
      (this.modWheel / 127) * (slot.vibratoModDepth || 0);

    const depthInRate = Math.pow(2, totalDepth / 12) - 1;

    lfoGain.gain.setValueAtTime(0, scheduledTime);
    lfoGain.gain.linearRampToValueAtTime(
      depthInRate,
      scheduledTime + (slot.vibratoFade || 0)
    );

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

  source.start(scheduledTime, startOffset);

  if (!this.activeVoices[note]) {
    this.activeVoices[note] = [];
  }

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
			return false;
		  }

		  const release = slot.release || 0;

		  // stop fremtidige loop-timers
		  if (voice.timers) {
			voice.timers.forEach(t => clearTimeout(t));
			voice.timers = [];
		  }

		  // markér voice som stoppet
		  voice.stopped = true;

		  // fade voice ud
		  if (voice.gain?.gain) {
			voice.gain.gain.cancelScheduledValues(now);
			voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
			voice.gain.gain.linearRampToValueAtTime(0, now + release);
		  }

		  // gammel "single source" voice
		  if (voice.source) {
			try {
			  voice.source.stop(now + release + 0.01);
			} catch {}
		  }

		  // ny crossfade-loop voice med flere sources
		  if (voice.sources && Array.isArray(voice.sources)) {
			for (const src of voice.sources) {
			  try {
				src.stop(now + release + 0.02);
			  } catch {}
			}
		  }

		  // stop vibrato/LFO
		  if (voice.lfo) {
			try {
			  voice.lfo.stop(now + release + 0.1);
			} catch {}
		  }

		  return false;
		});

	  if (this.activeVoices[note].length === 0) {
		delete this.activeVoices[note];
	  }
	}
  
  _playCrossfadeLoopSlot(slot, note, velocity, pitchBendValue, scheduledTime, startOffset = 0) {
  if (!slot.buffer) return null;

  const buffer = slot.buffer;
  const loopStart = Math.max(0, slot.loopStart || 0);
  const loopEnd = Math.min(slot.loopEnd || buffer.duration, buffer.duration);

  if (loopEnd <= loopStart) {
    console.warn("Invalid loop points");
    return null;
  }

  // pitch
  const pitchRatio = Math.pow(
    2,
    (note - slot.rootNote + (slot.transpose || 0)) / 12
  );

  const bendRatio = Math.pow(
    2,
    (pitchBendValue * (slot.pitchbendRange || 2)) / 12
  );

  const playbackRate = pitchRatio * bendRatio;

  // loop timing
  const bufferLoopLength = loopEnd - loopStart;
  const realLoopLength = bufferLoopLength / playbackRate;

  const crossfadeBufferSec = Math.min(
    (slot.crossfadeMs || 0) / 1000,
    bufferLoopLength * 0.45
  );

  const crossfadeRealSec = crossfadeBufferSec / playbackRate;

  // velocity
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

  // master gain for hele voice
  const voiceGain = this.audioCtx.createGain();
  voiceGain.gain.setValueAtTime(0, scheduledTime);
  voiceGain.gain.linearRampToValueAtTime(
    finalGain,
    scheduledTime + (slot.attack || 0)
  );

  // decay / sustain
  const decay = slot.decay ?? 0;
  const sustainLevel = slot.sustainLevel ?? 1;

  if (decay > 0) {
    voiceGain.gain.linearRampToValueAtTime(
      finalGain * sustainLevel,
      scheduledTime + (slot.attack || 0) + decay
    );
  }

  voiceGain.connect(this.masterGain);

  const voice = {
    slot,
    note,
    stopped: false,
    gain: voiceGain,
    sources: [],
    timers: [],
    playbackRate,
    finalGain,
    lfo: null,
    lfoGain: null,
	currentPitchBend: pitchBendValue
  };

  // vibrato oprettes FØR første segment
  if ((slot.vibratoDepth || 0) !== 0 || (slot.vibratoModDepth || 0) !== 0) {
  const lfo = this.audioCtx.createOscillator();
  const lfoGain = this.audioCtx.createGain();

  lfo.type = "sine";
  lfo.frequency.value = slot.vibratoRate || 5;

  const totalDepth =
    (slot.vibratoDepth || 0) +
    (this.modWheel / 127) * (slot.vibratoModDepth || 0);

  const depthInRate = Math.pow(2, totalDepth / 12) - 1;

  lfoGain.gain.setValueAtTime(0, scheduledTime);
  lfoGain.gain.linearRampToValueAtTime(
    depthInRate,
    scheduledTime + (slot.vibratoFade || 0)
  );

  lfo.connect(lfoGain);   // 🔥 den manglede

  voice.lfo = lfo;
  voice.lfoGain = lfoGain;

  lfo.start(scheduledTime);
}

  const makeSegment = (segmentStartTime, offsetInBuffer, bufferDuration, fadeInBuffer, fadeOutBuffer) => {
    const source = this.audioCtx.createBufferSource();
    const segGain = this.audioCtx.createGain();

    source.buffer = buffer;
    const pitchRatio = Math.pow(
	  2,
	  (note - slot.rootNote + (slot.transpose || 0)) / 12
	);

	const bendRatio = Math.pow(
	  2,
	  (this.currentPitchBend * (slot.pitchbendRange || 2)) / 12
	);

	const livePitchRatio = Math.pow(
	  2,
	  (note - slot.rootNote + (slot.transpose || 0)) / 12
	);

	const liveBendRatio = Math.pow(
	  2,
	  ((voice.currentPitchBend || 0) * (slot.pitchbendRange || 2)) / 12
	);

	const livePlaybackRate = livePitchRatio * liveBendRatio;

	source.playbackRate.setValueAtTime(livePlaybackRate, segmentStartTime);

    source.connect(segGain);
    segGain.connect(voiceGain);

    const realDuration = bufferDuration / livePlaybackRate;
    const fadeInReal = fadeInBuffer / livePlaybackRate;
    const fadeOutReal = fadeOutBuffer / livePlaybackRate;

    segGain.gain.setValueAtTime(fadeInReal > 0 ? 0 : 1, segmentStartTime);

    if (fadeInReal > 0) {
      segGain.gain.linearRampToValueAtTime(1, segmentStartTime + fadeInReal);
    }

    const fadeOutStart = segmentStartTime + realDuration - fadeOutReal;

    if (fadeOutReal > 0 && fadeOutStart > segmentStartTime) {
      segGain.gain.setValueAtTime(1, fadeOutStart);
      segGain.gain.linearRampToValueAtTime(0, segmentStartTime + realDuration);
    }

    // LFO tilkobles HVER source
    if (voice.lfoGain) {
      try {
        voice.lfoGain.connect(source.playbackRate);
      } catch {}
    }

    source.start(segmentStartTime, offsetInBuffer, bufferDuration);
    source.stop(segmentStartTime + realDuration + 0.02);

    source.onended = () => {
      try { source.disconnect(); } catch {}
      try { segGain.disconnect(); } catch {}
    };

    voice.sources.push(source);
    return source;
  };

  const scheduleLoopSegment = (segmentStartTime) => {
    if (voice.stopped) return;

    makeSegment(
      segmentStartTime,
      loopStart,
      bufferLoopLength,
      crossfadeBufferSec,
      crossfadeBufferSec
    );

    const nextStartTime = segmentStartTime + realLoopLength - crossfadeRealSec;

    const msUntilSchedule = Math.max(
      0,
      (nextStartTime - this.audioCtx.currentTime - 0.02) * 1000
    );

    const timer = setTimeout(() => {
      scheduleLoopSegment(nextStartTime);
    }, msUntilSchedule);

    voice.timers.push(timer);
  };

  // første segment
  let firstOffset = Math.max(0, Math.min(startOffset, loopEnd));
  if (firstOffset >= loopEnd) {
    firstOffset = loopStart;
  }

  const firstBufferLength = loopEnd - firstOffset;
  const firstRealLength = firstBufferLength / playbackRate;

  makeSegment(
    scheduledTime,
    firstOffset,
    firstBufferLength,
    0,
    crossfadeBufferSec
  );

  const firstLoopStartTime = scheduledTime + firstRealLength - crossfadeRealSec;

  const firstTimerMs = Math.max(
    0,
    (firstLoopStartTime - this.audioCtx.currentTime - 0.02) * 1000
  );

  const firstTimer = setTimeout(() => {
    scheduleLoopSegment(firstLoopStartTime);
  }, firstTimerMs);

  voice.timers.push(firstTimer);

  if (!this.activeVoices[note]) {
    this.activeVoices[note] = [];
  }

  this.activeVoices[note].push(voice);
  return voice;
}

stopAllVoices(releaseOverride = 0.05) {
  const now = this.audioCtx.currentTime;

  for (const note in this.activeVoices) {
    for (const voice of this.activeVoices[note]) {
      if (voice.timers) {
        voice.timers.forEach(t => clearTimeout(t));
        voice.timers = [];
      }

      voice.stopped = true;

      if (voice.gain?.gain) {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + releaseOverride);
      }

      if (voice.source) {
        try {
          voice.source.stop(now + releaseOverride + 0.01);
        } catch {}
      }

      if (voice.sources && Array.isArray(voice.sources)) {
        for (const src of voice.sources) {
          try {
            src.stop(now + releaseOverride + 0.02);
          } catch {}
        }
      }

      if (voice.lfo) {
        try {
          voice.lfo.stop(now + releaseOverride + 0.1);
        } catch {}
      }
    }
  }

  for (const voice of this.sustainedVoices) {
    if (voice.timers) {
      voice.timers.forEach(t => clearTimeout(t));
      voice.timers = [];
    }

    voice.stopped = true;

    if (voice.gain?.gain) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + releaseOverride);
    }

    if (voice.source) {
      try {
        voice.source.stop(now + releaseOverride + 0.01);
      } catch {}
    }

    if (voice.sources && Array.isArray(voice.sources)) {
      for (const src of voice.sources) {
        try {
          src.stop(now + releaseOverride + 0.02);
        } catch {}
      }
    }

    if (voice.lfo) {
      try {
        voice.lfo.stop(now + releaseOverride + 0.1);
      } catch {}
    }
  }

  this.activeVoices = {};
  this.sustainedVoices = [];
}

}