/*
 * store.js — localStorage によるデータ永続化
 *
 * データ構造:
 * {
 *   decks: [{ id, name, createdAt }],
 *   cards: [{ id, deckId, front, back, createdAt, ...SRS状態 }],
 *   settings: { newPerDay },
 *   dayStats: { 'YYYY-MM-DD': { newStudied, reviews } },
 * }
 */

const Store = (() => {
  const KEY = 'flashcards-app-v1';

  let data = null;

  function defaultData() {
    return {
      decks: [],
      cards: [],
      settings: { newPerDay: 20 },
      dayStats: {},
    };
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
    // 欠けているキーを補完 (バージョンアップ時の互換)
    const d = defaultData();
    for (const k of Object.keys(d)) {
      if (data[k] === undefined) data[k] = d[k];
    }
    if (data.settings.newPerDay === undefined) data.settings.newPerDay = 20;
    return data;
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---- デッキ ----

  function addDeck(name) {
    const deck = { id: uid(), name: name.trim(), createdAt: Date.now() };
    load().decks.push(deck);
    save();
    return deck;
  }

  function renameDeck(deckId, name) {
    const deck = load().decks.find(d => d.id === deckId);
    if (deck) { deck.name = name.trim(); save(); }
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

  function addCard(deckId, front, back) {
    const card = {
      id: uid(),
      deckId,
      front: front.trim(),
      back: back.trim(),
      createdAt: Date.now(),
      ...SRS.newCardState(),
    };
    load().cards.push(card);
    save();
    return card;
  }

  function updateCard(cardId, patch) {
    const d = load();
    const i = d.cards.findIndex(c => c.id === cardId);
    if (i >= 0) {
      d.cards[i] = { ...d.cards[i], ...patch };
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

  // ---- 日次統計 ----

  function todayStats() {
    const key = SRS.dayKey();
    const d = load();
    if (!d.dayStats[key]) d.dayStats[key] = { newStudied: 0, reviews: 0 };
    return d.dayStats[key];
  }

  function recordAnswer(wasNew) {
    const s = todayStats();
    s.reviews += 1;
    if (wasNew) s.newStudied += 1;
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
    save();
  }

  // ---- バックアップ ----

  function exportJSON() {
    return JSON.stringify(load(), null, 2);
  }

  function importJSON(json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.decks) || !Array.isArray(parsed.cards)) {
      throw new Error('デッキまたはカードのデータが見つかりません');
    }
    data = parsed;
    const d = defaultData();
    for (const k of Object.keys(d)) {
      if (data[k] === undefined) data[k] = d[k];
    }
    save();
  }

  return {
    load, save,
    addDeck, renameDeck, deleteDeck, getDecks, getDeck,
    addCard, updateCard, deleteCard, getCards, getCard,
    todayStats, recordAnswer, getDayStats,
    getSettings, updateSettings,
    exportJSON, importJSON,
  };
})();
