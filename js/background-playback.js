/**
 * 모바일 화면 꺼짐/백그라운드에서도 재생이 이어지도록 보조
 * — HTMLAudio keep-alive, Media Session, audioSession
 */

/** 수 초짜리 무음 WAV (iOS가 volume=0 트랙을 무시하는 경우 대비해 아주 작은 진폭) */
function createKeepAliveUri(seconds = 3, sampleRate = 22050) {
  const n = Math.floor(sampleRate * seconds);
  const dataSize = n * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // 거의 들리지 않는 저진폭 노이즈 (완전 무음보다 백그라운드 유지에 유리)
  for (let i = 0; i < n; i++) {
    const sample = (i % 64 === 0 ? 1 : 0);
    view.setInt16(44 + i * 2, sample, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function isMobileLike() {
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export class BackgroundPlayback {
  constructor() {
    this.keepAlive = null;
    this.outEl = null;
    this.streamDest = null;
    this._keepUri = null;
    this._handlersBound = false;
    this._onPlay = null;
    this._onPause = null;
    this._onNext = null;
    this._onPrev = null;
    this._watchdog = null;
  }

  /** Media Session / 잠금화면 버튼 콜백 */
  setHandlers({ play, pause, next, prev } = {}) {
    this._onPlay = play;
    this._onPause = pause;
    this._onNext = next;
    this._onPrev = prev;
    this._bindMediaSession();
  }

  _ensureKeepAlive() {
    if (this.keepAlive) return;
    this._keepUri = createKeepAliveUri();
    const el = new Audio();
    el.src = this._keepUri;
    el.loop = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.playsInline = true;
    // 완전 0은 iOS가 무시할 수 있음
    el.volume = 0.001;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.keepAlive = el;
  }

  /**
   * Web Audio 출력을 HTMLAudioElement로 라우팅 (모바일 백그라운드용)
   * @returns {MediaStreamAudioDestinationNode|null}
   */
  ensureStreamOutput(audioCtx) {
    if (!isMobileLike()) return null;

    if (!this.streamDest) {
      this.streamDest = audioCtx.createMediaStreamDestination();
      const el = new Audio();
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.playsInline = true;
      el.autoplay = false;
      el.srcObject = this.streamDest.stream;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.outEl = el;
    }
    return this.streamDest;
  }

  /** OS에 미디어 재생 세션임을 알림 (Safari) */
  claimAudioSession() {
    try {
      if ('audioSession' in navigator) {
        navigator.audioSession.type = 'playback';
      }
    } catch {
      /* ignore */
    }
  }

  _bindMediaSession() {
    if (!('mediaSession' in navigator) || this._handlersBound) return;
    this._handlersBound = true;

    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => this._onPlay?.());
      ms.setActionHandler('pause', () => this._onPause?.());
      ms.setActionHandler('stop', () => this._onPause?.());
      ms.setActionHandler('seekbackward', (d) => {
        const sec = d.seekOffset || 5;
        this._onPause && this._seekRelative?.(-sec);
      });
      ms.setActionHandler('seekforward', (d) => {
        const sec = d.seekOffset || 5;
        this._seekRelative?.(sec);
      });
      ms.setActionHandler('previoustrack', () => this._onPrev?.());
      ms.setActionHandler('nexttrack', () => this._onNext?.());
    } catch {
      /* 일부 핸들러 미지원 */
    }
  }

  setSeekRelative(fn) {
    this._seekRelative = fn;
  }

  updateMetadata({ title, artist = 'LoopTone', album = 'LoopTone' } = {}) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'LoopTone',
        artist,
        album,
      });
    } catch {
      /* ignore */
    }
  }

  updatePosition({ duration = 0, position = 0, playbackRate = 1 } = {}) {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      if (duration > 0) {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.min(position, duration),
          playbackRate: playbackRate || 1,
        });
      }
    } catch {
      /* ignore */
    }
  }

  async start() {
    this.claimAudioSession();
    this._ensureKeepAlive();
    this._bindMediaSession();

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    const plays = [];
    if (this.keepAlive) {
      plays.push(this.keepAlive.play().catch(() => {}));
    }
    if (this.outEl) {
      plays.push(this.outEl.play().catch(() => {}));
    }
    await Promise.all(plays);

    this._startWatchdog();
  }

  stop() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    try {
      this.keepAlive?.pause();
    } catch {
      /* ignore */
    }
    try {
      this.outEl?.pause();
    } catch {
      /* ignore */
    }
    this._stopWatchdog();
  }

  /** 백그라운드에서 AudioContext가 suspend되면 주기적으로 깨움 */
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = window.setInterval(() => {
      this._onWatchdog?.();
      if (this.keepAlive?.paused) {
        this.keepAlive.play().catch(() => {});
      }
      if (this.outEl?.paused) {
        this.outEl.play().catch(() => {});
      }
    }, 2000);
  }

  _stopWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  onWatchdog(cb) {
    this._onWatchdog = cb;
  }

  bindVisibility(resumeCb) {
    if (this._visBound) return;
    this._visBound = true;

    const kick = () => {
      this.claimAudioSession();
      resumeCb?.();
      if (this.keepAlive && !this.keepAlive.paused) {
        this.keepAlive.play().catch(() => {});
      }
      if (this.outEl && !this.outEl.paused) {
        this.outEl.play().catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', () => {
      // 화면이 다시 켜질 때뿐 아니라, 숨은 직후에도 세션 유지 시도
      kick();
    });
    window.addEventListener('pageshow', kick);
    window.addEventListener('focus', kick);
  }
}

export const backgroundPlayback = new BackgroundPlayback();
