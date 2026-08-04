import { PitchShifter } from 'soundtouchjs';
import { backgroundPlayback } from './background-playback.js';

/**
 * SoundTouch 기반 오디오 엔진
 * — 속도(템포)·피치 독립 제어, 전체/구간 반복, 모바일 백그라운드 재생 보조
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.shifter = null;
    this.buffer = null;
    this.fileName = '';
    this.playing = false;

    this.tempo = 1;
    this.pitchSemitones = 0;
    this.linkRate = false;
    this.volume = 0.8;

    this.loopFull = false;
    this.abEnabled = false;
    this.markA = null;
    this.markB = null;

    this._onProgress = null;
    this._onState = null;
    this._onEnded = null;
    this._seeking = false;
    this._bgReady = false;
  }

  onProgress(cb) {
    this._onProgress = cb;
  }

  onState(cb) {
    this._onState = cb;
  }

  /** 트랙이 자연 종료되었을 때 (루프가 아닐 때) */
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

  async _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;

      // 모바일: MediaStream → HTMLAudio 로 내보내 잠금화면에서도 미디어로 인식
      const streamDest = backgroundPlayback.ensureStreamOutput(this.ctx);
      if (streamDest) {
        // 모바일은 HTMLAudio(MediaStream)로만 출력 — 잠금화면 미디어 세션 유지
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
      this._bgReady = true;
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    backgroundPlayback.claimAudioSession();
  }

  /** PitchShifter는 context.sampleRate로 시간을 계산해 버퍼와 어긋날 수 있음 → 보정 */
  _timeFromShifter() {
    if (!this.shifter || !this.buffer) return 0;
    const pos = this.shifter._filter?.sourcePosition ?? this.shifter.sourcePosition;
    return pos / this.buffer.sampleRate;
  }

  /** 초 단위 위치로 시크 (버퍼 샘플레이트 기준) */
  _setPositionSeconds(timeSec) {
    if (!this.shifter || !this.buffer) return;
    const clamped = Math.max(0, Math.min(this.buffer.duration, timeSec));
    const pos = Math.floor(clamped * this.buffer.sampleRate);
    // PitchShifter 내부 필터 위치를 직접 맞춤 (context/buffer 샘플레이트 불일치 대비)
    this.shifter._filter.sourcePosition = pos;
    this.shifter.sourcePosition = pos;
    this.shifter.timePlayed = clamped;
  }

  async loadFile(file) {
    await this._ensureContext();
    this.stop(true);

    const arrayBuf = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuf.slice(0));

    this.buffer = audioBuffer;
    this.fileName = file.name;
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;

    this._createShifter(0);
    this._emitState();
    this._notifyProgress(0);

    return {
      buffer: audioBuffer,
      name: file.name,
      duration: audioBuffer.duration,
    };
  }

  _createShifter(startSec = 0) {
    if (this.shifter) {
      try {
        this.shifter.disconnect();
        this.shifter.off();
      } catch {
        /* ignore */
      }
      this.shifter = null;
    }

    this.shifter = new PitchShifter(this.ctx, this.buffer, 4096, () => {
      this._handleEnded();
    });

    this._applyParams();
    this._setPositionSeconds(startSec);

    this.shifter.on('play', () => {
      if (this._seeking || !this.playing) return;

      const time = this._timeFromShifter();

      // A–B 반복: 구간 밖(A 이전·B 이후)이면 A로 복귀
      if (this._clampToAbLoop(time)) return;

      this._notifyProgress(time);
      backgroundPlayback.updatePosition({
        duration: this.buffer?.duration ?? 0,
        position: time,
        playbackRate: this.linkRate ? this.tempo : 1,
      });
    });
  }

  /**
   * A–B 반복 중 위치가 구간 밖이면 A로 이동.
   * @returns {boolean} 클램프(점프)가 발생했으면 true
   */
  _clampToAbLoop(timeSec) {
    if (!this.abEnabled || this.markA == null || this.markB == null) return false;
    if (timeSec < this.markA || timeSec >= this.markB - 0.02) {
      this.seek(this.markA, true);
      return true;
    }
    return false;
  }

  _applyParams() {
    if (!this.shifter) return;

    if (this.linkRate) {
      // 레이트 모드: 속도와 피치가 함께 변함
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

  _handleEnded() {
    if (!this.playing) return;

    if (this.abEnabled && this.markA != null && this.markB != null) {
      this.seek(this.markA, true);
      return;
    }

    if (this.loopFull) {
      this.seek(0, true);
      return;
    }

    this.playing = false;
    try {
      this.shifter?.disconnect();
    } catch {
      /* ignore */
    }
    backgroundPlayback.stop();
    this._setPositionSeconds(0);
    this._notifyProgress(0);
    this._emitState();
    this._onEnded?.();
  }

  async play() {
    if (!this.buffer) return;
    await this._ensureContext();

    if (!this.shifter) {
      this._createShifter(0);
    }

    const time = this._timeFromShifter();

    // 끝에서 재생 시 처음으로
    if (time >= this.buffer.duration - 0.05) {
      const start =
        this.abEnabled && this.markA != null ? this.markA : 0;
      this._setPositionSeconds(start);
    }

    // A–B 활성인데 구간 밖이면 A로 이동
    if (this.abEnabled && this.markA != null && this.markB != null) {
      const t = this._timeFromShifter();
      if (t < this.markA || t >= this.markB) {
        this._setPositionSeconds(this.markA);
      }
    }

    backgroundPlayback.updateMetadata({ title: this.fileName || 'LoopTone' });
    await backgroundPlayback.start();

    this.shifter.connect(this.gain);
    this.playing = true;
    this._emitState();
  }

  pause() {
    if (!this.shifter || !this.playing) return;
    this.shifter.disconnect();
    this.playing = false;
    backgroundPlayback.stop();
    this._emitState();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop(silent = false) {
    if (this.shifter) {
      try {
        this.shifter.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.playing = false;
    backgroundPlayback.stop();
    if (this.shifter && this.buffer) {
      this._setPositionSeconds(0);
      this._notifyProgress(0);
    }
    if (!silent) this._emitState();
  }

  /**
   * @param {number} timeSec
   * @param {boolean} resumeIfPlaying 탐색 후 재생 유지
   */
  seek(timeSec, resumeIfPlaying = this.playing) {
    if (!this.buffer || !this.shifter) return;

    let target = Math.max(0, Math.min(this.buffer.duration, timeSec));

    // A–B 반복 중에는 플레이 바가 구간 밖으로 못 나가게 A로 스냅
    if (this.abEnabled && this.markA != null && this.markB != null) {
      if (target < this.markA || target >= this.markB) {
        target = this.markA;
      }
    }

    const keepPlaying = resumeIfPlaying && this.playing;

    this._seeking = true;
    if (this.playing) {
      this.shifter.disconnect();
      this.playing = false;
    }

    this._setPositionSeconds(target);
    this._notifyProgress(target);
    this._seeking = false;

    if (keepPlaying) {
      this.shifter.connect(this.gain);
      this.playing = true;
      backgroundPlayback.start();
      this._emitState();
    } else {
      this._emitState();
    }
  }

  skip(deltaSec) {
    this.seek(this._timeFromShifter() + deltaSec);
  }

  setTempo(tempo) {
    this.tempo = Math.max(0.25, Math.min(2, tempo));
    this._applyParams();
  }

  setPitchSemitones(st) {
    this.pitchSemitones = Math.max(-12, Math.min(12, st));
    this._applyParams();
  }

  setLinkRate(linked) {
    this.linkRate = linked;
    this._applyParams();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setLoopFull(on) {
    this.loopFull = on;
    this._emitState();
  }

  setMarkA(timeSec = this._timeFromShifter()) {
    this.markA = Math.max(0, timeSec);
    if (this.markB != null && this.markA >= this.markB) {
      this.markB = null;
      this.abEnabled = false;
    }
    this._emitState();
  }

  setMarkB(timeSec = this._timeFromShifter()) {
    const t = Math.max(0, timeSec);
    if (this.markA != null && t <= this.markA) {
      this.markB = this.markA;
      this.markA = t;
    } else {
      this.markB = t;
    }
    this._emitState();
  }

  /** 파형 드래그로 A/B를 동시에 갱신 */
  setAbMarks(a, b) {
    this.markA = a;
    this.markB = b;
    if (this.markA != null && this.markB != null && this.markA >= this.markB) {
      const mid = (this.markA + this.markB) / 2;
      this.markA = Math.min(this.markA, mid - 0.025);
      this.markB = Math.max(this.markB, mid + 0.025);
    }
    if (this.abEnabled && (this.markA == null || this.markB == null)) {
      this.abEnabled = false;
    }
    this._emitState();
  }

  setAbEnabled(on) {
    if (on && (this.markA == null || this.markB == null)) return;
    this.abEnabled = on;
    if (on) {
      this.loopFull = false;
      // 켜는 순간 구간 밖이면 A로 이동
      const t = this._timeFromShifter();
      if (t < this.markA || t >= this.markB) {
        this.seek(this.markA, this.playing);
        return;
      }
    }
    this._emitState();
  }

  clearAb() {
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;
    this._emitState();
  }

  get currentTime() {
    return this._timeFromShifter();
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
