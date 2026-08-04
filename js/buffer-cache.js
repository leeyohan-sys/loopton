import { isMobileLike } from './background-playback.js';

/**
 * 디코딩된 AudioBuffer + 파형 피크 메모리 캐시 (LRU)
 * — 같은 곡 재선택 시 decode / 피크 추출 생략
 */
const MAX_ENTRIES = isMobileLike() ? 3 : 6;

/** @type {Map<string, { buffer: AudioBuffer, peaks?: Float32Array, name: string }>} */
const cache = new Map();

function touch(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function getBufferCache(key) {
  if (!key || !cache.has(key)) return null;
  const value = cache.get(key);
  touch(key, value);
  return value;
}

export function setBufferCache(key, partial) {
  if (!key || !partial?.buffer) return;
  const prev = cache.get(key) || {};
  touch(key, {
    buffer: partial.buffer,
    peaks: partial.peaks ?? prev.peaks,
    name: partial.name ?? prev.name ?? '',
  });
}

export function setPeaksCache(key, peaks) {
  if (!key || !peaks || !cache.has(key)) return;
  const prev = cache.get(key);
  touch(key, { ...prev, peaks });
}

export function clearBufferCache() {
  cache.clear();
}
