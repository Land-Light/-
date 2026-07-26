/*
 * app.js — 画面の描画とユーザー操作
 * 画面: decks (ホーム) / study / add / browse / stats / settings
 */

(() => {
  const $ = sel => document.querySelector(sel);
  const app = $('#app');

  const RATING_INFO = {
    1: { label: 'もう一度', cls: 'again', key: '1' },
    2: { label: '難しい', cls: 'hard', key: '2' },
    3: { label: '普通', cls: 'good', key: '3' },
    4: { label: '簡単', cls: 'easy', key: '4' },
  };

  // 現在の学習セッション
  let session = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 改行を <br> に変換した安全な HTML
  function fmt(s) {
    return esc(s).replace(/\n/g, '<br>');
  }

  // ---------------------------------------------------------------
  // デッキごとの学習対象カードの集計
  // ---------------------------------------------------------------

  function deckCounts(deckId) {
    const now = Date.now();
    const eod = SRS.endOfToday(now);
    const cards = Store.getCards(deckId);
    const stats = Store.todayStats();
    const newLimit = Math.max(0, Store.getSettings().newPerDay - stats.newStudied);

    let newCount = 0, learnCount = 0, dueCount = 0;
    for (const c of cards) {
      if (c.state === 'new') newCount++;
      else if (c.state === 'learning' || c.state === 'relearning') {
        if (c.due <= eod) learnCount++;
      } else if (c.state === 'review' && c.due <= eod) dueCount++;
    }
    return { newCount: Math.min(newCount, newLimit), learnCount, dueCount, total: cards.length };
  }

  // 学習キューを構築: 期限切れ learning → review → new の優先順
  function buildQueue(deckId) {
    const now = Date.now();
    const eod = SRS.endOfToday(now);
    const cards = Store.getCards(deckId);
    const stats = Store.todayStats();
    const newLimit = Math.max(0, Store.getSettings().newPerDay - stats.newStudied);

    const learning = cards.filter(c =>
      (c.state === 'learning' || c.state === 'relearning') && c.due <= eod)
      .sort((a, b) => a.due - b.due);
    const review = cards.filter(c => c.state === 'review' && c.due <= eod)
      .sort((a, b) => a.due - b.due);
    const fresh = cards.filter(c => c.state === 'new')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, newLimit);

    return [...learning, ...review, ...fresh];
  }

  // ---------------------------------------------------------------
  // 画面: デッキ一覧 (ホーム)
  // ---------------------------------------------------------------

  function renderDecks() {
    session = null;
    const decks = Store.getDecks();
    const stats = Store.todayStats();

    let rows = '';
    for (const deck of decks) {
      const c = deckCounts(deck.id);
      rows += `
        <div class="deck-row" data-deck="${deck.id}">
          <div class="deck-name">${esc(deck.name)}</div>
          <div class="deck-counts">
            <span class="count new" title="新規">${c.newCount}</span>
            <span class="count learn" title="学習中">${c.learnCount}</span>
            <span class="count due" title="復習">${c.dueCount}</span>
          </div>
          <div class="deck-actions">
            <button class="btn primary btn-study" data-deck="${deck.id}"
              ${c.newCount + c.learnCount + c.dueCount === 0 ? 'disabled' : ''}>学習</button>
            <button class="btn icon btn-deck-menu" data-deck="${deck.id}" title="デッキ操作">⋯</button>
          </div>
        </div>`;
    }

    app.innerHTML = `
      <div class="screen">
        <div class="today-banner">今日の学習: <strong>${stats.reviews}</strong> 回答
          (新規 ${stats.newStudied} / ${Store.getSettings().newPerDay})</div>
        ${decks.length === 0
          ? `<div class="empty">デッキがまだありません。<br>「＋ デッキを追加」から始めましょう。</div>`
          : `<div class="deck-list">
               <div class="deck-header">
                 <span>デッキ</span>
                 <span class="deck-counts-header">
                   <span class="count new">新規</span>
                   <span class="count learn">学習中</span>
                   <span class="count due">復習</span>
                 </span>
                 <span></span>
               </div>${rows}</div>`}
        <button class="btn outline wide" id="btn-add-deck">＋ デッキを追加</button>
      </div>`;

    $('#btn-add-deck').onclick = () => {
      const name = prompt('デッキ名を入力してください:');
      if (name && name.trim()) { Store.addDeck(name); renderDecks(); }
    };
    for (const btn of document.querySelectorAll('.btn-study')) {
      btn.onclick = e => { e.stopPropagation(); startStudy(btn.dataset.deck); };
    }
    for (const btn of document.querySelectorAll('.btn-deck-menu')) {
      btn.onclick = e => { e.stopPropagation(); deckMenu(btn.dataset.deck); };
    }
  }

  function deckMenu(deckId) {
    const deck = Store.getDeck(deckId);
    if (!deck) return;
    const choice = prompt(
      `「${deck.name}」の操作:\n  1 = 名前を変更\n  2 = デッキを削除\n番号を入力してください:`);
    if (choice === '1') {
      const name = prompt('新しいデッキ名:', deck.name);
      if (name && name.trim()) { Store.renameDeck(deckId, name); renderDecks(); }
    } else if (choice === '2') {
      const n = Store.getCards(deckId).length;
      if (confirm(`「${deck.name}」とカード ${n} 枚を削除します。よろしいですか？`)) {
        Store.deleteDeck(deckId);
        renderDecks();
      }
    }
  }

  // ---------------------------------------------------------------
  // 画面: 学習
  // ---------------------------------------------------------------

  function startStudy(deckId) {
    const queue = buildQueue(deckId);
    if (queue.length === 0) { renderDecks(); return; }
    session = { deckId, queue, answered: 0, showingAnswer: false };
    renderStudy();
  }

  function renderStudy() {
    if (!session) { renderDecks(); return; }

    // キューを期限順に維持しつつ、期限が来ていない learning カードしか残って
    // いない場合でも順番に出す (Anki の「先取り」動作)
    if (session.queue.length === 0) {
      const deck = Store.getDeck(session.deckId);
      app.innerHTML = `
        <div class="screen center">
          <div class="finish">🎉</div>
          <h2>お疲れさまでした！</h2>
          <p>「${esc(deck ? deck.name : '')}」の今日の学習が終わりました。<br>
             回答数: ${session.answered} 回</p>
          <button class="btn primary" id="btn-back-home">デッキ一覧へ戻る</button>
        </div>`;
      $('#btn-back-home').onclick = renderDecks;
      session = null;
      return;
    }

    const card = session.queue[0];
    const deck = Store.getDeck(session.deckId);
    const stateLabel = { new: '新規', learning: '学習中', relearning: '再学習', review: '復習' }[card.state];

    if (!session.showingAnswer) {
      app.innerHTML = `
        <div class="screen study">
          <div class="study-meta">
            <span>${esc(deck ? deck.name : '')}</span>
            <span class="badge ${card.state}">${stateLabel}</span>
            <span>残り ${session.queue.length} 枚</span>
          </div>
          <div class="card-face">
            <div class="card-text">${fmt(card.front)}</div>
          </div>
          <button class="btn primary wide" id="btn-show">答えを表示 <kbd>Space</kbd></button>
          <button class="btn text" id="btn-quit">学習を終了</button>
        </div>`;
      $('#btn-show').onclick = showAnswer;
      $('#btn-quit').onclick = renderDecks;
    } else {
      const previews = SRS.previewIntervals(card);
      let buttons = '';
      for (const r of [1, 2, 3, 4]) {
        const info = RATING_INFO[r];
        buttons += `
          <button class="btn rate ${info.cls}" data-rating="${r}">
            <span class="rate-label">${info.label}</span>
            <span class="rate-interval">${previews[r]}</span>
            <kbd>${info.key}</kbd>
          </button>`;
      }
      app.innerHTML = `
        <div class="screen study">
          <div class="study-meta">
            <span>${esc(deck ? deck.name : '')}</span>
            <span class="badge ${card.state}">${stateLabel}</span>
            <span>残り ${session.queue.length} 枚</span>
          </div>
          <div class="card-face">
            <div class="card-text">${fmt(card.front)}</div>
            <hr class="card-divider">
            <div class="card-text answer">${fmt(card.back)}</div>
          </div>
          <div class="rate-row">${buttons}</div>
          <button class="btn text" id="btn-quit">学習を終了</button>
        </div>`;
      for (const btn of document.querySelectorAll('.btn.rate')) {
        btn.onclick = () => rateCard(Number(btn.dataset.rating));
      }
      $('#btn-quit').onclick = renderDecks;
    }
  }

  function showAnswer() {
    if (!session || session.showingAnswer) return;
    session.showingAnswer = true;
    renderStudy();
  }

  function rateCard(rating) {
    if (!session || !session.showingAnswer) return;
    const card = session.queue.shift();
    const wasNew = card.state === 'new';
    const next = SRS.answer(card, rating);
    Store.updateCard(card.id, next);
    Store.recordAnswer(wasNew);
    session.answered += 1;
    session.showingAnswer = false;

    // 学習ステップ中のカードは同じセッション内で再登場させる
    if (next.state === 'learning' || next.state === 'relearning') {
      const updated = Store.getCard(card.id);
      // 期限順で並ぶ位置に挿入 (少なくとも 1 枚は間に挟む)
      let idx = session.queue.findIndex(c => c.due > updated.due);
      if (idx === -1) idx = session.queue.length;
      idx = Math.max(idx, Math.min(1, session.queue.length));
      session.queue.splice(idx, 0, updated);
    }
    renderStudy();
  }

  // ---------------------------------------------------------------
  // 画面: カード追加
  // ---------------------------------------------------------------

  function renderAdd() {
    session = null;
    const decks = Store.getDecks();
    if (decks.length === 0) {
      app.innerHTML = `
        <div class="screen center">
          <p class="empty">カードを追加するには、先にデッキを作成してください。</p>
          <button class="btn primary" id="btn-go-decks">デッキ一覧へ</button>
        </div>`;
      $('#btn-go-decks').onclick = () => nav('decks');
      return;
    }

    const options = decks.map(d =>
      `<option value="${d.id}">${esc(d.name)}</option>`).join('');

    app.innerHTML = `
      <div class="screen">
        <h2>カードを追加</h2>
        <label class="field">
          <span>デッキ</span>
          <select id="add-deck">${options}</select>
        </label>
        <label class="field">
          <span>表面 (質問)</span>
          <textarea id="add-front" rows="3" placeholder="例: りんご を英語で？"></textarea>
        </label>
        <label class="field">
          <span>裏面 (答え)</span>
          <textarea id="add-back" rows="3" placeholder="例: apple"></textarea>
        </label>
        <button class="btn primary wide" id="btn-save-card">追加 <kbd>Ctrl+Enter</kbd></button>
        <div class="hint" id="add-status"></div>

        <details class="import-box">
          <summary>まとめてインポート (タブ区切りテキスト)</summary>
          <p class="hint">1 行 1 カード。「表面（タブ）裏面」の形式で貼り付けてください。</p>
          <textarea id="import-tsv" rows="5" placeholder="りんご を英語で？&#9;apple&#10;みかん を英語で？&#9;orange"></textarea>
          <button class="btn outline" id="btn-import-tsv">インポート</button>
        </details>
      </div>`;

    const saveCard = () => {
      const front = $('#add-front').value.trim();
      const back = $('#add-back').value.trim();
      if (!front || !back) {
        $('#add-status').textContent = '表面と裏面の両方を入力してください。';
        return;
      }
      Store.addCard($('#add-deck').value, front, back);
      $('#add-front').value = '';
      $('#add-back').value = '';
      $('#add-status').textContent = '✓ カードを追加しました';
      $('#add-front').focus();
    };
    $('#btn-save-card').onclick = saveCard;
    app.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveCard(); }
    });

    $('#btn-import-tsv').onclick = () => {
      const lines = $('#import-tsv').value.split('\n').map(l => l.trim()).filter(Boolean);
      let ok = 0, skipped = 0;
      for (const line of lines) {
        const tab = line.indexOf('\t');
        if (tab <= 0) { skipped++; continue; }
        const front = line.slice(0, tab).trim();
        const back = line.slice(tab + 1).trim();
        if (!front || !back) { skipped++; continue; }
        Store.addCard($('#add-deck').value, front, back);
        ok++;
      }
      $('#add-status').textContent =
        `✓ ${ok} 枚をインポートしました${skipped ? ` (${skipped} 行をスキップ)` : ''}`;
      if (ok) $('#import-tsv').value = '';
    };
  }

  // ---------------------------------------------------------------
  // 画面: カードブラウザ
  // ---------------------------------------------------------------

  function renderBrowse() {
    session = null;
    const decks = Store.getDecks();
    const options = ['<option value="">すべてのデッキ</option>',
      ...decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`)].join('');

    app.innerHTML = `
      <div class="screen">
        <h2>カード一覧</h2>
        <div class="browse-controls">
          <select id="browse-deck">${options}</select>
          <input type="search" id="browse-search" placeholder="検索...">
        </div>
        <div id="browse-list"></div>
      </div>`;

    const refresh = () => {
      const deckId = $('#browse-deck').value || null;
      const q = $('#browse-search').value.trim().toLowerCase();
      const deckName = id => { const d = Store.getDeck(id); return d ? d.name : '?'; };
      let cards = Store.getCards(deckId);
      if (q) cards = cards.filter(c =>
        c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
      cards = [...cards].sort((a, b) => b.createdAt - a.createdAt);

      const stateLabel = { new: '新規', learning: '学習中', relearning: '再学習', review: '復習' };
      if (cards.length === 0) {
        $('#browse-list').innerHTML = '<div class="empty">カードが見つかりません。</div>';
        return;
      }
      $('#browse-list').innerHTML = cards.map(c => `
        <div class="browse-row" data-id="${c.id}">
          <div class="browse-main">
            <div class="browse-front">${esc(c.front)}</div>
            <div class="browse-back">${esc(c.back)}</div>
          </div>
          <div class="browse-side">
            <span class="badge ${c.state}">${stateLabel[c.state]}</span>
            <span class="browse-deckname">${esc(deckName(c.deckId))}</span>
            ${c.state === 'review' ? `<span class="browse-due">間隔 ${c.intervalDays}日</span>` : ''}
          </div>
          <div class="browse-actions">
            <button class="btn icon btn-edit" data-id="${c.id}" title="編集">✎</button>
            <button class="btn icon btn-del" data-id="${c.id}" title="削除">🗑</button>
          </div>
        </div>`).join('');

      for (const btn of document.querySelectorAll('.btn-edit')) {
        btn.onclick = () => {
          const card = Store.getCard(btn.dataset.id);
          if (!card) return;
          const front = prompt('表面:', card.front);
          if (front === null) return;
          const back = prompt('裏面:', card.back);
          if (back === null) return;
          if (front.trim() && back.trim()) {
            Store.updateCard(card.id, { front: front.trim(), back: back.trim() });
            refresh();
          }
        };
      }
      for (const btn of document.querySelectorAll('.btn-del')) {
        btn.onclick = () => {
          if (confirm('このカードを削除しますか？')) {
            Store.deleteCard(btn.dataset.id);
            refresh();
          }
        };
      }
    };

    $('#browse-deck').onchange = refresh;
    $('#browse-search').oninput = refresh;
    refresh();
  }

  // ---------------------------------------------------------------
  // 画面: 統計
  // ---------------------------------------------------------------

  function renderStats() {
    session = null;
    const cards = Store.getCards();
    const byState = { new: 0, learning: 0, relearning: 0, review: 0 };
    for (const c of cards) byState[c.state] = (byState[c.state] || 0) + 1;

    // 直近 14 日の学習回数
    const dayStats = Store.getDayStats();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const key = SRS.dayKey(Date.now() - i * SRS.DAY);
      const s = dayStats[key] || { reviews: 0, newStudied: 0 };
      days.push({ key, ...s });
    }
    const maxReviews = Math.max(1, ...days.map(d => d.reviews));
    const bars = days.map(d => `
      <div class="bar-col" title="${d.key}: ${d.reviews} 回答">
        <div class="bar" style="height:${Math.round(d.reviews / maxReviews * 100)}%"></div>
        <div class="bar-label">${d.key.slice(8)}</div>
      </div>`).join('');

    // 今後 7 日の復習予定
    const now = Date.now();
    const forecast = [];
    for (let i = 0; i < 7; i++) {
      const start = SRS.endOfToday(now) + (i - 1) * SRS.DAY;
      const end = start + SRS.DAY;
      const n = cards.filter(c => c.state === 'review' &&
        (i === 0 ? c.due <= end : c.due > start && c.due <= end)).length;
      forecast.push(n);
    }
    const maxF = Math.max(1, ...forecast);
    const fbars = forecast.map((n, i) => `
      <div class="bar-col" title="${i === 0 ? '今日' : `${i}日後`}: ${n} 枚">
        <div class="bar forecast" style="height:${Math.round(n / maxF * 100)}%"></div>
        <div class="bar-label">${i === 0 ? '今日' : `+${i}`}</div>
      </div>`).join('');

    app.innerHTML = `
      <div class="screen">
        <h2>統計</h2>
        <div class="stat-grid">
          <div class="stat-tile"><div class="stat-num">${cards.length}</div><div class="stat-name">総カード数</div></div>
          <div class="stat-tile"><div class="stat-num">${byState.new}</div><div class="stat-name">新規</div></div>
          <div class="stat-tile"><div class="stat-num">${byState.learning + byState.relearning}</div><div class="stat-name">学習中</div></div>
          <div class="stat-tile"><div class="stat-num">${byState.review}</div><div class="stat-name">復習カード</div></div>
        </div>
        <h3>学習履歴 (直近 14 日)</h3>
        <div class="bar-chart">${bars}</div>
        <h3>復習予定 (今後 7 日)</h3>
        <div class="bar-chart">${fbars}</div>
      </div>`;
  }

  // ---------------------------------------------------------------
  // 画面: 設定 / バックアップ
  // ---------------------------------------------------------------

  function renderSettings() {
    session = null;
    const s = Store.getSettings();
    app.innerHTML = `
      <div class="screen">
        <h2>設定</h2>
        <label class="field">
          <span>1 日あたりの新規カード上限</span>
          <input type="number" id="set-new-per-day" min="0" max="999" value="${s.newPerDay}">
        </label>
        <button class="btn primary" id="btn-save-settings">保存</button>
        <div class="hint" id="settings-status"></div>

        <h2>バックアップ</h2>
        <p class="hint">データはこのブラウザの localStorage に保存されています。
          機種変更やブラウザ変更の際は JSON でエクスポートしてください。</p>
        <div class="settings-actions">
          <button class="btn outline" id="btn-export">JSON をエクスポート</button>
          <button class="btn outline" id="btn-import">JSON をインポート</button>
          <input type="file" id="import-file" accept="application/json" hidden>
        </div>
        <div class="hint" id="backup-status"></div>
      </div>`;

    $('#btn-save-settings').onclick = () => {
      const v = Math.max(0, Math.min(999, Number($('#set-new-per-day').value) || 0));
      Store.updateSettings({ newPerDay: v });
      $('#settings-status').textContent = '✓ 保存しました';
    };

    $('#btn-export').onclick = () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `flashcards-backup-${SRS.dayKey()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      $('#backup-status').textContent = '✓ エクスポートしました';
    };

    $('#btn-import').onclick = () => $('#import-file').click();
    $('#import-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm('現在のデータをインポート内容で置き換えます。よろしいですか？')) return;
      try {
        Store.importJSON(await file.text());
        $('#backup-status').textContent = '✓ インポートしました';
        renderSettings();
      } catch (err) {
        $('#backup-status').textContent = `インポートに失敗しました: ${err.message}`;
      }
    };
  }

  // ---------------------------------------------------------------
  // ナビゲーションとキーボード操作
  // ---------------------------------------------------------------

  const SCREENS = {
    decks: renderDecks,
    add: renderAdd,
    browse: renderBrowse,
    stats: renderStats,
    settings: renderSettings,
  };

  function nav(screen) {
    for (const a of document.querySelectorAll('.nav-item')) {
      a.classList.toggle('active', a.dataset.screen === screen);
    }
    (SCREENS[screen] || renderDecks)();
  }

  document.addEventListener('keydown', e => {
    if (!session) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!session.showingAnswer) showAnswer();
      else rateCard(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      rateCard(Number(e.key));
    }
  });

  for (const a of document.querySelectorAll('.nav-item')) {
    a.onclick = e => { e.preventDefault(); nav(a.dataset.screen); };
  }

  // 初回起動時にサンプルデッキを用意
  if (Store.getDecks().length === 0 && !localStorage.getItem('flashcards-app-welcomed')) {
    localStorage.setItem('flashcards-app-welcomed', '1');
    const deck = Store.addDeck('サンプル: 英単語');
    const samples = [
      ['りんご を英語で？', 'apple'],
      ['「改善する」を英語で？', 'improve'],
      ['ephemeral の意味は？', 'つかの間の、短命な'],
      ['「暗記」を英語で？', 'memorization'],
      ['spaced repetition の意味は？', '間隔反復 (復習の間隔を徐々に広げる学習法)'],
    ];
    for (const [f, b] of samples) Store.addCard(deck.id, f, b);
  }

  nav('decks');
})();
