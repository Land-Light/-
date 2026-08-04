/*
 * srs.js — 間隔反復スケジューラ (FSRS-6)
 *
 * FSRS (Free Spaced Repetition Scheduler) は記憶の 3 変数モデル
 * (Difficulty / Stability / Retrievability) に基づく、実データで
 * パラメータを学習したアルゴリズムで、現在の Anki の既定スケジューラ。
 * 数式と既定パラメータは公式実装 open-spaced-repetition/fsrs-rs
 * (src/model.rs, src/inference.rs) に準拠している。
 *
 *   R(t,S) = (t/S * f + 1)^decay          decay = -w20, f = exp(ln0.9/decay) - 1
 *   間隔    I(S) = S/f * (Rd^(1/decay) - 1)   Rd = 目標保持率 (既定 0.9)
 *
 * 復習の間隔は「目標保持率まで記憶が下がる日数」なので、
 * 目標 90% なら間隔 = 安定度 S そのものになる。
 *
 * カードの状態:
 *   'new'        まだ一度も学習していない
 *   'learning'   学習ステップ中 (分単位の短い間隔)
 *   'review'     復習フェーズ (日単位の間隔)
 *   'relearning' 復習で「もう一度」を押した後の再学習ステップ
 *
 * 評価 (Anki と同じ 4 段階):
 *   1 = もう一度 (Again) / 2 = 難しい (Hard) / 3 = 普通 (Good) / 4 = 簡単 (Easy)
 */

const SRS = (() => {
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;

  // FSRS-6 既定パラメータ (fsrs-rs の DEFAULT_PARAMETERS)
  const W = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
    0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
    0.1542,
  ];

  const S_MIN = 0.001, S_MAX = 36500;
  const D_MIN = 1, D_MAX = 10;

  const DEFAULTS = {
    learningStepsMin: [1, 10],   // 新規カードの学習ステップ (分)
    relearnStepsMin: [10],       // 失敗後の再学習ステップ (分)
    desiredRetention: 0.9,       // 目標保持率 (復習時に思い出せる確率)
    maxIntervalDays: 36500,
    sm2Retention: 0.9,           // 旧 SM-2 データからの変換に使う想定保持率
  };

  // 目標保持率は設定から変更できる
  let retention = DEFAULTS.desiredRetention;
  function setRetention(r) {
    const v = Number(r);
    if (isFinite(v) && v >= 0.7 && v <= 0.99) retention = v;
  }
  function getRetention() { return retention; }

  // ---- FSRS の基本式 ----

  const decay = () => -W[20];
  const factor = () => Math.exp(Math.log(0.9) / decay()) - 1;

  const clampS = s => Math.min(S_MAX, Math.max(S_MIN, s));
  const clampD = d => Math.min(D_MAX, Math.max(D_MIN, d));

  // 経過 t 日後に思い出せる確率
  function retrievability(t, s) {
    return Math.pow((t / s) * factor() + 1, decay());
  }

  // 安定度 s のカードを、目標保持率まで下がる日数 (= 次の間隔)
  function intervalFromStability(s, r = retention) {
    const i = (s / factor()) * (Math.pow(r, 1 / decay()) - 1);
    return Math.min(DEFAULTS.maxIntervalDays, Math.max(1, Math.round(i)));
  }

  const initStability = g => W[Math.min(3, Math.max(0, g - 1))];
  const initDifficulty = g => W[4] - Math.exp(W[5] * (g - 1)) + 1;

  const linearDamping = (deltaD, oldD) => ((10 - oldD) * deltaD) / 9;
  const nextDifficulty = (d, g) => d + linearDamping(-W[6] * (g - 3), d);
  const meanReversion = newD => W[7] * (initDifficulty(4) - newD) + newD;

  function stabilityAfterSuccess(s, d, r, g) {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    return s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
      (Math.exp((1 - r) * W[10]) - 1) * hard * easy + 1);
  }

  // 失敗後の安定度。大きく下がるが、元の安定度を超えないよう上限も掛かる。
  function stabilityAfterFailure(s, d, r) {
    const newS = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) *
      Math.exp((1 - r) * W[14]);
    const cap = s / Math.exp(W[17] * W[18]);
    return Math.min(newS, cap);
  }

  // 同日中の再学習 (経過 0 日) の安定度
  function stabilityShortTerm(s, g) {
    const sinc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
    return s * (g >= 2 ? Math.max(sinc, 1) : sinc);
  }

  // 記憶状態 (stability, difficulty) を 1 回の回答ぶん進める
  function nextMemoryState(card, rating, elapsedDays) {
    if (!card.stability) {
      return {
        stability: clampS(initStability(rating)),
        difficulty: clampD(initDifficulty(rating)),
      };
    }
    const s = clampS(card.stability);
    const d = clampD(card.difficulty || initDifficulty(3));
    const r = retrievability(elapsedDays, s);
    let newS;
    if (elapsedDays <= 0) newS = stabilityShortTerm(s, rating);
    else if (rating === 1) newS = stabilityAfterFailure(s, d, r);
    else newS = stabilityAfterSuccess(s, d, r, rating);
    return {
      stability: clampS(newS),
      difficulty: clampD(meanReversion(nextDifficulty(d, rating))),
    };
  }

  // 旧 SM-2 データ (易しさ・間隔) から記憶状態を近似する
  // (fsrs-rs の memory_state_from_sm2)
  function memoryStateFromSM2(easeFactor, intervalDays, sm2Retention = DEFAULTS.sm2Retention) {
    const dec = decay();
    const f = Math.pow(0.9, 1 / dec) - 1;
    const stability = Math.max(intervalDays, S_MIN) * f /
      (Math.pow(sm2Retention, 1 / dec) - 1);
    const difficulty = 11 - (easeFactor - 1) /
      (Math.exp(W[8]) * Math.pow(stability, -W[9]) *
        (Math.exp((1 - sm2Retention) * W[10]) - 1));
    return { stability: clampS(stability), difficulty: clampD(difficulty) };
  }

  // ---- カードの状態 ----

  function newCardState() {
    return {
      state: 'new',
      stability: 0,
      difficulty: 0,
      intervalDays: 0,
      stepIndex: 0,
      due: 0,          // epoch ms。new カードでは未使用
      lastReview: 0,
      reps: 0,
      lapses: 0,
    };
  }

  // 経過日数 (同日中の再学習は 0 として扱う)
  function elapsedDaysOf(card, now) {
    if (!card.lastReview) return 0;
    return Math.max(0, Math.floor((now - card.lastReview) / DAY));
  }

  function graduate(c, now) {
    c.state = 'review';
    c.stepIndex = 0;
    c.intervalDays = intervalFromStability(c.stability);
    c.due = now + c.intervalDays * DAY;
  }

  // 評価を適用した「次の状態」を返す。card 自体は変更しない。
  function answer(card, rating, now = Date.now()) {
    const c = { ...card };
    c.reps = (c.reps || 0) + 1;

    // 記憶状態は状態にかかわらず毎回更新する (Anki + FSRS と同じ)
    const mem = nextMemoryState(card, rating, elapsedDaysOf(card, now));
    c.stability = mem.stability;
    c.difficulty = mem.difficulty;
    c.lastReview = now;

    const from = card.state === 'new' ? 'new' : card.state;
    const step = card.stepIndex || 0;

    if (from === 'new' || from === 'learning') {
      const steps = DEFAULTS.learningStepsMin;
      if (rating === 1) {
        c.state = 'learning'; c.stepIndex = 0;
        c.due = now + steps[0] * MIN;
      } else if (rating === 4) {
        graduate(c, now);
      } else if (rating === 2) {
        // 難しい: 同じステップをもう一度
        c.state = 'learning';
        c.stepIndex = Math.min(step, steps.length - 1);
        c.due = now + steps[c.stepIndex] * MIN;
      } else {
        const next = step + 1;
        if (next >= steps.length) graduate(c, now);
        else {
          c.state = 'learning'; c.stepIndex = next;
          c.due = now + steps[next] * MIN;
        }
      }
      return c;
    }

    if (from === 'review') {
      if (rating === 1) {
        c.lapses = (c.lapses || 0) + 1;
        c.state = 'relearning';
        c.stepIndex = 0;
        c.due = now + DEFAULTS.relearnStepsMin[0] * MIN;
        // 再学習を終えた後に使う間隔 (FSRS の失敗後の安定度から算出)
        c.intervalDays = intervalFromStability(c.stability);
      } else {
        graduate(c, now);
      }
      return c;
    }

    // relearning
    const steps = DEFAULTS.relearnStepsMin;
    if (rating === 1) {
      c.stepIndex = 0;
      c.due = now + steps[0] * MIN;
    } else if (rating === 4) {
      graduate(c, now);
    } else if (rating === 2) {
      c.stepIndex = Math.min(step, steps.length - 1);
      c.due = now + steps[c.stepIndex] * MIN;
    } else {
      const next = step + 1;
      if (next >= steps.length) graduate(c, now);
      else { c.stepIndex = next; c.due = now + steps[next] * MIN; }
    }
    return c;
  }

  // 評価ボタンに表示する「次の間隔」のプレビュー文字列
  function previewIntervals(card, now = Date.now()) {
    const labels = {};
    for (const rating of [1, 2, 3, 4]) {
      const next = answer(card, rating, now);
      labels[rating] = formatInterval(next.due - now);
    }
    return labels;
  }

  function formatInterval(ms) {
    if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}分`;
    if (ms < DAY) return `${Math.round(ms / (60 * MIN))}時間`;
    const days = Math.round(ms / DAY);
    if (days < 30) return `${days}日`;
    if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}ヶ月`;
    return `${(days / 365).toFixed(1).replace(/\.0$/, '')}年`;
  }

  function isDue(card, now = Date.now()) {
    if (card.state === 'new') return false;
    return card.due <= now;
  }

  // その日の終わり (深夜 4 時区切り。Anki と同様に「1 日」の境界を朝方に置く)
  function dayKey(ts = Date.now()) {
    const d = new Date(ts - 4 * 60 * 60 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 今日中 (次の午前4時まで) に期限が来る review カードも「今日の分」として扱う
  function endOfToday(now = Date.now()) {
    const d = new Date(now - 4 * 60 * 60 * 1000);
    d.setHours(24, 0, 0, 0);
    return d.getTime() + 4 * 60 * 60 * 1000;
  }

  return {
    DEFAULTS, W, MIN, DAY,
    newCardState, answer, previewIntervals, formatInterval, isDue,
    dayKey, endOfToday,
    setRetention, getRetention,
    retrievability, intervalFromStability, memoryStateFromSM2,
  };
})();
