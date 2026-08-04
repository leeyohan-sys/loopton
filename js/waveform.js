import { isMobileLike } from './background-playback.js';
import { getBufferCache, setPeaksCache } from './buffer-cache.js';

/**
 * 오디오 버퍼에서 피크를 추출해 캔버스에 파형을 그립니다.
 * A/B 마커 드래그 + 모바일 드로잉 스로틀
 */
export class WaveformView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.peaks = null;
    this.duration = 0;
    this.progress = 0;
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;
    this._onSeek = null;
    this._onMarks = null;
    this._dragMode = null;
    this._minGap = 0.05;
    this._isMobile = isMobileLike();
    this._rafDraw = 0;
    this._dirty = false;

    this._bindPointer();
    this._ro = new ResizeObserver(() => {
      this._peaksLayer = null;
      this.draw(true);
    });
    this._ro.observe(canvas);
  }

  onSeek(cb) {
    this._onSeek = cb;
  }

  onMarks(cb) {
    this._onMarks = cb;
  }

  setBuffer(audioBuffer, { cacheKey } = {}) {
    this.duration = audioBuffer.duration;
    this.progress = 0;
    this._peaksLayer = null;

    const bars = this._isMobile ? 480 : 1200;
    const cached = cacheKey ? getBufferCache(cacheKey) : null;

    if (cached?.peaks && cached.peaks.length) {
      this.peaks = cached.peaks;
    } else {
      this.peaks = this._extractPeaks(audioBuffer, bars);
      if (cacheKey) setPeaksCache(cacheKey, this.peaks);
    }

    this.draw(true);
  }

  setProgress(ratio) {
    this.progress = Math.max(0, Math.min(1, ratio));
    if (this._isMobile) {
      this._scheduleDraw();
    } else {
      this.draw(false);
    }
  }

  setMarks(a, b, enabled) {
    if (this._dragMode === 'A' || this._dragMode === 'B') return;
    this.markA = a;
    this.markB = b;
    this.abEnabled = enabled;
    this._peaksLayer = null;
    this.draw(true);
  }

  clear() {
    this.peaks = null;
    this.duration = 0;
    this.progress = 0;
    this.markA = null;
    this.markB = null;
    this._peaksLayer = null;
    this.draw(true);
  }

  _scheduleDraw() {
    this._dirty = true;
    if (this._rafDraw) return;
    this._rafDraw = requestAnimationFrame(() => {
      this._rafDraw = 0;
      if (!this._dirty) return;
      this._dirty = false;
      this.draw(false);
    });
  }

  _extractPeaks(buffer, bars) {
    const data = buffer.getChannelData(0);
    const block = Math.floor(data.length / bars) || 1;
    const peaks = new Float32Array(bars);
    // 블록 전체를 훑지 않고 step만큼 건너뛰어 추출 (시각적 차이는 미미)
    const step = this._isMobile ? Math.max(1, Math.floor(block / 24)) : Math.max(1, Math.floor(block / 48));

    for (let i = 0; i < bars; i++) {
      const start = i * block;
      const end = Math.min(start + block, data.length);
      let max = 0;
      for (let j = start; j < end; j += step) {
        const v = Math.abs(data[j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  _cssSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dprCap = this._isMobile ? 1.25 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._peaksLayer = null;
    }
    return { w, h, dpr, cssW: rect.width };
  }

  draw(forceFull = false) {
    const { w, h } = this._cssSize();
    const ctx = this.ctx;

    if (!this.peaks) {
      ctx.fillStyle = '#e8efe6';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(61, 83, 72, 0.35)';
      ctx.font = `${Math.floor(h * 0.12)}px Figtree, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('음원을 불러오면 파형이 표시됩니다', w / 2, h / 2);
      return;
    }

    // 파형 정적 레이어 캐시 — 재생 중엔 재생헤드만 다시 그림
    if (forceFull || !this._peaksLayer || this._peaksLayer.width !== w) {
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lctx = layer.getContext('2d');
      lctx.fillStyle = 'rgba(232, 239, 230, 1)';
      lctx.fillRect(0, 0, w, h);

      if (this.markA != null && this.markB != null && this.duration > 0) {
        const x1 = (this.markA / this.duration) * w;
        const x2 = (this.markB / this.duration) * w;
        lctx.fillStyle = this.abEnabled
          ? 'rgba(14, 116, 144, 0.22)'
          : 'rgba(14, 116, 144, 0.1)';
        lctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      }

      const mid = h / 2;
      const barW = w / this.peaks.length;
      const gap = Math.max(0.5, barW * 0.28);
      lctx.fillStyle = 'rgba(19, 36, 28, 0.18)';
      for (let i = 0; i < this.peaks.length; i++) {
        const bh = Math.max(2, this.peaks[i] * (h * 0.78));
        const x = i * barW + gap / 2;
        lctx.fillRect(x, mid - bh / 2, Math.max(1, barW - gap), bh);
      }

      this._drawMarkerOn(lctx, this.markA, '#0e7490', 'A', false, w, h);
      this._drawMarkerOn(lctx, this.markB, '#c2410c', 'B', false, w, h);
      this._peaksLayer = layer;
    }

    ctx.drawImage(this._peaksLayer, 0, 0);

    // 재생 진행 표시 — 모바일은 틴트만, 데스크톱은 막대 재색칠
    if (this._isMobile) {
      ctx.fillStyle = 'rgba(13, 92, 69, 0.28)';
      ctx.fillRect(0, 0, this.progress * w, h);
    } else {
      const mid = h / 2;
      const barW = w / this.peaks.length;
      const gap = Math.max(0.5, barW * 0.28);
      const playedUntil = Math.floor(this.progress * this.peaks.length);
      ctx.fillStyle = '#0d5c45';
      for (let i = 0; i < playedUntil; i++) {
        const bh = Math.max(2, this.peaks[i] * (h * 0.78));
        const x = i * barW + gap / 2;
        ctx.fillRect(x, mid - bh / 2, Math.max(1, barW - gap), bh);
      }
    }

    const px = this.progress * w;
    ctx.strokeStyle = '#084032';
    ctx.lineWidth = Math.max(2, w * 0.002);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    if (this._dragMode === 'A') this._drawMarkerOn(ctx, this.markA, '#0e7490', 'A', true, w, h);
    if (this._dragMode === 'B') this._drawMarkerOn(ctx, this.markB, '#c2410c', 'B', true, w, h);
  }

  _drawMarkerOn(ctx, time, color, label, active, w, h) {
    if (time == null || this.duration <= 0) return;
    const x = (time / this.duration) * w;

    if (active) {
      ctx.fillStyle = label === 'A' ? 'rgba(14,116,144,0.12)' : 'rgba(194,65,12,0.12)';
      ctx.fillRect(x - w * 0.01, 0, w * 0.02, h);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(active ? 3 : 2, w * (active ? 0.0035 : 0.0025));
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);

    const bw = Math.max(26, w * 0.022);
    const bh = Math.max(20, h * 0.14);
    const top = Math.max(6, h * 0.04);
    ctx.fillStyle = color;
    ctx.beginPath();
    roundRect(ctx, x - bw / 2, top, bw, bh, Math.max(3, bw * 0.12));
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x - bw * 0.28, top + bh);
    ctx.lineTo(x + bw * 0.28, top + bh);
    ctx.lineTo(x, top + bh + bh * 0.35);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.floor(bh * 0.65)}px Figtree, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, top + bh / 2);
  }

  _ratioFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  _hitMarker(e) {
    if (this.duration <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.clientX ?? e.touches?.[0]?.clientX;
    const x = clientX - rect.left;
    const threshold = Math.max(14, Math.min(28, rect.width * 0.035));

    const candidates = [];
    if (this.markA != null) {
      const ax = (this.markA / this.duration) * rect.width;
      const dist = Math.abs(x - ax);
      if (dist <= threshold) candidates.push({ which: 'A', dist });
    }
    if (this.markB != null) {
      const bx = (this.markB / this.duration) * rect.width;
      const dist = Math.abs(x - bx);
      if (dist <= threshold) candidates.push({ which: 'B', dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates[0]?.which ?? null;
  }

  _moveMark(which, ratio) {
    const time = ratio * this.duration;
    const gap = this._minGap;

    if (which === 'A') {
      const maxA = this.markB != null ? this.markB - gap : this.duration;
      this.markA = Math.max(0, Math.min(maxA, time));
    } else if (which === 'B') {
      const minB = this.markA != null ? this.markA + gap : 0;
      this.markB = Math.max(minB, Math.min(this.duration, time));
    }

    this._peaksLayer = null;
    this.draw(true);
    this._onMarks?.({ a: this.markA, b: this.markB });
  }

  _updateCursor(e) {
    if (!this.peaks || this._dragMode) return;
    const hit = this._hitMarker(e);
    this.canvas.style.cursor = hit ? 'ew-resize' : 'pointer';
  }

  _bindPointer() {
    const start = (e) => {
      if (!this.peaks || this.duration <= 0) return;

      const hit = this._hitMarker(e);
      this._dragMode = hit || 'seek';
      this.canvas.setPointerCapture?.(e.pointerId);

      const ratio = this._ratioFromEvent(e);
      if (hit) {
        this._moveMark(hit, ratio);
        this.canvas.style.cursor = 'ew-resize';
      } else {
        this._onSeek?.(ratio);
        this.canvas.style.cursor = 'pointer';
      }
      e.preventDefault();
    };

    const move = (e) => {
      if (!this._dragMode) {
        this._updateCursor(e);
        return;
      }

      const ratio = this._ratioFromEvent(e);
      if (this._dragMode === 'A' || this._dragMode === 'B') {
        this._moveMark(this._dragMode, ratio);
      } else if (this._dragMode === 'seek') {
        this._onSeek?.(ratio);
      }
      e.preventDefault();
    };

    const end = (e) => {
      if (!this._dragMode) return;
      const wasMark = this._dragMode === 'A' || this._dragMode === 'B';
      this._dragMode = null;
      try {
        this.canvas.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      this._peaksLayer = null;
      this.draw(true);
      if (wasMark) {
        this._onMarks?.({ a: this.markA, b: this.markB });
      }
      this._updateCursor(e);
    };

    this.canvas.addEventListener('pointerdown', start);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this._dragMode) this.canvas.style.cursor = 'pointer';
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
