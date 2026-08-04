import { AudioEngine, formatTime } from './audio-engine.js';
import { WaveformView } from './waveform.js';
import { backgroundPlayback } from './background-playback.js';
import {
  listRecent,
  saveRecent,
  getRecent,
  removeRecent,
  trackIdFromFile,
  listPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistTracks,
  addFileToPlaylist,
  addTrackIdToPlaylist,
  removeTrackFromPlaylist,
  trackToFile,
  getActivePlaylistId,
  setActivePlaylistId,
  getTrack,
} from './recent-store.js';

const engine = new AudioEngine();
const wave = new WaveformView(document.getElementById('waveform'));

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  dropIdle: $('dropIdle'),
  trackMeta: $('trackMeta'),
  trackName: $('trackName'),
  trackInfo: $('trackInfo'),
  changeFileBtn: $('changeFileBtn'),
  playlistSelect: $('playlistSelect'),
  playlistNewBtn: $('playlistNewBtn'),
  playlistRenameBtn: $('playlistRenameBtn'),
  playlistDeleteBtn: $('playlistDeleteBtn'),
  playlistPanel: $('playlistPanel'),
  playlistAddFilesBtn: $('playlistAddFilesBtn'),
  playlistAddCurrentBtn: $('playlistAddCurrentBtn'),
  playlistPrevBtn: $('playlistPrevBtn'),
  playlistNextBtn: $('playlistNextBtn'),
  playlistFileInput: $('playlistFileInput'),
  playlistTracks: $('playlistTracks'),
  playlistEmpty: $('playlistEmpty'),
  recentSection: $('recentSection'),
  recentList: $('recentList'),
  currentTime: $('currentTime'),
  duration: $('duration'),
  seekTrack: $('seekTrack'),
  seekFill: $('seekFill'),
  seekAb: $('seekAb'),
  seekThumb: $('seekThumb'),
  playBtn: $('playBtn'),
  stopBtn: $('stopBtn'),
  skipBackBtn: $('skipBackBtn'),
  skipFwdBtn: $('skipFwdBtn'),
  loopBtn: $('loopBtn'),
  setABtn: $('setABtn'),
  setBBtn: $('setBBtn'),
  abLoopBtn: $('abLoopBtn'),
  clearAbBtn: $('clearAbBtn'),
  abLabels: $('abLabels'),
  labelA: $('labelA'),
  labelB: $('labelB'),
  tempoSlider: $('tempoSlider'),
  tempoValue: $('tempoValue'),
  tempoDown: $('tempoDown'),
  tempoUp: $('tempoUp'),
  pitchSlider: $('pitchSlider'),
  pitchValue: $('pitchValue'),
  pitchDown: $('pitchDown'),
  pitchUp: $('pitchUp'),
  linkRate: $('linkRate'),
};

let seekingUi = false;
let currentTrackId = null;
let activePlaylistId = getActivePlaylistId();
/** @type {string[]} */
let playlistTrackIds = [];
let playlistIndex = -1;
let advancingPlaylist = false;

function setControlsEnabled(on) {
  [
    els.playBtn,
    els.stopBtn,
    els.skipBackBtn,
    els.skipFwdBtn,
    els.loopBtn,
    els.setABtn,
    els.setBBtn,
    els.tempoSlider,
    els.pitchSlider,
    els.tempoDown,
    els.tempoUp,
    els.pitchDown,
    els.pitchUp,
  ].forEach((el) => {
    el.disabled = !on;
  });
  els.playlistAddCurrentBtn.disabled = !on || !activePlaylistId;
}

setControlsEnabled(false);

function formatPlayedAt(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isAudioFile(file) {
  return file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i.test(file.name);
}

/* ========== 재생목록 UI ========== */

function syncPlaylistNav() {
  const has = !!activePlaylistId && playlistTrackIds.length > 0;
  els.playlistPrevBtn.disabled = !has;
  els.playlistNextBtn.disabled = !has;
  els.playlistRenameBtn.disabled = !activePlaylistId;
  els.playlistDeleteBtn.disabled = !activePlaylistId;
  els.playlistAddCurrentBtn.disabled = !currentTrackId || !activePlaylistId;
  els.playlistPanel.hidden = !activePlaylistId;
}

async function refreshPlaylistSelect() {
  const list = await listPlaylists();
  const prev = activePlaylistId;
  els.playlistSelect.innerHTML =
    `<option value="">선택 안 함</option>` +
    list
      .map(
        (pl) =>
          `<option value="${escapeHtml(pl.id)}">${escapeHtml(pl.name)} (${pl.trackIds?.length || 0})</option>`
      )
      .join('');

  if (prev && list.some((p) => p.id === prev)) {
    els.playlistSelect.value = prev;
    activePlaylistId = prev;
  } else if (list.length && prev) {
    // 삭제된 목록이면 초기화
    activePlaylistId = '';
    setActivePlaylistId('');
    els.playlistSelect.value = '';
  } else {
    els.playlistSelect.value = activePlaylistId || '';
  }
}

async function refreshPlaylistTracks() {
  if (!activePlaylistId) {
    playlistTrackIds = [];
    playlistIndex = -1;
    els.playlistTracks.innerHTML = '';
    els.playlistEmpty.hidden = false;
    syncPlaylistNav();
    return;
  }

  const tracks = await getPlaylistTracks(activePlaylistId);
  playlistTrackIds = tracks.map((t) => t.id);

  if (currentTrackId) {
    const idx = playlistTrackIds.indexOf(currentTrackId);
    if (idx >= 0) playlistIndex = idx;
  }

  els.playlistEmpty.hidden = tracks.length > 0;
  els.playlistTracks.innerHTML = tracks
    .map((t, i) => {
      const active = t.id === currentTrackId ? ' is-active' : '';
      return `
        <li>
          <div class="pl-track${active}" data-id="${escapeHtml(t.id)}" data-index="${i}" role="button" tabindex="0">
            <span class="pl-track-idx">${i + 1}</span>
            <div class="pl-track-main">
              <div class="pl-track-name">${escapeHtml(t.name)}</div>
              <div class="pl-track-meta">${t.duration ? formatTime(t.duration) : '—'}</div>
            </div>
            <button type="button" class="pl-track-remove" data-action="remove" data-id="${escapeHtml(t.id)}" title="목록에서 제거" aria-label="목록에서 제거">×</button>
          </div>
        </li>`;
    })
    .join('');

  syncPlaylistNav();
}

async function selectPlaylist(id) {
  activePlaylistId = id || '';
  setActivePlaylistId(activePlaylistId);
  els.playlistSelect.value = activePlaylistId;
  await refreshPlaylistTracks();
  syncPlaylistNav();
}

async function playPlaylistIndex(index, { autoplay = true } = {}) {
  if (!activePlaylistId || index < 0 || index >= playlistTrackIds.length) return;
  const trackId = playlistTrackIds[index];
  const record = await getTrack(trackId);
  if (!record?.blob) {
    alert('음원 데이터를 찾을 수 없습니다. 목록에서 제거 후 다시 추가해 주세요.');
    return;
  }
  playlistIndex = index;
  advancingPlaylist = true;
  await loadFile(trackToFile(record), { fromPlaylist: true });
  advancingPlaylist = false;
  if (autoplay && engine.buffer) await engine.play();
}

async function playNextInPlaylist() {
  if (!activePlaylistId || !playlistTrackIds.length) return;
  const next = playlistIndex + 1;
  if (next >= playlistTrackIds.length) {
    // 목록 끝 — 처음부터
    await playPlaylistIndex(0, { autoplay: true });
    return;
  }
  await playPlaylistIndex(next, { autoplay: true });
}

async function playPrevInPlaylist() {
  if (!activePlaylistId || !playlistTrackIds.length) return;
  const prev = playlistIndex <= 0 ? playlistTrackIds.length - 1 : playlistIndex - 1;
  await playPlaylistIndex(prev, { autoplay: true });
}

els.playlistSelect.addEventListener('change', async () => {
  await selectPlaylist(els.playlistSelect.value);
});

els.playlistNewBtn.addEventListener('click', async () => {
  const name = prompt('새 재생목록 이름', `재생목록 ${(await listPlaylists()).length + 1}`);
  if (name === null) return;
  const pl = await createPlaylist(name);
  await refreshPlaylistSelect();
  await selectPlaylist(pl.id);
});

els.playlistRenameBtn.addEventListener('click', async () => {
  if (!activePlaylistId) return;
  const pl = await getPlaylist(activePlaylistId);
  if (!pl) return;
  const name = prompt('재생목록 이름 변경', pl.name);
  if (name === null || !name.trim()) return;
  await renamePlaylist(activePlaylistId, name);
  await refreshPlaylistSelect();
  els.playlistSelect.value = activePlaylistId;
});

els.playlistDeleteBtn.addEventListener('click', async () => {
  if (!activePlaylistId) return;
  const pl = await getPlaylist(activePlaylistId);
  if (!pl) return;
  if (!confirm(`「${pl.name}」 재생목록을 삭제할까요?\n(음원 파일 자체는 남습니다)`)) return;
  await deletePlaylist(activePlaylistId);
  await selectPlaylist('');
  await refreshPlaylistSelect();
});

els.playlistAddFilesBtn.addEventListener('click', () => {
  if (!activePlaylistId) {
    alert('먼저 재생목록을 선택하거나 만들어 주세요.');
    return;
  }
  els.playlistFileInput.click();
});

els.playlistFileInput.addEventListener('change', async () => {
  const files = [...(els.playlistFileInput.files || [])];
  els.playlistFileInput.value = '';
  if (!files.length || !activePlaylistId) return;

  els.playlistAddFilesBtn.disabled = true;
  els.playlistAddFilesBtn.textContent = '추가 중…';

  try {
    for (const file of files) {
      if (!isAudioFile(file)) continue;
      try {
        const duration = await probeDuration(file);
        await addFileToPlaylist(activePlaylistId, file, duration);
      } catch (err) {
        console.warn(err);
      }
    }
  } finally {
    els.playlistAddFilesBtn.disabled = false;
    els.playlistAddFilesBtn.textContent = '곡 추가';
  }

  await refreshPlaylistSelect();
  await refreshPlaylistTracks();
});

/** 파일 길이만 메타데이터로 측정 (전체 디코딩 생략) */
async function probeDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const duration = await new Promise((resolve) => {
      const audio = new Audio();
      audio.preload = 'metadata';
      const done = (v) => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        resolve(v);
      };
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        done(Number.isFinite(d) && d > 0 ? d : 0);
      };
      audio.onerror = () => done(0);
      audio.src = url;
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

els.playlistAddCurrentBtn.addEventListener('click', async () => {
  if (!activePlaylistId || !currentTrackId) return;
  const track = await getTrack(currentTrackId);
  if (!track) {
    alert('현재 곡이 라이브러리에 없습니다. 다시 불러온 뒤 추가해 주세요.');
    return;
  }
  await addTrackIdToPlaylist(activePlaylistId, currentTrackId);
  await refreshPlaylistSelect();
  await refreshPlaylistTracks();
});

els.playlistPrevBtn.addEventListener('click', () => playPrevInPlaylist());
els.playlistNextBtn.addEventListener('click', () => playNextInPlaylist());

els.playlistTracks.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('[data-action="remove"]');
  if (removeBtn) {
    e.stopPropagation();
    await removeTrackFromPlaylist(activePlaylistId, removeBtn.dataset.id);
    await refreshPlaylistSelect();
    await refreshPlaylistTracks();
    return;
  }
  const row = e.target.closest('.pl-track');
  if (!row) return;
  const index = Number(row.dataset.index);
  await playPlaylistIndex(index, { autoplay: true });
});

els.playlistTracks.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.pl-track');
  if (!row) return;
  e.preventDefault();
  playPlaylistIndex(Number(row.dataset.index), { autoplay: true });
});

/* ========== 최근 재생 ========== */

async function refreshRecentList() {
  let items = [];
  try {
    items = await listRecent();
  } catch (err) {
    console.warn('최근 목록을 불러오지 못했습니다.', err);
  }

  if (!items.length) {
    els.recentSection.hidden = true;
    els.recentList.innerHTML = '';
    return;
  }

  els.recentSection.hidden = false;
  els.recentList.innerHTML = items
    .map((item) => {
      const active = item.id === currentTrackId ? ' is-active' : '';
      const dur = item.duration ? formatTime(item.duration) : '—';
      return `
        <li>
          <div class="recent-item${active}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0">
            <div class="recent-item-main">
              <div class="recent-item-name">${escapeHtml(item.name)}</div>
              <div class="recent-item-meta">${dur} · ${formatPlayedAt(item.playedAt)}</div>
            </div>
            <div class="recent-item-actions">
              <button type="button" class="recent-play" data-action="play" data-id="${escapeHtml(item.id)}" title="재생" aria-label="재생">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <button type="button" class="recent-remove" data-action="remove" data-id="${escapeHtml(item.id)}" title="목록에서 제거" aria-label="목록에서 제거">×</button>
            </div>
          </div>
        </li>`;
    })
    .join('');
}

async function loadRecentById(id) {
  const record = await getRecent(id);
  if (!record?.blob) {
    alert('저장된 음원을 찾을 수 없습니다.');
    await refreshRecentList();
    return;
  }
  await loadFile(trackToFile(record));
}

els.recentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    e.stopPropagation();
    const { action, id } = btn.dataset;
    if (action === 'remove') {
      await removeRecent(id);
      if (currentTrackId === id) currentTrackId = null;
      await refreshRecentList();
      return;
    }
    if (action === 'play') {
      await loadRecentById(id);
      if (engine.buffer) await engine.play();
      return;
    }
  }

  const row = e.target.closest('.recent-item');
  if (row?.dataset.id) {
    await loadRecentById(row.dataset.id);
  }
});

els.recentList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.recent-item');
  if (!row?.dataset.id) return;
  e.preventDefault();
  loadRecentById(row.dataset.id);
});

/* —— 파일 로드 —— */
async function loadFile(file, { fromPlaylist = false } = {}) {
  if (!file) return;
  if (!isAudioFile(file)) {
    alert('지원하는 음원 파일을 선택해 주세요. (mp3, wav, ogg, m4a 등)');
    return;
  }

  const cacheKey = trackIdFromFile(file);
  const isSameLoaded = cacheKey === currentTrackId && engine.buffer;

  els.dropIdle.hidden = false;
  els.trackMeta.hidden = true;
  els.dropIdle.querySelector('.drop-title').textContent = isSameLoaded
    ? '불러오는 중…'
    : '디코딩 중…';

  try {
    const { buffer, name, duration, cacheKey: key, fromCache } = await engine.loadFile(file, {
      cacheKey,
    });
    wave.setBuffer(buffer, { cacheKey: key });

    els.dropIdle.hidden = true;
    els.trackMeta.hidden = false;
    els.trackName.textContent = name;
    const cacheNote = fromCache ? ' · 캐시' : '';
    els.trackInfo.textContent = `${formatTime(duration)} · ${(file.size / 1024 / 1024).toFixed(1)} MB · ${buffer.sampleRate} Hz${cacheNote}`;
    els.duration.textContent = formatTime(duration);

    currentTrackId = key;
    setControlsEnabled(true);
    updateAbUi();
    syncPresets();

    try {
      await saveRecent(file, duration);
    } catch (err) {
      console.warn('최근 재생 저장 실패', err);
    }

    if (!fromPlaylist && activePlaylistId) {
      const idx = playlistTrackIds.indexOf(currentTrackId);
      playlistIndex = idx;
    }

    await refreshRecentList();
    await refreshPlaylistTracks();
  } catch (err) {
    console.error(err);
    alert('파일을 읽을 수 없습니다. 다른 포맷으로 시도해 보세요.');
    els.dropIdle.querySelector('.drop-title').textContent = '음원 파일을 여기에 놓거나 탭하세요';
  }
}

function openPicker() {
  els.fileInput.click();
}

els.dropzone.addEventListener('click', (e) => {
  if (e.target === els.changeFileBtn) return;
  if (!els.trackMeta.hidden && e.target.closest('.track-meta') && e.target !== els.changeFileBtn) {
    return;
  }
  if (els.trackMeta.hidden || e.target.closest('#dropIdle')) openPicker();
});

els.changeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openPicker();
});

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  loadFile(file);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-drag');
  });
});

['dragleave', 'drop'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('is-drag');
  });
});

els.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  loadFile(file);
});

/* —— 재생 컨트롤 —— */
els.playBtn.addEventListener('click', () => engine.toggle());
els.stopBtn.addEventListener('click', () => engine.stop());
els.skipBackBtn.addEventListener('click', () => engine.skip(-5));
els.skipFwdBtn.addEventListener('click', () => engine.skip(5));

els.loopBtn.addEventListener('click', () => {
  const next = !engine.loopFull;
  engine.setLoopFull(next);
  if (next) engine.setAbEnabled(false);
});

els.setABtn.addEventListener('click', () => {
  engine.setMarkA();
  updateAbUi();
});

els.setBBtn.addEventListener('click', () => {
  engine.setMarkB();
  updateAbUi();
});

els.abLoopBtn.addEventListener('click', () => {
  engine.setAbEnabled(!engine.abEnabled);
});

els.clearAbBtn.addEventListener('click', () => {
  engine.clearAb();
  updateAbUi();
});

/* —— 슬라이더 —— */
const TEMPO_STEP = 5; // %
const PITCH_STEP = 1; // 반음

function applyTempo(pct) {
  const min = Number(els.tempoSlider.min);
  const max = Number(els.tempoSlider.max);
  // 5% 단위로 맞춤
  const snapped = Math.round(pct / TEMPO_STEP) * TEMPO_STEP;
  const next = Math.max(min, Math.min(max, snapped));
  els.tempoSlider.value = String(next);
  engine.setTempo(next / 100);
  els.tempoValue.textContent = `${next}%`;
  syncPresets();
}

function applyPitch(st, { integer = false } = {}) {
  const min = Number(els.pitchSlider.min);
  const max = Number(els.pitchSlider.max);
  let next = Number(st);
  if (integer) next = Math.round(next);
  next = Math.max(min, Math.min(max, next));
  els.pitchSlider.value = String(next);
  engine.setPitchSemitones(next);
  els.pitchValue.textContent = formatPitch(next);
}

els.tempoSlider.addEventListener('input', () => {
  applyTempo(Number(els.tempoSlider.value));
});

els.pitchSlider.addEventListener('input', () => {
  applyPitch(Number(els.pitchSlider.value), { integer: true });
});

function onTempoNudge(delta) {
  applyTempo(Number(els.tempoSlider.value) + delta);
}

function onPitchNudge(delta) {
  applyPitch(Number(els.pitchSlider.value) + delta, { integer: true });
}

els.tempoDown.addEventListener('click', () => onTempoNudge(-TEMPO_STEP));
els.tempoUp.addEventListener('click', () => onTempoNudge(TEMPO_STEP));
els.pitchDown.addEventListener('click', () => onPitchNudge(-PITCH_STEP));
els.pitchUp.addEventListener('click', () => onPitchNudge(PITCH_STEP));

els.linkRate.addEventListener('change', () => {
  engine.setLinkRate(els.linkRate.checked);
  const pitchOff = els.linkRate.checked || !engine.buffer;
  els.pitchSlider.disabled = pitchOff;
  els.pitchDown.disabled = pitchOff;
  els.pitchUp.disabled = pitchOff;
  els.pitchValue.style.opacity = els.linkRate.checked ? '0.45' : '1';
});

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    applyTempo(Number(btn.dataset.tempo));
  });
});

function formatPitch(st) {
  if (st === 0) return '0 st';
  return `${st > 0 ? '+' : ''}${st} st`;
}

function syncPresets() {
  const cur = Number(els.tempoSlider.value);
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.dataset.tempo) === cur);
  });
}

function updateAbUi() {
  const { markA, markB, abEnabled, duration } = {
    markA: engine.markA,
    markB: engine.markB,
    abEnabled: engine.abEnabled,
    duration: engine.duration,
  };

  const ready = markA != null && markB != null;
  els.abLoopBtn.disabled = !ready;
  els.clearAbBtn.disabled = markA == null && markB == null;

  els.abLabels.hidden = true;

  if (ready && duration > 0) {
    els.seekAb.hidden = false;
    const left = (markA / duration) * 100;
    const width = ((markB - markA) / duration) * 100;
    els.seekAb.style.left = `${left}%`;
    els.seekAb.style.width = `${width}%`;
  } else {
    els.seekAb.hidden = true;
  }

  wave.setMarks(markA, markB, abEnabled);
}

/* —— 시크 바 —— */
function seekFromClientX(clientX) {
  if (!engine.buffer) return;
  const rect = els.seekTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  engine.seek(ratio * engine.duration);
}

els.seekTrack.addEventListener('pointerdown', (e) => {
  if (!engine.buffer) return;
  seekingUi = true;
  els.seekTrack.setPointerCapture(e.pointerId);
  seekFromClientX(e.clientX);
});

els.seekTrack.addEventListener('pointermove', (e) => {
  if (!seekingUi) return;
  seekFromClientX(e.clientX);
});

els.seekTrack.addEventListener('pointerup', () => {
  seekingUi = false;
});

wave.onSeek((ratio) => {
  if (!engine.buffer) return;
  engine.seek(ratio * engine.duration);
});

wave.onMarks(({ a, b }) => {
  engine.setAbMarks(a, b);
});

/* —— 엔진 이벤트 —— */
engine.onProgress(({ time, percent }) => {
  if (seekingUi) return;
  els.currentTime.textContent = formatTime(time);
  els.seekFill.style.width = `${percent}%`;
  els.seekThumb.style.left = `${percent}%`;
  els.seekTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
  wave.setProgress(percent / 100);
});

engine.onState((state) => {
  els.playBtn.classList.toggle('is-playing', state.playing);
  els.playBtn.setAttribute('aria-label', state.playing ? '일시정지' : '재생');
  els.loopBtn.setAttribute('aria-pressed', String(state.loopFull));
  els.abLoopBtn.setAttribute('aria-pressed', String(state.abEnabled));
  updateAbUi();
});

// 곡 종료 시 재생목록 다음 곡 (전체반복·A-B반복이 아닐 때)
engine.onEnded(() => {
  if (advancingPlaylist) return;
  if (engine.loopFull || engine.abEnabled) return;
  if (!activePlaylistId || playlistTrackIds.length < 2) return;
  playNextInPlaylist();
});

// 잠금화면 / 알림센터 미디어 컨트롤
backgroundPlayback.setHandlers({
  play: () => {
    if (engine.buffer && !engine.playing) engine.play();
  },
  pause: () => {
    if (engine.playing) engine.pause();
  },
  next: () => {
    if (activePlaylistId) playNextInPlaylist();
  },
  prev: () => {
    if (activePlaylistId) playPrevInPlaylist();
  },
});
backgroundPlayback.setSeekRelative((delta) => {
  if (engine.buffer) engine.skip(delta);
});

/* —— 키보드 단축키 —— */
window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (engine.buffer) engine.toggle();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      engine.skip(e.shiftKey ? -1 : -5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      engine.skip(e.shiftKey ? 1 : 5);
      break;
    case 'KeyA':
      if (engine.buffer) engine.setMarkA();
      break;
    case 'KeyB':
      if (engine.buffer) engine.setMarkB();
      break;
    case 'KeyL':
      if (engine.buffer) {
        engine.setLoopFull(!engine.loopFull);
        if (engine.loopFull) engine.setAbEnabled(false);
      }
      break;
    case 'KeyN':
      if (activePlaylistId) playNextInPlaylist();
      break;
    case 'KeyP':
      if (e.shiftKey && activePlaylistId) playPrevInPlaylist();
      break;
    default:
      break;
  }
});

engine.setVolume(0.8);

(async function init() {
  await refreshPlaylistSelect();
  if (activePlaylistId) {
    els.playlistSelect.value = activePlaylistId;
    await selectPlaylist(activePlaylistId);
  } else {
    syncPlaylistNav();
  }
  await refreshRecentList();
})();
