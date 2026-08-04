/**
 * 오디오 버퍼에서 피크를 추출해 캔버스에 파형을 그립니다.
 * A/B 마커 드래그로 구간 지정 지원
 */
export class WaveformView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaks = null;
    this.duration = 0;
    this.progress = 0; // 0~1
    this.markA = null;
    this.markB = null;
    this.abEnabled = false;
    this._onSeek = null;
    this._onMarks = null;
    this._dragMode = null; // 'seek' | 'A' | 'B'
    this._minGap = 0.05; // 초 — A/B 최소 간격

    this._bindPointer();
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  onSeek(cb) {
    this._onSeek = cb;
  }

  /** A/B 위치가 바뀔 때 호출 (드래그) */
  onMarks(cb) {
    this._onMarks = cb;
  }

  setBuffer(audioBuffer) {
    this.duration = audioBuffer.duration;
    this.peaks = this._extractPeaks(audioBuffer, 1200);
    this.progress = 0;
    this.draw();
  }

  setProgress(ratio) {
    this.progress = Math.max(0, Math.min(1, ratio));
    // 마커 드래그 중에는 재생헤드만 갱신해도 됨
    this.draw();
  }

  setMarks(a, b, enabled) {
    // 드래그 중에는 엔진→UI 역동기화로 손맛이 깨지지 않게 스킵
    if (this._dragMode === 'A' || this._dragMode === 'B') return;
    this.markA = a;
    this.markB = b;
    this.abEnabled = enabled;
    this.draw();
  }

  clear() {
    this.peaks = null;
    this.duration = 0;
    this.progress = 0;
    this.markA = null;
    this.markB = null;
    this.draw();
  }

  _extractPeaks(buffer, bars) {
    const data = buffer.getChannelData(0);
    const block = Math.floor(data.length / bars) || 1;
    const peaks = new Float32Array(bars);

    for (let i = 0; i < bars; i++) {
      const start = i * block;
      let max = 0;
      for (let j = 0; j < block; j++) {
        const v = Math.abs(data[start + j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  _cssSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h, dpr, cssW: rect.width };
  }

  draw() {
    const { w, h } = this._cssSize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(19, 36, 28, 0.03)';
    ctx.fillRect(0, 0, w, h);

    if (!this.peaks) {
      ctx.fillStyle = 'rgba(61, 83, 72, 0.35)';
      ctx.font = `${Math.floor(h * 0.12)}px Figtree, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('음원을 불러오면 파형이 표시됩니다', w / 2, h / 2);
      return;
    }

    const mid = h / 2;
    const barW = w / this.peaks.length;
    const gap = Math.max(0.5, barW * 0.28);

    // A–B 구간 하이라이트
    if (this.markA != null && this.markB != null && this.duration > 0) {
      const x1 = (this.markA / this.duration) * w;
      const x2 = (this.markB / this.duration) * w;
      ctx.fillStyle = this.abEnabled
        ? 'rgba(14, 116, 144, 0.22)'
        : 'rgba(14, 116, 144, 0.1)';
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    }

    // 파형 막대
    for (let i = 0; i < this.peaks.length; i++) {
      const amp = this.peaks[i];
      const bh = Math.max(2, amp * (h * 0.78));
      const x = i * barW + gap / 2;
      const played = i / this.peaks.length <= this.progress;

      ctx.fillStyle = played ? '#0d5c45' : 'rgba(19, 36, 28, 0.18)';
      ctx.fillRect(x, mid - bh / 2, Math.max(1, barW - gap), bh);
    }

    // 재생 헤드
    const px = this.progress * w;
    ctx.strokeStyle = '#084032';
    ctx.lineWidth = Math.max(2, w * 0.002);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    // A / B 마커 (드래그 가능)
    this._drawMarker(this.markA, '#0e7490', 'A', this._dragMode === 'A');
    this._drawMarker(this.markB, '#c2410c', 'B', this._dragMode === 'B');
  }

  _drawMarker(time, color, label, active) {
    if (time == null || this.duration <= 0) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const x = (time / this.duration) * w;
    const ctx = this.ctx;

    // 넓은 히트 영역을 드래그 중 시각적으로 강조
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

    // 드래그 핸들(뱃지)
    const bw = Math.max(26, w * 0.022);
    const bh = Math.max(20, h * 0.14);
    const top = Math.max(6, h * 0.04);
    ctx.fillStyle = color;
    ctx.beginPath();
    const r = Math.max(3, bw * 0.12);
    roundRect(ctx, x - bw / 2, top, bw, bh, r);
    ctx.fill();

    // 하단 작은 삼각형(손잡이 느낌)
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

  /** CSS 픽셀 기준으로 A/B 히트 테스트 */
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

    this.draw();
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
      this.draw();
      if (wasMark) {
        this._onMarks?.({ a: this.markA, b: this.markB });
      }
      this._updateCursor(e);
    };

    this.canvas.addEventListener('pointerdown', start);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', (e) => {
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
