/**
 * PC용 음성 속도 조절 (Web Speech API)
 * Edge / Chrome 권장
 */

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

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
  recognition.maxAlternatives = 3;

  let listening = false;
  let wantListen = false;
  let lastFireAt = 0;
  let lastRaw = '';

  function setListening(on) {
    listening = on;
    onListening?.(on);
  }

  function fire(cmd) {
    const now = Date.now();
    // 같은 말 연속 인식 방지
    if (cmd.raw === lastRaw && now - lastFireAt < 1200) return;
    if (now - lastFireAt < 400) return;
    lastFireAt = now;
    lastRaw = cmd.raw;
    onCommand(cmd);
  }

  recognition.onstart = () => {
    setListening(true);
    onStatus?.('듣는 중… 「빠르게」「느리게」「80퍼센트」「원래대로」');
  };

  recognition.onend = () => {
    setListening(false);
    if (wantListen) {
      // Chrome/Edge는 침묵 후 종료되므로 재시작
      try {
        recognition.start();
      } catch {
        wantListen = false;
        onStatus?.('음성 인식이 중지되었습니다.');
      }
    } else {
      onStatus?.('음성 인식 꺼짐');
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
      for (let a = 0; a < result.length; a++) {
        const raw = (result[a].transcript || '').trim();
        if (!raw) continue;
        const cmd = parseTempoCommand(raw);
        if (cmd) {
          fire(cmd);
          return;
        }
      }
      // 인식은 됐지만 명령이 아님
      const heard = (result[0]?.transcript || '').trim();
      if (heard) onStatus?.(`들은 말: 「${heard}」 — 명령을 다시 말해 주세요`);
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
      onStatus?.('음성 인식 꺼짐');
    },
    toggle() {
      if (wantListen) this.stop();
      else this.start();
    },
  };
}

/** 한국어/숫자 속도 명령 파싱 */
export function parseTempoCommand(transcript) {
  const raw = transcript.trim();
  let t = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/%/g, '퍼센트')
    .replace(/％/g, '퍼센트');

  // 영문 간단 대응
  t = t
    .replace(/faster|speed ?up/g, '빠르게')
    .replace(/slower|slow ?down/g, '느리게')
    .replace(/normal|reset/g, '원래대로');

  // 상대 조절
  if (
    /(빠르게|빨리|더빠르게|속도올려|올려|업|가속)/.test(t) &&
    !/(느리|천천히)/.test(t)
  ) {
    const big = /(많이|크게|확)/.test(t);
    return { type: 'nudge', value: big ? 10 : 5, raw };
  }
  if (/(느리게|천천히|더느리게|속도내려|내려|다운|감속)/.test(t)) {
    const big = /(많이|크게|확)/.test(t);
    return { type: 'nudge', value: big ? -10 : -5, raw };
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
  const mul = t.match(/(?:속도)?(\d+(?:\.\d+)?)\s*배/);
  if (mul) {
    const n = Number(mul[1]);
    if (n > 0 && n <= 2.5) {
      return { type: 'set', value: Math.round(n * 100), raw };
    }
  }

  // 퍼센트 / 숫자
  const pct = t.match(/(?:속도)?(\d{2,3})\s*(?:퍼센트|프로|%|％)?/);
  if (pct) {
    let n = Number(pct[1]);
    if (n >= 25 && n <= 200) {
      return { type: 'set', value: n, raw };
    }
  }

  // 한글 숫자 (간단)
  const kor = parseKoreanPercent(t);
  if (kor != null) return { type: 'set', value: kor, raw };

  return null;
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
    if (t.includes(k) && (t.includes('퍼센트') || t.includes('프로') || t.includes('속도') || t.endsWith(k))) {
      return v;
    }
  }
  // "팔십퍼센트" 등
  for (const [k, v] of Object.entries(map)) {
    if (t.includes(k + '퍼센트') || t.includes(k + '프로')) return v;
  }
  return null;
}
