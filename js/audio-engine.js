import { PitchShifter } from 'soundtouchjs';
import { backgroundPlayback, isMobileLike } from './background-playback.js';
import { getBufferCache, setBufferCache } from './buffer-cache.js';

/**
 * SoundTouch 기반 오디오 엔진
 * — 기본(속도 100%·피치 0)은 경량 BufferSource,
 *   속도/피치 변경 시에만 SoundTouch 사용 (모바일 성능)
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.shifter = null;
    this.source = null; // 경량 경로 AudioBufferSourceNode
    this.buffer = null;
    this.fileName = '';
    this.playing = false;
    this.mode = 'lite'; // 'lite' | 'stretch'

    this.tempo = 1;
    this.pitchSemitones = 0;
    this.linkRate = false;
    this.volume = 0.8;

    this.loopFull = true; // 기본: 선택한 곡 반복
    this.abEnabled = false;
    this.markA = null;
    this.markB = null;

    this._pausedAt = 0;
    this._liteStartedAt = 0; // ctx.currentTime when source started
    this._liteOffset = 0; // buffer offset at start
    this._raf = 0;
    this._lastProgressAt = 0;
    this._lastMediaPosAt = 0;
    this._onProgress = null;
    this._onState = null;
    this._onEnded = null;
    this._seeking = false;
    this._ignoreSourceEnd = false;

    this._isMobile = isMobileLike();
    // 모바일: ScriptProcessor 호출 빈도↓ (지연↑, CPU↓)
    this._stretchBufferSize = this._isMobile ? 8192 : 4096;
    this._progressInterval = this._isMobile ? 100 : 50; // ms
  }

  onProgress(cb) {
    this._onProgress = cb;
  }

  onState(cb) {
    this._onState = cb;
  }

  onEnded(cb) {
    this._onEnded = cb;
  }

  _emitState() {
    this._onState?.({
      playing: this.playing,
      hasBuffer: !!this.buffer,
      duration: this.buffer?.duration ?? 0,
      fileName: this.fileName,
      loopFull: this.loopFull,
      abEnabled: this.abEnabled,
      markA: this.markA,
      markB: this.markB,
    });
  }

  /** 속도/피치가 기본이면 SoundTouch 없이 재생 가능 */
  _needsStretch() {
    if (this.linkRate) return Math.abs(this.tempo - 1) > 0.002;
    return Math.abs(this.tempo - 1) > 0.002 || Math.abs(this.pitchSemitones) > 0.01;
  }

  async _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: this._isMobile ? 'playback' : 'interactive',
      });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;

      const streamDest = backgroundPlayback.ensureStreamOutput(this.ctx);
      if (streamDest) {
        this.gain.connect(streamDest);
      } else {
        this.gain.connect(this.ctx.destination);
      }

      backgroundPlayback.bindVisibility(() => {
        if (this.playing && this.ctx?.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      });
      backgroundPlayback.onWatchdog(() => {
        if (this.playing && this.ctx?.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      });
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    backgroundPlayback.claimAudioSession();
  }

  _currentTime() {
    if (!this.buffer) return 0;

    if (this.mode === 'lite') {
      if (this.playing && this.source) {
        const rate = this.linkRate ? this.tempo : 1;
        const elapsed = (this.ctx.currentTime - this._liteStartedAt) * rate;
        return Math.min(this.buffer.duration, this._liteOffset + elapsed);
      }
      return this._pausedAt;
    }

    if (!this.shifter) return this._pausedAt;
    const pos = this.shifter._filter?.sourcePosition ?? this.shifter.sourcePosition;
    return pos / this.buffer.sampleRate;
  }

  _setPausedAt(timeSec) {
    const clamped = Math.max(0, Math.min(this.buffer?.duration ?? 0, timeSec));
    this._pausedAt = clamped;
    if (this.shifter && this.buffer) {
      const pos = Math.floor(clamped * this.buffer.sampleRate);
      this.shifter._filter.sourcePosition = pos;
      this.shifter.sourcePosition = pos;
      this.shifter.timePlayed = clamped;
    }
  }

  async loadFile(file, { cacheKey } = {}) {
    await this._ensureContext();
    this.stop(true);

    const key = cacheKey || `${file.name}::${file.size}`;
    let audioBuffer;
    const cached = getBufferCache(key);

    if (cached?.buffer) {
      // 이미 디코딩된 버퍼 재사용
      audioBuffer = cached.buffer;
    } else {
      const arrayBuf = await file.arrayBuffer();
      audioBuffer = await this.ctx.decodeAudioData(arrayBuf.slice(0));
      setBufferCache(key, { buffer: audioBuffer, name: file.name });
    }

    this.buffer = audioBuffer;
    this.fileName = file.name;
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;
    this._pausedAt = 0;
    this.mode = this._needsStretch() ? 'stretch' : 'lite';

    if (this.mode === 'stretch') {
      this._createShifter(0);
    } else {
      this._disposeShifter();
    }

    this._emitState();
    this._notifyProgress(0);

    return {
      buffer: audioBuffer,
      name: file.name,
      duration: audioBuffer.duration,
      cacheKey: key,
      fromCache: !!cached?.buffer,
    };
  }

  _disposeShifter() {
    if (this.shifter) {
      try {
        this.shifter.disconnect();
        this.shifter.off();
      } catch {
        /* ignore */
      }
      this.shifter = null;
    }
  }

  _disposeSource() {
    this._ignoreSourceEnd = true;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* ignore */
      }
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    this._ignoreSourceEnd = false;
  }

  _createShifter(startSec = 0) {
    this._disposeShifter();
    this.mode = 'stretch';

    this.shifter = new PitchShifter(this.ctx, this.buffer, this._stretchBufferSize, () => {
      this._handleEnded();
    });

    this._applyStretchParams();
    this._setPausedAt(startSec);

    let eventCount = 0;
    this.shifter.on('play', () => {
      if (this._seeking || !this.playing) return;
      // 모바일: 매 콜백마다 UI 갱신하지 않음
      eventCount += 1;
      if (this._isMobile && eventCount % 2 !== 0) return;

      const time = this._currentTime();
      if (this._clampToAbLoop(time)) return;
      this._throttledProgress(time);
    });
  }

  _applyStretchParams() {
    if (!this.shifter) return;
    if (this.linkRate) {
      this.shifter.tempo = 1;
      this.shifter.pitch = 1;
      this.shifter.pitchSemitones = 0;
      this.shifter.rate = this.tempo;
    } else {
      this.shifter.rate = 1;
      this.shifter.tempo = this.tempo;
      this.shifter.pitch = 1;
      this.shifter.pitchSemitones = this.pitchSemitones;
    }
  }

  /** 파라미터 변경 시 lite ↔ stretch 전환 */
  _syncPlaybackMode() {
    const wantStretch = this._needsStretch();
    const wasPlaying = this.playing;
    const t = this._currentTime();

    if (wantStretch && this.mode !== 'stretch') {
      if (wasPlaying) this._pauseInternal();
      this._disposeSource();
      this._createShifter(t);
      this._pausedAt = t;
      if (wasPlaying) this.play();
      return;
    }

    if (!wantStretch && this.mode !== 'lite') {
      if (wasPlaying) this._pauseInternal();
      this._disposeShifter();
      this.mode = 'lite';
      this._pausedAt = t;
      if (wasPlaying) this.play();
      return;
    }

    if (this.mode === 'stretch') {
      this._applyStretchParams();
    } else if (this.mode === 'lite' && this.source && this.playing && this.linkRate) {
      // 레이트만 미세 조정 시 — 재시작으로 반영
      this._pauseInternal();
      this._pausedAt = t;
      this.play();
    }
  }

  _clampToAbLoop(timeSec) {
    if (!this.abEnabled || this.markA == null || this.markB == null) return false;
    if (timeSec < this.markA || timeSec >= this.markB - 0.02) {
      this.seek(this.markA, true);
      return true;
    }
    return false;
  }

  _throttledProgress(time) {
    const now = performance.now();
    if (now - this._lastProgressAt < this._progressInterval) return;
    this._lastProgressAt = now;
    this._notifyProgress(time);

    if (now - this._lastMediaPosAt > 1000) {
      this._lastMediaPosAt = now;
      backgroundPlayback.updatePosition({
        duration: this.buffer?.duration ?? 0,
        position: time,
        playbackRate: this.linkRate ? this.tempo : this.mode === 'lite' ? 1 : 1,
      });
    }
  }

  _startLiteRaf() {
    this._stopLiteRaf();
    const tick = () => {
      if (!this.playing || this.mode !== 'lite') return;
      const time = this._currentTime();
      if (this._clampToAbLoop(time)) return;
      if (time >= this.buffer.duration - 0.02) {
        this._handleEnded();
        return;
      }
      this._throttledProgress(time);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopLiteRaf() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _handleEnded() {
    if (!this.playing || this._ignoreSourceEnd) return;

    if (this.abEnabled && this.markA != null && this.markB != null) {
      this.seek(this.markA, true);
      return;
    }

    if (this.loopFull) {
      this.seek(0, true);
      return;
    }

    this._pauseInternal();
    backgroundPlayback.stop();
    this._setPausedAt(0);
    this._notifyProgress(0);
    this._emitState();
    this._onEnded?.();
  }

  _pauseInternal() {
    this._pausedAt = this._currentTime();
    this.playing = false;
    this._stopLiteRaf();

    if (this.mode === 'lite') {
      this._disposeSource();
    } else if (this.shifter) {
      try {
        this.shifter.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async play() {
    if (!this.buffer) return;
    await this._ensureContext();

    let time = this._currentTime();

    if (time >= this.buffer.duration - 0.05) {
      time = this.abEnabled && this.markA != null ? this.markA : 0;
      this._setPausedAt(time);
    }

    if (this.abEnabled && this.markA != null && this.markB != null) {
      if (time < this.markA || time >= this.markB) {
        time = this.markA;
        this._setPausedAt(time);
      }
    }

    this.mode = this._needsStretch() ? 'stretch' : 'lite';

    backgroundPlayback.updateMetadata({ title: this.fileName || 'LoopTone' });
    await backgroundPlayback.start();

    if (this.mode === 'lite') {
      this._disposeSource();
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      const rate = this.linkRate ? this.tempo : 1;
      src.playbackRate.value = rate;
      src.connect(this.gain);
      src.onended = () => this._handleEnded();
      this._liteOffset = this._pausedAt;
      this._liteStartedAt = this.ctx.currentTime;
      src.start(0, this._pausedAt);
      this.source = src;
      this.playing = true;
      this._startLiteRaf();
    } else {
      if (!this.shifter) this._createShifter(this._pausedAt);
      else this._setPausedAt(this._pausedAt);
      this.shifter.connect(this.gain);
      this.playing = true;
    }

    this._emitState();
  }

  pause() {
    if (!this.playing) return;
    this._pauseInternal();
    backgroundPlayback.stop();
    this._notifyProgress(this._pausedAt);
    this._emitState();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop(silent = false) {
    const had = this.playing || this.source || this.shifter;
    if (this.playing) this._pauseInternal();
    else {
      this._disposeSource();
      if (this.shifter) {
        try {
          this.shifter.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    backgroundPlayback.stop();
    this._setPausedAt(0);
    if (had || this.buffer) this._notifyProgress(0);
    if (!silent) this._emitState();
  }

  seek(timeSec, resumeIfPlaying = this.playing) {
    if (!this.buffer) return;

    let target = Math.max(0, Math.min(this.buffer.duration, timeSec));

    if (this.abEnabled && this.markA != null && this.markB != null) {
      if (target < this.markA || target >= this.markB) {
        target = this.markA;
      }
    }

    const keepPlaying = resumeIfPlaying && this.playing;

    this._seeking = true;
    if (this.playing) this._pauseInternal();

    this._setPausedAt(target);
    this._notifyProgress(target);
    this._seeking = false;

    if (keepPlaying) {
      this.play();
    } else {
      this._emitState();
    }
  }

  skip(deltaSec) {
    this.seek(this._currentTime() + deltaSec);
  }

  setTempo(tempo) {
    this.tempo = Math.max(0.25, Math.min(2, tempo));
    this._syncPlaybackMode();
  }

  setPitchSemitones(st) {
    this.pitchSemitones = Math.max(-12, Math.min(12, st));
    this._syncPlaybackMode();
  }

  setLinkRate(linked) {
    this.linkRate = linked;
    this._syncPlaybackMode();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setLoopFull(on) {
    this.loopFull = on;
    this._emitState();
  }

  setMarkA(timeSec = this._currentTime()) {
    const wasReady = this.markA != null && this.markB != null;
    this.markA = Math.max(0, timeSec);
    if (this.markB != null && this.markA >= this.markB) {
      this.markB = null;
      this.abEnabled = false;
    }
    const nowReady = this.markA != null && this.markB != null;
    if (nowReady && !wasReady) {
      this.setAbEnabled(true);
    } else {
      this._emitState();
    }
  }

  setMarkB(timeSec = this._currentTime()) {
    const wasReady = this.markA != null && this.markB != null;
    const t = Math.max(0, timeSec);
    if (this.markA != null && t <= this.markA) {
      this.markB = this.markA;
      this.markA = t;
    } else {
      this.markB = t;
    }
    const nowReady = this.markA != null && this.markB != null;
    if (nowReady && !wasReady) {
      this.setAbEnabled(true);
    } else {
      this._emitState();
    }
  }

  setAbMarks(a, b) {
    const wasReady = this.markA != null && this.markB != null;
    this.markA = a;
    this.markB = b;
    if (this.markA != null && this.markB != null && this.markA >= this.markB) {
      const mid = (this.markA + this.markB) / 2;
      this.markA = Math.min(this.markA, mid - 0.025);
      this.markB = Math.max(this.markB, mid + 0.025);
    }
    const nowReady = this.markA != null && this.markB != null;
    if (this.abEnabled && !nowReady) {
      this.abEnabled = false;
    }
    if (nowReady && !wasReady) {
      this.setAbEnabled(true);
    } else {
      this._emitState();
    }
  }

  setAbEnabled(on) {
    if (on && (this.markA == null || this.markB == null)) return;
    this.abEnabled = on;
    if (on) {
      this.loopFull = false;
      const t = this._currentTime();
      if (t < this.markA || t >= this.markB) {
        this.seek(this.markA, this.playing);
        return;
      }
    } else if (!this.loopFull) {
      // A–B 끄면 기본인 한 곡 반복으로 복귀
      this.loopFull = true;
    }
    this._emitState();
  }

  clearAb() {
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;
    if (!this.loopFull) this.loopFull = true;
    this._emitState();
  }

  get currentTime() {
    return this._currentTime();
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  _notifyProgress(time) {
    const duration = this.buffer?.duration ?? 1;
    const percent = duration > 0 ? (time / duration) * 100 : 0;
    this._onProgress?.({
      time,
      percent,
      formatted: formatTime(time),
    });
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
