/**
 * PC용 음성 제어 (속도 + 재생) — Web Speech API
 * Edge / Chrome 권장
 */

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

/** UI·상태 메시지용 기본 가이드 */
export const VOICE_GUIDE_IDLE =
  '재생: 시작·플레이 · 멈춤: 멈춰 · 정지: 스톱 · 속도: 빠르게·80퍼센트';

export const VOICE_GUIDE_LISTENING =
  '듣는 중… 「시작」「멈춰」「스톱」「빠르게」「80퍼센트」';

export function isSpeechSupported() {
  return !!SpeechRecognitionAPI;
}

/**
 * @param {{ onCommand: (cmd: { type: string, value?: number, raw: string }) => void, onStatus?: (s: string) => void, onListening?: (on: boolean) => void }} opts
 */
export function createVoiceTempoControl({ onCommand, onStatus, onListening }) {
  if (!SpeechRecognitionAPI) {
    return {
      supported: false,
      listening: false,
      start() {
        onStatus?.('이 브라우저는 음성 인식을 지원하지 않습니다. Edge 또는 Chrome을 사용해 주세요.');
      },
      stop() {},
      toggle() {},
    };
  }

  const recognition = new SpeechRecognitionAPI();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 5;

  let listening = false;
  let wantListen = false;
  let lastFireAt = 0;
  let lastType = '';
  let lastRaw = '';

  function setListening(on) {
    listening = on;
    onListening?.(on);
  }

  function fire(cmd) {
    const now = Date.now();
    // 같은 말·같은 동작 연속 인식 방지 (다른 명령은 더 빠르게 허용)
    if (cmd.type === lastType && cmd.raw === lastRaw && now - lastFireAt < 1400) return;
    if (cmd.type === lastType && now - lastFireAt < 700) return;
    if (now - lastFireAt < 280) return;
    lastFireAt = now;
    lastType = cmd.type;
    lastRaw = cmd.raw;
    onCommand(cmd);
  }

  recognition.onstart = () => {
    setListening(true);
    onStatus?.(VOICE_GUIDE_LISTENING);
  };

  recognition.onend = () => {
    setListening(false);
    if (wantListen) {
      // Chrome/Edge는 침묵 후 종료되므로 재시작
      try {
        recognition.start();
      } catch {
        wantListen = false;
        onStatus?.('음성 인식이 중지되었습니다. 버튼을 다시 눌러 주세요.');
      }
    } else {
      onStatus?.(VOICE_GUIDE_IDLE);
    }
  };

  recognition.onerror = (e) => {
    const err = e.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      wantListen = false;
      setListening(false);
      onStatus?.('마이크 권한이 필요합니다. 브라우저 설정에서 허용해 주세요.');
      return;
    }
    if (err === 'no-speech' || err === 'aborted') return;
    onStatus?.(`음성 인식 오류: ${err}`);
  };

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;

      // 대안 후보를 모두 돌려 보고 먼저 매칭되는 명령 채택
      let matched = null;
      const heardList = [];
      for (let a = 0; a < result.length; a++) {
        const raw = (result[a].transcript || '').trim();
        if (!raw) continue;
        heardList.push(raw);
        const cmd = parseVoiceCommand(raw);
        if (cmd) {
          matched = cmd;
          break;
        }
      }
      if (matched) {
        fire(matched);
        return;
      }
      const heard = heardList[0];
      if (heard) onStatus?.(`들은 말: 「${heard}」 — 「시작」「스톱」「멈춰」「빠르게」`);
    }
  };

  return {
    supported: true,
    get listening() {
      return listening;
    },
    start() {
      wantListen = true;
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    },
    stop() {
      wantListen = false;
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      onStatus?.(VOICE_GUIDE_IDLE);
    },
    toggle() {
      if (wantListen) this.stop();
      else this.start();
    },
  };
}

/** @deprecated parseVoiceCommand 사용 */
export function parseTempoCommand(transcript) {
  return parseVoiceCommand(transcript);
}

/** STT 오인식·표기 정규화 */
function normalizeTranscript(transcript) {
  let t = transcript
    .trim()
    .toLowerCase()
    .replace(/[.,!?…·"'`~]/g, '')
    .replace(/\s+/g, '')
    .replace(/%/g, '퍼센트')
    .replace(/％/g, '퍼센트');

  // 영문 → 한글 키워드
  t = t
    .replace(/speedup|faster/g, '빠르게')
    .replace(/slowdown|slower/g, '느리게')
    .replace(/normal|reset/g, '원래대로')
    .replace(/resume/g, '이어재생')
    .replace(/start/g, '시작')
    .replace(/play/g, '플레이')
    .replace(/pause/g, '일시정지')
    .replace(/stop+|stopp|stock|stalk|halt/g, '스톱')
    .replace(/go/g, '고');

  // 재생 계열 오인식·변형
  t = t
    .replace(/스타또|스타트|시잍|시잘/g, '시작')
    .replace(/시작해줘|시작해|시작하/g, '시작')
    .replace(/플래이|푸레이|플레이해/g, '플레이')
    .replace(/재생해줘|재생해|재생하/g, '재생')
    .replace(/고고|고우/g, '고')
    .replace(/틀어줘|틀어봐|틀어|켜줘/g, '시작');

  // 정지 계열 오인식 (스톱 ↔ 스탑 등)
  t = t
    .replace(/스토프|스투프|스또프|스또쁘|스텁|스또|서톱|스탑|스톱해|스탑해/g, '스톱')
    .replace(/정지해줘|정지해|중지해|종료해|그만해/g, '정지')
    .replace(/중지|종료/g, '정지');

  // 일시정지
  t = t
    .replace(/퍼즈|퍼스|포즈/g, '일시정지')
    .replace(/멈춰줘|멈춰라|멈처|멈취|일시멈춰/g, '멈춰')
    .replace(/일시정지해/g, '일시정지');

  // 말미 부탁·감탄
  t = t.replace(/(해줘|해줘요|해주세요|줘요|이요|요)+$/g, '');

  return t;
}

/** 한국어/영문 음성 명령 파싱 (재생 + 속도) */
export function parseVoiceCommand(transcript) {
  const raw = transcript.trim();
  const t = normalizeTranscript(raw);

  const playback = parsePlaybackCommand(t, raw);
  if (playback) return playback;

  // 상대 조절 — "올려/내려"는 속도 문맥일 때만 (단독·짧은 말은 제외해 오작동 줄임)
  if (
    /(빠르게|빨리|더빠르게|속도올려|속도업|가속)/.test(t) ||
    (/^(올려|업)$/.test(t) || /(속도를)?올려/.test(t))
  ) {
    if (!/(느리|천천히)/.test(t)) {
      const big = /(많이|크게|확)/.test(t);
      return { type: 'nudge', value: big ? 10 : 5, raw };
    }
  }
  if (/(느리게|천천히|더느리게|속도내려|속도다운|감속)/.test(t) || /내려/.test(t) && /속도/.test(t)) {
    const big = /(많이|크게|확)/.test(t);
    return { type: 'nudge', value: big ? -10 : -5, raw };
  }
  if (/^(내려|다운)$/.test(t)) {
    return { type: 'nudge', value: -5, raw };
  }

  // 프리셋 표현
  if (/(원래대로|정상속도|정상|원래속도|일배속|일배|기본속도|리셋)/.test(t)) {
    return { type: 'set', value: 100, raw };
  }
  if (/(반배|반배속|영점오|제로점파이브|절반)/.test(t)) {
    return { type: 'set', value: 50, raw };
  }
  if (/(일점이오|일점이오배|일점이십오)/.test(t)) {
    return { type: 'set', value: 125, raw };
  }
  if (/(일점오|일점오배|일쩜오)/.test(t)) {
    return { type: 'set', value: 150, raw };
  }
  if (/(이배|이배속|두배)/.test(t)) {
    return { type: 'set', value: 200, raw };
  }
  if (/(영점칠오|영쩜칠오)/.test(t)) {
    return { type: 'set', value: 75, raw };
  }

  // "배속" 소수: 0.5배 1.25배 1.5배 2배
  const mul = t.match(/(?:속도)?(\d+(?:\.\d+)?)배/);
  if (mul) {
    const n = Number(mul[1]);
    if (n > 0 && n <= 2.5) {
      return { type: 'set', value: Math.round(n * 100), raw };
    }
  }

  // 퍼센트 / 숫자
  const pct = t.match(/(?:속도)?(\d{2,3})(?:퍼센트|프로)?/);
  if (pct) {
    const n = Number(pct[1]);
    if (n >= 25 && n <= 200) {
      return { type: 'set', value: n, raw };
    }
  }

  // 한글 숫자 (간단)
  const kor = parseKoreanPercent(t);
  if (kor != null) return { type: 'set', value: kor, raw };

  return null;
}

/**
 * 재생 / 일시정지 / 정지
 * 키워드가 포함되면 짧은 발화로 간주하고 매칭 (STT가 앞뒤를 붙이는 경우 대비)
 */
function parsePlaybackCommand(t, raw) {
  if (!t) return null;

  const playKeys = ['시작', '플레이', '재생', '고', '이어재생', '계속'];
  const pauseKeys = ['멈춰', '일시정지', '일시멈춤'];
  const stopKeys = ['스톱', '정지', '그만'];
  const toggleKeys = ['토글', '재생정지'];

  // 우선순위: 일시정지 > 정지 > 재생
  // (「일시정지」에 「정지」가 포함되므로 pause를 먼저 판별)
  if (hasAny(t, pauseKeys)) {
    if (isShortCommand(t, pauseKeys) || endsWithKey(t, pauseKeys)) {
      return { type: 'pause', raw };
    }
  }
  if (hasAny(t, stopKeys) && !hasAny(t, pauseKeys)) {
    if (isShortCommand(t, stopKeys) || endsWithKey(t, stopKeys)) {
      return { type: 'stop', raw };
    }
  }
  if (hasAny(t, toggleKeys)) {
    return { type: 'toggle', raw };
  }
  if (hasAny(t, playKeys) && !hasAny(t, stopKeys) && !hasAny(t, pauseKeys)) {
    if (isShortCommand(t, playKeys) || endsWithKey(t, playKeys)) {
      return { type: 'play', raw };
    }
  }

  return null;
}

function hasAny(t, keys) {
  return keys.some((k) => t.includes(k));
}

function endsWithKey(t, keys) {
  return keys.some((k) => t.endsWith(k));
}

/** 키워드 + 짧은 군더더기만 있는 발화 */
function isShortCommand(t, keys) {
  if (!keys.some((k) => t.includes(k))) return false;
  if (t.length <= 14) return true;
  let rest = t;
  for (const k of keys) rest = rest.split(k).join('');
  rest = rest.replace(/(음악|노래|곡|좀|제발|바로|이제|다시|한번|해주세요|해줘)/g, '');
  return rest.length <= 4;
}

function parseKoreanPercent(t) {
  const map = {
    이십오: 25,
    삼십: 30,
    사십: 40,
    오십: 50,
    육십: 60,
    칠십: 70,
    팔십: 80,
    구십: 90,
    백: 100,
    백십: 110,
    백이십: 120,
    백이십오: 125,
    백삼십: 130,
    백오십: 150,
    백칠십오: 175,
    이백: 200,
  };
  for (const [k, v] of Object.entries(map)) {
    if (t.includes(k + '퍼센트') || t.includes(k + '프로')) return v;
  }
  for (const [k, v] of Object.entries(map)) {
    if (t.includes(k) && (t.includes('퍼센트') || t.includes('프로') || t.includes('속도') || t.endsWith(k))) {
      return v;
    }
  }
  return null;
}
