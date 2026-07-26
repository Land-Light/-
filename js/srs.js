/*
 * srs.js — 間隔反復スケジューラ (Anki の SM-2 ベースアルゴリズムを簡略化した実装)
 *
 * カードの状態:
 *   'new'        まだ一度も学習していない
 *   'learning'   学習ステップ中 (分単位の短い間隔)
 *   'review'     復習フェーズ (日単位の間隔)
 *   'relearning' 復習で「もう一度」を押した後の再学習ステップ
 *
 * 評価 (Anki と同じ 4 段階):
 *   1 = もう一度 (Again)
 *   2 = 難しい   (Hard)
 *   3 = 普通     (Good)
 *   4 = 簡単     (Easy)
 */

const SRS = (() => {
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;

  const DEFAULTS = {
    learningStepsMin: [1, 10],   // 学習ステップ (分)
    relearnStepsMin: [10],       // 再学習ステップ (分)
    graduatingIntervalDays: 1,   // 学習ステップ卒業後の間隔
    easyIntervalDays: 4,         // 学習中に「簡単」を押した時の間隔
    startingEase: 2.5,
    minEase: 1.3,
    easyBonus: 1.3,
    hardMultiplier: 1.2,
    lapseMultiplier: 0.5,        // 復習で失敗した後、間隔をこの倍率に縮める
    maxIntervalDays: 36500,
  };

  function newCardState() {
    return {
      state: 'new',
      ease: DEFAULTS.startingEase,
      intervalDays: 0,
      stepIndex: 0,
      due: 0,          // epoch ms。new カードでは未使用
      reps: 0,
      lapses: 0,
    };
  }

  function clampInterval(days) {
    return Math.min(DEFAULTS.maxIntervalDays, Math.max(1, Math.round(days)));
  }

  // 評価を適用した「次の状態」を返す。card 自体は変更しない。
  function answer(card, rating, now = Date.now()) {
    const c = { ...card };
    c.reps = (c.reps || 0) + 1;

    if (c.state === 'new') {
      c.state = 'learning';
      c.stepIndex = 0;
    }

    if (c.state === 'learning' || c.state === 'relearning') {
      const steps = c.state === 'learning'
        ? DEFAULTS.learningStepsMin
        : DEFAULTS.relearnStepsMin;

      if (rating === 1) {
        c.stepIndex = 0;
        c.due = now + steps[0] * MIN;
      } else if (rating === 4) {
        // 卒業 (簡単)
        const wasRelearn = c.state === 'relearning';
        c.state = 'review';
        c.intervalDays = wasRelearn
          ? clampInterval(Math.max(1, c.intervalDays))
          : DEFAULTS.easyIntervalDays;
        c.due = now + c.intervalDays * DAY;
        c.stepIndex = 0;
      } else {
        // 難しい/普通 → 次のステップへ (難しいは同じステップを繰り返す)
        const next = rating === 3 ? c.stepIndex + 1 : c.stepIndex;
        if (next >= steps.length && rating === 3) {
          // 卒業 (普通)
          // 再学習カードの間隔は lapse 時に縮小済みなのでそのまま使う
          const wasRelearn = c.state === 'relearning';
          c.state = 'review';
          c.intervalDays = wasRelearn
            ? clampInterval(Math.max(1, c.intervalDays))
            : DEFAULTS.graduatingIntervalDays;
          c.due = now + c.intervalDays * DAY;
          c.stepIndex = 0;
        } else {
          c.stepIndex = Math.min(next, steps.length - 1);
          c.due = now + steps[c.stepIndex] * MIN;
        }
      }
      return c;
    }

    // review フェーズ
    if (rating === 1) {
      c.lapses = (c.lapses || 0) + 1;
      c.ease = Math.max(DEFAULTS.minEase, c.ease - 0.2);
      c.state = 'relearning';
      c.stepIndex = 0;
      c.due = now + DEFAULTS.relearnStepsMin[0] * MIN;
      // 再学習卒業時に使う縮小済み間隔を保持
      c.intervalDays = clampInterval(c.intervalDays * DEFAULTS.lapseMultiplier);
      return c;
    }

    if (rating === 2) {
      c.ease = Math.max(DEFAULTS.minEase, c.ease - 0.15);
      c.intervalDays = clampInterval(c.intervalDays * DEFAULTS.hardMultiplier);
    } else if (rating === 3) {
      c.intervalDays = clampInterval(c.intervalDays * c.ease);
    } else {
      c.ease = c.ease + 0.15;
      c.intervalDays = clampInterval(c.intervalDays * c.ease * DEFAULTS.easyBonus);
    }
    c.due = now + c.intervalDays * DAY;
    return c;
  }

  // 評価ボタンに表示する「次の間隔」のプレビュー文字列
  function previewIntervals(card, now = Date.now()) {
    const labels = {};
    for (const rating of [1, 2, 3, 4]) {
      const next = answer(card, rating, now);
      const delta = next.due - now;
      labels[rating] = formatInterval(delta);
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

  return { DEFAULTS, MIN, DAY, newCardState, answer, previewIntervals, formatInterval, isDue, dayKey, endOfToday };
})();
