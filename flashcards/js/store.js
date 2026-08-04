/*
 * store.js — localStorage によるデータ永続化
 *
 * データ構造:
 * {
 *   decks: [{ id, name, createdAt }],
 *   cards: [{
 *     id, noteId, deckId, type ('basic'|'cloze'),
 *     front, back,                  // basic: 表/裏。cloze: back は「補足」
 *     clozeText, clozeIndex,        // cloze のみ
 *     tags: [string],
 *     frontMedia: [{id, kind}], backMedia: [{id, kind}],
 *     createdAt, ...SRS状態
 *   }],
 *   settings: { newPerDay, reviewsPerDay, autoPlayAudio },
 *   dayStats: { 'YYYY-MM-DD': { newStudied, reviews, reviewStudied } },
 * }
 * メディア本体は IndexedDB (media.js) に保存し、ここでは参照のみ持つ。
 */

const Store = (() => {
  const KEY = 'flashcards-app-v1';

  let data = null;

  function defaultData() {
    return {
      decks: [],
      cards: [],
      settings: {
        newPerDay: 20, reviewsPerDay: 200, autoPlayAudio: true,
        desiredRetention: 0.9,
        notifyEnabled: false, notifyTime: '20:00',
      },
      dayStats: {},
      lastModified: 0,
    };
  }

  function migrate(d) {
    const def = defaultData();
    for (const k of Object.keys(def)) {
      if (d[k] === undefined) d[k] = def[k];
    }
    for (const k of Object.keys(def.settings)) {
      if (d.settings[k] === undefined) d.settings[k] = def.settings[k];
    }
    for (const deck of d.decks) {
      if (!deck.updatedAt) deck.updatedAt = deck.createdAt || 0;
      if (!Array.isArray(deck.categories)) deck.categories = [];
    }
    for (const c of d.cards) {
      if (!c.updatedAt) c.updatedAt = c.createdAt || 0;
      if (!c.type) c.type = 'basic';
      if (!c.noteId) c.noteId = c.id;
      if (typeof c.category !== 'string') c.category = '';

      // 旧 SM-2 データ (ease + intervalDays) を FSRS の記憶状態へ移行する
      if (c.stability === undefined) {
        if (c.state === 'review' && c.intervalDays > 0) {
          const m = SRS.memoryStateFromSM2(c.ease || 2.5, c.intervalDays);
          c.stability = m.stability;
          c.difficulty = m.difficulty;
          if (!c.lastReview) c.lastReview = (c.due || Date.now()) - c.intervalDays * SRS.DAY;
        } else {
          // 学習中・再学習中・新規は次の回答で FSRS の初期値から始める
          c.stability = 0;
          c.difficulty = 0;
          if (!c.lastReview) c.lastReview = 0;
        }
        delete c.ease;
      }
      if (c.lastReview === undefined) c.lastReview = 0;
      if (c.difficulty === undefined) c.difficulty = 0;
      if (!Array.isArray(c.tags)) c.tags = [];
      if (!Array.isArray(c.frontMedia)) c.frontMedia = [];
      if (!Array.isArray(c.backMedia)) c.backMedia = [];
      if (c.clozeText === undefined) c.clozeText = '';
      if (c.clozeIndex === undefined) c.clozeIndex = 0;
    }
    return d;
  }

  function load() {
    if (data) return data;
    try {
      const raw = localStorage.getItem(KEY);
      data = raw ? JSON.parse(raw) : defaultData();
    } catch (e) {
      console.error('データの読み込みに失敗しました', e);
      data = defaultData();
    }
    return migrate(data);
  }

  let onChangeCb = null;

  // データ変更時に呼ばれるフック (自動同期のトリガーに使う)
  function setOnChange(cb) {
    onChangeCb = cb;
  }

  // touch=false は同期でのダウンロード時のみ (リモートの更新時刻を保持する)
  // 端末間で時計がずれていても変更が必ず「新しく」なるよう単調増加させる
  function save(touch = true) {
    if (touch) data.lastModified = Math.max(Date.now(), (data.lastModified || 0) + 1);
    localStorage.setItem(KEY, JSON.stringify(data));
    if (onChangeCb) onChangeCb();
  }

  function getLastModified() {
    return load().lastModified || 0;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---- デッキ ----

  function addDeck(name) {
    const deck = {
      id: uid(), name: name.trim(), categories: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    load().decks.push(deck);
    save();
    return deck;
  }

  function renameDeck(deckId, name) {
    const deck = load().decks.find(d => d.id === deckId);
    if (deck) { deck.name = name.trim(); deck.updatedAt = Date.now(); save(); }
  }

  function deleteDeck(deckId) {
    const d = load();
    d.decks = d.decks.filter(x => x.id !== deckId);
    d.cards = d.cards.filter(c => c.deckId !== deckId);
    save();
  }

  function getDecks() {
    return load().decks;
  }

  function getDeck(deckId) {
    return load().decks.find(d => d.id === deckId) || null;
  }

  // ---- カード ----

  function addCard(deckId, fields) {
    const card = {
      id: uid(),
      noteId: '',
      deckId,
      type: 'basic',
      front: '', back: '',
      clozeText: '', clozeIndex: 0,
      category: '',
      tags: [],
      frontMedia: [], backMedia: [],
      createdAt: Date.now(),
      ...fields,
      ...SRS.newCardState(),
      updatedAt: Date.now(),
    };
    if (!card.noteId) card.noteId = card.id;
    load().cards.push(card);
    save();
    return card;
  }

  function updateCard(cardId, patch) {
    const d = load();
    const i = d.cards.findIndex(c => c.id === cardId);
    if (i >= 0) {
      d.cards[i] = { ...d.cards[i], ...patch, updatedAt: Date.now() };
      save();
      return d.cards[i];
    }
    return null;
  }

  function deleteCard(cardId) {
    const d = load();
    d.cards = d.cards.filter(c => c.id !== cardId);
    save();
  }

  function getCards(deckId = null) {
    const cards = load().cards;
    return deckId ? cards.filter(c => c.deckId === deckId) : cards;
  }

  function getCard(cardId) {
    return load().cards.find(c => c.id === cardId) || null;
  }

  // ---- 分野 (デッキ内の細分類。未設定は '' として扱う) ----

  // 選択肢に出す分野名の一覧。
  // デッキに登録した分野 + 実際にカードで使われている分野の和集合。
  function getCategories(deckId) {
    const set = new Set();
    const deck = getDeck(deckId);
    if (deck) for (const c of deck.categories || []) { if (c) set.add(c); }
    for (const c of getCards(deckId)) {
      if (c.category) set.add(c.category);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  // 分野をデッキに登録する (カードがなくても選択肢に残る)。登録名を返す。
  function addCategory(deckId, name) {
    const v = name.trim();
    // '__new_category__' は選択肢の「新しい分野を追加…」に使う予約語
    if (!v || v === '__new_category__') return '';
    const deck = getDeck(deckId);
    if (!deck) return '';
    if (!deck.categories.includes(v)) {
      deck.categories.push(v);
      deck.updatedAt = Date.now();
      save();
    }
    return v;
  }

  // 登録簿から分野を取り除く (カードの分野は変更しない)
  function removeCategory(deckId, name) {
    const deck = getDeck(deckId);
    if (!deck) return;
    const i = deck.categories.indexOf(name);
    if (i >= 0) {
      deck.categories.splice(i, 1);
      deck.updatedAt = Date.now();
      save();
    }
  }

  // category: null なら全件、'' なら分野未設定のみ、文字列ならその分野のみ
  function getCardsByCategory(deckId, category = null) {
    const cards = getCards(deckId);
    if (category === null) return cards;
    return cards.filter(c => (c.category || '') === category);
  }

  // 分野名の一括変更 (空文字にすると分野なしへ移動)。登録簿も併せて更新する。
  function renameCategory(deckId, from, to) {
    const d = load();
    const name = to.trim();
    let n = 0;
    for (const c of d.cards) {
      if (c.deckId === deckId && (c.category || '') === from) {
        c.category = name;
        c.updatedAt = Date.now();
        n++;
      }
    }
    const deck = getDeck(deckId);
    if (deck) {
      const i = deck.categories.indexOf(from);
      if (i >= 0) deck.categories.splice(i, 1);
      if (name && !deck.categories.includes(name)) deck.categories.push(name);
      deck.updatedAt = Date.now();
    }
    save();
    return n;
  }

  // 全カードが参照しているメディア id の集合
  function referencedMediaIds() {
    const ids = new Set();
    for (const c of load().cards) {
      for (const m of c.frontMedia) ids.add(m.id);
      for (const m of c.backMedia) ids.add(m.id);
    }
    return ids;
  }

  // ---- 日次統計 ----

  function todayStats() {
    const key = SRS.dayKey();
    const d = load();
    if (!d.dayStats[key]) d.dayStats[key] = { newStudied: 0, reviews: 0, reviewStudied: 0 };
    const s = d.dayStats[key];
    if (s.reviewStudied === undefined) s.reviewStudied = 0;
    return s;
  }

  function recordAnswer(wasNew, wasReview) {
    const s = todayStats();
    s.reviews += 1;
    if (wasNew) s.newStudied += 1;
    if (wasReview) s.reviewStudied += 1;
    save();
  }

  // 回答の取り消し (Undo) 用
  function unrecordAnswer(wasNew, wasReview) {
    const s = todayStats();
    s.reviews = Math.max(0, s.reviews - 1);
    if (wasNew) s.newStudied = Math.max(0, s.newStudied - 1);
    if (wasReview) s.reviewStudied = Math.max(0, s.reviewStudied - 1);
    save();
  }

  function getDayStats() {
    return load().dayStats;
  }

  // ---- 設定 ----

  function getSettings() {
    return load().settings;
  }

  function updateSettings(patch) {
    Object.assign(load().settings, patch);
    if (patch.desiredRetention !== undefined) SRS.setRetention(patch.desiredRetention);
    save();
  }

  // ---- バックアップ (メディア込み) ----

  // includeMedia=false は同期の容量制限時の縮退用。mediaOmitted フラグを立て、
  // 受信側はローカルのメディアをそのまま保持する。
  async function exportJSON(includeMedia = true) {
    if (!includeMedia) {
      return JSON.stringify({ ...load(), media: [], mediaOmitted: true });
    }
    const media = await Media.exportAll();
    return JSON.stringify({ ...load(), media });
  }

  async function importJSON(json, { touch = true } = {}) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.decks) || !Array.isArray(parsed.cards)) {
      throw new Error('デッキまたはカードのデータが見つかりません');
    }
    const media = parsed.media || [];
    const mediaOmitted = !!parsed.mediaOmitted;
    delete parsed.media;
    delete parsed.mediaOmitted;
    data = migrate(parsed);
    save(touch);
    // メディア省略データの場合はローカルのメディアをそのまま残す
    if (!mediaOmitted) await Media.importAll(media);
  }

  return {
    load, save, getLastModified, setOnChange,
    addDeck, renameDeck, deleteDeck, getDecks, getDeck,
    addCard, updateCard, deleteCard, getCards, getCard,
    getCategories, getCardsByCategory, addCategory, removeCategory, renameCategory,
    referencedMediaIds,
    todayStats, recordAnswer, unrecordAnswer, getDayStats,
    getSettings, updateSettings,
    exportJSON, importJSON,
  };
})();
