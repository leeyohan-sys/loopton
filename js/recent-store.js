/**
 * LoopTone 미디어 라이브러리 (IndexedDB)
 * — 트랙 Blob 저장, 최근 재생, 재생목록
 */

const DB_NAME = 'loopton-recent';
const DB_VERSION = 2;
const TRACKS = 'tracks';
const PLAYLISTS = 'playlists';
const MAX_RECENT = 4;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS)) {
        const store = db.createObjectStore(TRACKS, { keyPath: 'id' });
        store.createIndex('playedAt', 'playedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS)) {
        const pl = db.createObjectStore(PLAYLISTS, { keyPath: 'id' });
        pl.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      // v1 → v2: 기존 tracks 유지
      void event;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function uid(prefix = 'pl') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 파일 식별용 키 (이름+크기) */
export function trackIdFromFile(file) {
  return `${file.name}::${file.size}`;
}

/* ========== 트랙 ========== */

/**
 * 라이브러리에 트랙 저장
 * @param {{ markPlayed?: boolean }} options markPlayed=true 일 때만 최근재생에 반영
 */
export async function saveTrack(file, duration, { markPlayed = false } = {}) {
  const db = await openDb();
  const id = trackIdFromFile(file);
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS, 'readonly');
    const req = tx.objectStore(TRACKS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()], { type: file.type });

  const record = {
    id,
    name: file.name,
    size: file.size,
    type: file.type || 'audio/*',
    duration: duration || existing?.duration || 0,
    // 재생목록 추가만 할 때는 최근재생에 넣지 않음
    playedAt: markPlayed ? Date.now() : existing?.playedAt || 0,
    blob,
  };

  const tx = db.transaction(TRACKS, 'readwrite');
  tx.objectStore(TRACKS).put(record);
  await txDone(tx);
  return record;
}

/** 실제로 재생했을 때 — 최근 재생에 반영 */
export async function saveRecent(file, duration) {
  return saveTrack(file, duration, { markPlayed: true });
}

export async function getTrack(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS, 'readonly');
    const req = tx.objectStore(TRACKS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getRecent(id) {
  return getTrack(id);
}

export async function listRecent() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS, 'readonly');
    const req = tx.objectStore(TRACKS).getAll();
    req.onsuccess = () => {
      const rows = (req.result || [])
        .filter((r) => r.playedAt)
        .sort((a, b) => b.playedAt - a.playedAt)
        .slice(0, MAX_RECENT);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function removeRecent(id) {
  // 최근 목록에서만 숨김: playedAt 제거 (트랙·재생목록은 유지)
  const track = await getTrack(id);
  if (!track) return;
  const db = await openDb();
  const tx = db.transaction(TRACKS, 'readwrite');
  track.playedAt = 0;
  tx.objectStore(TRACKS).put(track);
  await txDone(tx);
}

export async function deleteTrack(id) {
  const db = await openDb();
  const tx = db.transaction([TRACKS, PLAYLISTS], 'readwrite');
  tx.objectStore(TRACKS).delete(id);

  const plReq = tx.objectStore(PLAYLISTS).getAll();
  plReq.onsuccess = () => {
    (plReq.result || []).forEach((pl) => {
      const next = (pl.trackIds || []).filter((tid) => tid !== id);
      if (next.length !== (pl.trackIds || []).length) {
        pl.trackIds = next;
        pl.updatedAt = Date.now();
        tx.objectStore(PLAYLISTS).put(pl);
      }
    });
  };
  await txDone(tx);
}

export function trackToFile(record) {
  return new File([record.blob], record.name, {
    type: record.type || 'audio/*',
    lastModified: record.playedAt || Date.now(),
  });
}

/* ========== 재생목록 ========== */

export async function listPlaylists() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS, 'readonly');
    const req = tx.objectStore(PLAYLISTS).getAll();
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPlaylist(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS, 'readonly');
    const req = tx.objectStore(PLAYLISTS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function createPlaylist(name) {
  const db = await openDb();
  const now = Date.now();
  const playlist = {
    id: uid('pl'),
    name: (name || '새 재생목록').trim() || '새 재생목록',
    trackIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const tx = db.transaction(PLAYLISTS, 'readwrite');
  tx.objectStore(PLAYLISTS).put(playlist);
  await txDone(tx);
  return playlist;
}

export async function renamePlaylist(id, name) {
  const pl = await getPlaylist(id);
  if (!pl) return null;
  pl.name = (name || '').trim() || pl.name;
  pl.updatedAt = Date.now();
  const db = await openDb();
  const tx = db.transaction(PLAYLISTS, 'readwrite');
  tx.objectStore(PLAYLISTS).put(pl);
  await txDone(tx);
  return pl;
}

export async function deletePlaylist(id) {
  const db = await openDb();
  const tx = db.transaction(PLAYLISTS, 'readwrite');
  tx.objectStore(PLAYLISTS).delete(id);
  await txDone(tx);
}

export async function addTrackIdToPlaylist(playlistId, trackId) {
  const pl = await getPlaylist(playlistId);
  if (!pl) throw new Error('재생목록을 찾을 수 없습니다.');
  if (!pl.trackIds.includes(trackId)) {
    pl.trackIds.push(trackId);
    pl.updatedAt = Date.now();
    const db = await openDb();
    const tx = db.transaction(PLAYLISTS, 'readwrite');
    tx.objectStore(PLAYLISTS).put(pl);
    await txDone(tx);
  }
  return pl;
}

/** 파일을 라이브러리에 저장 후 재생목록에 추가 (최근재생에는 넣지 않음) */
export async function addFileToPlaylist(playlistId, file, duration) {
  const track = await saveTrack(file, duration, { markPlayed: false });
  await addTrackIdToPlaylist(playlistId, track.id);
  return track;
}

export async function removeTrackFromPlaylist(playlistId, trackId) {
  const pl = await getPlaylist(playlistId);
  if (!pl) return null;
  pl.trackIds = (pl.trackIds || []).filter((id) => id !== trackId);
  pl.updatedAt = Date.now();
  const db = await openDb();
  const tx = db.transaction(PLAYLISTS, 'readwrite');
  tx.objectStore(PLAYLISTS).put(pl);
  await txDone(tx);
  return pl;
}

/** 재생목록 트랙 상세(메타) — blob 제외 가능하면 가볍게 */
export async function getPlaylistTracks(playlistId) {
  const pl = await getPlaylist(playlistId);
  if (!pl) return [];
  const tracks = [];
  for (const id of pl.trackIds || []) {
    const t = await getTrack(id);
    if (t) tracks.push(t);
  }
  return tracks;
}

const ACTIVE_KEY = 'loopton-active-playlist';

export function getActivePlaylistId() {
  return localStorage.getItem(ACTIVE_KEY) || '';
}

export function setActivePlaylistId(id) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}
