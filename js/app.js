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

  const STATE_LABEL = { new: '新規', learning: '学習中', relearning: '再学習', review: '復習' };
  // 分野プルダウンで「新しい分野を追加…」を表す値 (分野名として使えない文字列)
  const NEW_CATEGORY = '__new_category__';
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  // 現在の学習セッション
  let session = null;
  // デッキ一覧で分野を展開しているデッキ
  const expandedDecks = new Set();

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
  // 穴埋め (Cloze)
  // ---------------------------------------------------------------

  // {{c1::答え}} / {{c1::答え::ヒント}} を描画。
  // index の穴だけを隠し (reveal=false) または強調表示 (reveal=true) する。
  function clozeHTML(text, index, reveal) {
    let out = '', last = 0, m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(text))) {
      out += fmt(text.slice(last, m.index));
      const n = Number(m[1]), ans = m[2], hint = m[3];
      if (n === index) {
        out += reveal
          ? `<span class="cloze revealed">${fmt(ans)}</span>`
          : `<span class="cloze">[${hint ? esc(hint) : '…'}]</span>`;
      } else {
        out += fmt(ans);
      }
      last = CLOZE_RE.lastIndex;
    }
    out += fmt(text.slice(last));
    return out;
  }

  // 穴埋め記法を外したプレーンテキスト (一覧表示用)
  function clozePlain(text) {
    return text.replace(CLOZE_RE, '$2');
  }

  function clozeIndices(text) {
    const set = new Set();
    let m;
    CLOZE_RE.lastIndex = 0;
    while ((m = CLOZE_RE.exec(text))) set.add(Number(m[1]));
    return [...set].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------
  // メディアの表示と再生
  // ---------------------------------------------------------------

  async function mediaHTML(list) {
    const parts = [];
    for (const m of list || []) {
      const u = await Media.url(m.id);
      if (!u) continue;
      if (m.kind === 'image') {
        parts.push(`<img class="card-img" src="${u}" alt="">`);
      } else {
        parts.push(`<button type="button" class="audio-chip" data-audio="${m.id}">🔊 音声を再生</button>`);
      }
    }
    return parts.length ? `<div class="media-row">${parts.join('')}</div>` : '';
  }

  let currentAudio = null;
  let playToken = 0;

  function stopAudio() {
    playToken++;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  }

  async function playAudioId(id) {
    stopAudio();
    const token = playToken;
    const u = await Media.url(id);
    if (!u || token !== playToken) return;
    currentAudio = new Audio(u);
    await new Promise(res => {
      currentAudio.onended = res;
      currentAudio.onerror = res;
      currentAudio.play().catch(res);
    });
  }

  // リスト内の音声を順番に再生 (Anki の自動再生と同じ挙動)
  async function playMediaList(list) {
    const audios = (list || []).filter(m => m.kind === 'audio');
    if (!audios.length) return;
    stopAudio();
    const token = playToken;
    for (const m of audios) {
      if (token !== playToken) return;
      const u = await Media.url(m.id);
      if (!u || token !== playToken) continue;
      currentAudio = new Audio(u);
      await new Promise(res => {
        currentAudio.onended = res;
        currentAudio.onerror = res;
        currentAudio.play().catch(res);
      });
    }
  }

  function bindAudioChips(root = app) {
    for (const btn of root.querySelectorAll('[data-audio]')) {
      btn.onclick = e => { e.stopPropagation(); playAudioId(btn.dataset.audio); };
    }
  }

  // ---------------------------------------------------------------
  // デッキごとの学習対象カードの集計
  // ---------------------------------------------------------------

  function limits() {
    const stats = Store.todayStats();
    const s = Store.getSettings();
    return {
      newLimit: Math.max(0, s.newPerDay - stats.newStudied),
      reviewLimit: Math.max(0, s.reviewsPerDay - stats.reviewStudied),
    };
  }

  // category: null=デッキ全体 / ''=分野未設定のみ / 文字列=その分野のみ
  function deckCounts(deckId, category = null) {
    const eod = SRS.endOfToday();
    const cards = Store.getCardsByCategory(deckId, category);
    const { newLimit, reviewLimit } = limits();

    let newCount = 0, learnCount = 0, dueCount = 0;
    for (const c of cards) {
      if (c.state === 'new') newCount++;
      else if (c.state === 'learning' || c.state === 'relearning') {
        if (c.due <= eod) learnCount++;
      } else if (c.state === 'review' && c.due <= eod) dueCount++;
    }
    return {
      newCount: Math.min(newCount, newLimit),
      learnCount,
      dueCount: Math.min(dueCount, reviewLimit),
      total: cards.length,
    };
  }

  // 学習キューを構築: 期限切れ learning → review → new の優先順
  function buildQueue(deckId, category = null) {
    const eod = SRS.endOfToday();
    const cards = Store.getCardsByCategory(deckId, category);
    const { newLimit, reviewLimit } = limits();

    const learning = cards.filter(c =>
      (c.state === 'learning' || c.state === 'relearning') && c.due <= eod)
      .sort((a, b) => a.due - b.due);
    const review = cards.filter(c => c.state === 'review' && c.due <= eod)
      .sort((a, b) => a.due - b.due)
      .slice(0, reviewLimit);
    const fresh = cards.filter(c => c.state === 'new')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, newLimit);

    return [...learning, ...review, ...fresh];
  }

  // ---------------------------------------------------------------
  // アプリ内ダイアログ
  // iOS の Brave / Safari はページ内の confirm() や prompt() を
  // ブロックすることがあるため、自前のモーダルで代替する。
  // ---------------------------------------------------------------

  function openDialog(bodyHTML, setup) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay dialog-overlay';
      overlay.innerHTML = `<div class="modal dialog">${bodyHTML}</div>`;
      document.body.appendChild(overlay);
      let done = false;
      const close = value => {
        if (done) return;
        done = true;
        overlay.remove();
        resolve(value);
      };
      overlay.onclick = e => { if (e.target === overlay) close(null); };
      setup(overlay, close);
    });
  }

  // はい / いいえの確認。true か false を返す。
  function askConfirm(message, { okLabel = 'OK', danger = false } = {}) {
    return openDialog(`
      <p class="dialog-text">${fmt(message)}</p>
      <div class="modal-actions">
        <button class="btn text" data-act="cancel">キャンセル</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
      </div>`, (overlay, close) => {
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(false);
      overlay.querySelector('[data-act="ok"]').onclick = () => close(true);
    }).then(v => v === true);
  }

  // 1 行テキスト入力。入力値、キャンセル時は null を返す。
  function askText(message, defaultValue = '', { okLabel = 'OK' } = {}) {
    return openDialog(`
      <p class="dialog-text">${fmt(message)}</p>
      <input type="text" class="dialog-input" value="${esc(defaultValue)}">
      <div class="modal-actions">
        <button class="btn text" data-act="cancel">キャンセル</button>
        <button class="btn primary" data-act="ok">${esc(okLabel)}</button>
      </div>`, (overlay, close) => {
      const input = overlay.querySelector('.dialog-input');
      const submit = () => close(input.value);
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(null);
      overlay.querySelector('[data-act="ok"]').onclick = submit;
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') close(null);
      };
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  // 選択肢メニュー。options = [{ label, value, danger }]
  function askChoice(title, options) {
    const buttons = options.map((o, i) =>
      `<button class="btn ${o.danger ? 'danger' : 'outline'} wide dialog-choice" data-i="${i}">${esc(o.label)}</button>`).join('');
    return openDialog(`
      <p class="dialog-text">${fmt(title)}</p>
      ${buttons}
      <div class="modal-actions">
        <button class="btn text" data-act="cancel">キャンセル</button>
      </div>`, (overlay, close) => {
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(null);
      for (const btn of overlay.querySelectorAll('.dialog-choice')) {
        btn.onclick = () => close(options[Number(btn.dataset.i)].value);
      }
    });
  }

  // ---------------------------------------------------------------
  // 画面: デッキ一覧 (ホーム)
  // ---------------------------------------------------------------

  function renderDecks() {
    session = null;
    stopAudio();
    const decks = Store.getDecks();
    const stats = Store.todayStats();

    // 分野行のクリック対象 (分野名は自由入力なので添字で参照する)
    const catRefs = [];

    let rows = '';
    for (const deck of decks) {
      const c = deckCounts(deck.id);
      const cats = Store.getCategories(deck.id);
      const hasUncat = Store.getCards(deck.id).some(x => !x.category);
      const expandable = cats.length > 0;
      const expanded = expandedDecks.has(deck.id);
      rows += `
        <div class="deck-row" data-deck="${deck.id}">
          <div class="deck-name">
            ${expandable
              ? `<button class="cat-toggle" data-deck="${deck.id}"
                   title="分野を表示">${expanded ? '▾' : '▸'}</button>` : ''}
            ${esc(deck.name)}
            ${expandable ? `<span class="cat-count">${cats.length}分野</span>` : ''}
          </div>
          <div class="deck-counts">
            <span class="count new" title="新規">${c.newCount}</span>
            <span class="count learn" title="学習中">${c.learnCount}</span>
            <span class="count due" title="復習">${c.dueCount}</span>
          </div>
          <div class="deck-actions">
            <button class="btn primary btn-study" data-deck="${deck.id}"
              ${c.newCount + c.learnCount + c.dueCount === 0 ? 'disabled' : ''}>学習</button>
            <button class="btn outline btn-cram" data-deck="${deck.id}"
              title="期限に関係なく全カードをランダムに解き続ける"
              ${c.total === 0 ? 'disabled' : ''}>⚡直前</button>
            <button class="btn icon btn-deck-menu" data-deck="${deck.id}" title="デッキ操作">⋯</button>
          </div>
        </div>`;

      if (expanded) {
        const list = [...cats];
        if (hasUncat) list.push(''); // 分野未設定はまとめて最後に
        for (const cat of list) {
          const i = catRefs.push({ deckId: deck.id, category: cat }) - 1;
          const cc = deckCounts(deck.id, cat);
          rows += `
            <div class="deck-row cat-row">
              <div class="deck-name">
                <span class="cat-mark">↳</span>
                ${cat ? esc(cat) : '<span class="cat-none">分野なし</span>'}
                <span class="cat-count">${cc.total}枚</span>
              </div>
              <div class="deck-counts">
                <span class="count new">${cc.newCount}</span>
                <span class="count learn">${cc.learnCount}</span>
                <span class="count due">${cc.dueCount}</span>
              </div>
              <div class="deck-actions">
                <button class="btn primary btn-study-cat" data-i="${i}"
                  ${cc.newCount + cc.learnCount + cc.dueCount === 0 ? 'disabled' : ''}>学習</button>
                <button class="btn outline btn-cram-cat" data-i="${i}"
                  ${cc.total === 0 ? 'disabled' : ''}>⚡直前</button>
                ${cat ? `<button class="btn icon btn-cat-menu" data-i="${i}"
                  title="分野の操作">⋯</button>` : '<span class="cat-menu-space"></span>'}
              </div>
            </div>`;
        }
      }
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

    $('#btn-add-deck').onclick = async () => {
      const name = await askText('デッキ名を入力してください', '', { okLabel: '作成' });
      if (name && name.trim()) { Store.addDeck(name); renderDecks(); }
    };
    for (const btn of document.querySelectorAll('.btn-study')) {
      btn.onclick = e => { e.stopPropagation(); startStudy(btn.dataset.deck); };
    }
    for (const btn of document.querySelectorAll('.btn-cram')) {
      btn.onclick = e => { e.stopPropagation(); startCram(btn.dataset.deck); };
    }
    for (const btn of document.querySelectorAll('.btn-deck-menu')) {
      btn.onclick = e => { e.stopPropagation(); deckMenu(btn.dataset.deck); };
    }
    for (const btn of document.querySelectorAll('.cat-toggle')) {
      btn.onclick = e => {
        e.stopPropagation();
        const id = btn.dataset.deck;
        if (expandedDecks.has(id)) expandedDecks.delete(id);
        else expandedDecks.add(id);
        renderDecks();
      };
    }
    for (const btn of document.querySelectorAll('.btn-study-cat')) {
      btn.onclick = e => {
        e.stopPropagation();
        const r = catRefs[Number(btn.dataset.i)];
        startStudy(r.deckId, r.category);
      };
    }
    for (const btn of document.querySelectorAll('.btn-cram-cat')) {
      btn.onclick = e => {
        e.stopPropagation();
        const r = catRefs[Number(btn.dataset.i)];
        startCram(r.deckId, r.category);
      };
    }
    for (const btn of document.querySelectorAll('.btn-cat-menu')) {
      btn.onclick = e => {
        e.stopPropagation();
        const r = catRefs[Number(btn.dataset.i)];
        categoryMenu(r.deckId, r.category);
      };
    }
  }

  // 分野の操作 (名前の変更・分野の削除)
  async function categoryMenu(deckId, category) {
    const n = Store.getCardsByCategory(deckId, category).length;
    const items = [{ label: '✎ 分野名を変更', value: 'rename' }];
    if (n > 0) items.push({ label: '⚡ この分野を直前モードで解く', value: 'cram' });
    items.push({
      label: n > 0 ? '🗑 分野を削除 (カードは残ります)' : '🗑 分野を削除',
      value: 'delete', danger: true,
    });
    const choice = await askChoice(`分野「${category}」(${n} 枚)`, items);
    if (choice === 'rename') {
      const name = await askText('新しい分野名', category, { okLabel: '変更' });
      if (name !== null && name.trim()) {
        Store.renameCategory(deckId, category, name.trim());
        renderDecks();
      }
    } else if (choice === 'cram') {
      startCram(deckId, category);
    } else if (choice === 'delete') {
      const ok = n > 0
        ? await askConfirm(
            `分野「${category}」を削除します。\n${n} 枚のカードは「分野なし」として残ります。`,
            { okLabel: '削除する', danger: true })
        : true;
      if (ok) {
        if (n > 0) Store.renameCategory(deckId, category, '');
        Store.removeCategory(deckId, category);
        renderDecks();
      }
    }
  }

  async function deckMenu(deckId) {
    const deck = Store.getDeck(deckId);
    if (!deck) return;
    const n = Store.getCards(deckId).length;
    const choice = await askChoice(`「${deck.name}」(${n} 枚)`, [
      { label: '✎ 名前を変更', value: 'rename' },
      { label: '＋ 分野を追加', value: 'addcat' },
      { label: '⚡ 直前モードで解く', value: 'cram' },
      { label: '🗑 デッキを削除', value: 'delete', danger: true },
    ]);
    if (choice === 'rename') {
      const name = await askText('新しいデッキ名', deck.name, { okLabel: '変更' });
      if (name && name.trim()) { Store.renameDeck(deckId, name); renderDecks(); }
    } else if (choice === 'addcat') {
      const name = await askText(
        `「${deck.name}」に追加する分野名\n(カード追加時にプルダウンから選べるようになります)`,
        '', { okLabel: '追加' });
      if (name && name.trim()) {
        Store.addCategory(deckId, name.trim());
        expandedDecks.add(deckId);
        renderDecks();
      }
    } else if (choice === 'cram') {
      startCram(deckId);
    } else if (choice === 'delete') {
      const ok = await askConfirm(
        `「${deck.name}」とカード ${n} 枚を削除します。\nこの操作は取り消せません。`,
        { okLabel: '削除する', danger: true });
      if (ok) {
        Store.deleteDeck(deckId);
        Media.sweep(Store.referencedMediaIds());
        renderDecks();
      }
    }
  }

  // ---------------------------------------------------------------
  // 画面: 学習
  // ---------------------------------------------------------------

  function startStudy(deckId, category = null) {
    const queue = buildQueue(deckId, category);
    if (queue.length === 0) { renderDecks(); return; }
    session = { deckId, category, queue, answered: 0, showingAnswer: false, history: [] };
    renderStudy();
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 直前モード: 期限を無視して全カードをランダム順に出し続ける。
  // 復習スケジュール (SRS 状態) には一切影響しない。
  function startCram(deckId, category = null) {
    const cards = Store.getCardsByCategory(deckId, category);
    if (cards.length === 0) { renderDecks(); return; }
    session = {
      deckId, category, cram: true,
      queue: shuffle(cards),
      total: cards.length,
      round: 1,
      answered: 0, correct: 0,
      showingAnswer: false,
      history: [],
    };
    renderStudy();
  }

  // 分野プルダウンの選択肢を組み立てる (未設定 + 登録済み + 新規追加)
  function optionsForCategories(cats, selected) {
    const sel = cats.includes(selected) ? selected : '';
    return `<option value=""${sel === '' ? ' selected' : ''}>（分野なし）</option>` +
      cats.map(c =>
        `<option value="${esc(c)}"${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('') +
      `<option value="${NEW_CATEGORY}">＋ 新しい分野を追加…</option>`;
  }

  // 長文は左揃え・行間広めで読みやすくする
  function textDiv(raw, html, cls = '') {
    const long = String(raw).length > 60 ? ' long' : '';
    return `<div class="card-text ${cls}${long}">${html}</div>`;
  }

  // カードの表/裏の本文 HTML (メディア込み)
  async function faceHTML(card, showAnswer) {
    if (card.type === 'cloze') {
      let html = textDiv(clozePlain(card.clozeText),
        clozeHTML(card.clozeText, card.clozeIndex, showAnswer));
      html += await mediaHTML(card.frontMedia);
      if (showAnswer && (card.back || (card.backMedia || []).length)) {
        html += `<hr class="card-divider">`;
        if (card.back) html += textDiv(card.back, fmt(card.back), 'extra');
        html += await mediaHTML(card.backMedia);
      }
      return html;
    }
    let html = textDiv(card.front, fmt(card.front));
    html += await mediaHTML(card.frontMedia);
    if (showAnswer) {
      html += `<hr class="card-divider">`;
      html += textDiv(card.back, fmt(card.back), 'answer');
      html += await mediaHTML(card.backMedia);
    }
    return html;
  }

  async function renderStudy() {
    if (!session) { renderDecks(); return; }

    // 直前モードは終わりがない: キューが空になったら次のラウンドへ
    if (session.cram && session.queue.length === 0) {
      session.round += 1;
      session.queue = shuffle(Store.getCardsByCategory(session.deckId, session.category));
      if (session.queue.length === 0) { renderDecks(); return; }
    }

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
    const undoBtn = session.history.length
      ? `<button class="btn icon" id="btn-undo" title="直前の回答を取り消す (Z)">↩</button>` : '';

    const body = await faceHTML(card, session.showingAnswer);

    // 分野を絞って学習中ならデッキ名に併記する
    const scope = esc(deck ? deck.name : '') + (
      session.category === null || session.category === undefined ? ''
        : session.category ? ` <span class="scope-cat">/ ${esc(session.category)}</span>`
        : ' <span class="scope-cat">/ 分野なし</span>');
    const meta = session.cram
      ? `<div class="study-meta">
           <span>${scope}</span>
           <span class="badge cram">⚡直前 ${session.round}周目</span>
           <span class="meta-right">残り ${session.queue.length} / ${session.total} ${undoBtn}</span>
         </div>`
      : `<div class="study-meta">
           <span>${scope}</span>
           <span class="badge ${card.state}">${STATE_LABEL[card.state]}</span>
           <span class="meta-right">残り ${session.queue.length} 枚 ${undoBtn}</span>
         </div>`;
    const quitLabel = session.cram ? '直前モードを終了' : '学習を終了';

    if (!session.showingAnswer) {
      app.innerHTML = `
        <div class="screen study">
          ${meta}
          <div class="card-face">${body}</div>
          <button class="btn primary wide" id="btn-show">答えを表示 <kbd>Space</kbd></button>
          <button class="btn text" id="btn-quit">${quitLabel}</button>
        </div>`;
      $('#btn-show').onclick = showAnswer;
      $('#btn-quit').onclick = renderDecks;
    } else {
      let buttons;
      if (session.cram) {
        // 直前モードは 2 択。スケジュールは変えず、間違えた分だけ周回中に再出題する。
        buttons = `
          <button class="btn rate again cram-rate" data-rating="1">
            <span class="rate-label">できなかった</span>
            <span class="rate-interval">この周でもう一度</span>
            <kbd>1</kbd>
          </button>
          <button class="btn rate good cram-rate" data-rating="3">
            <span class="rate-label">できた</span>
            <span class="rate-interval">次のカードへ</span>
            <kbd>Space</kbd>
          </button>`;
      } else {
        const previews = SRS.previewIntervals(card);
        buttons = '';
        for (const r of [1, 2, 3, 4]) {
          const info = RATING_INFO[r];
          buttons += `
            <button class="btn rate ${info.cls}" data-rating="${r}">
              <span class="rate-label">${info.label}</span>
              <span class="rate-interval">${previews[r]}</span>
              <kbd>${info.key}</kbd>
            </button>`;
        }
      }
      app.innerHTML = `
        <div class="screen study">
          ${meta}
          <div class="card-face">${body}</div>
          <div class="rate-row${session.cram ? ' cram' : ''}">${buttons}</div>
          <button class="btn text" id="btn-quit">${quitLabel}</button>
        </div>`;
      for (const btn of document.querySelectorAll('.btn.rate')) {
        btn.onclick = () => rateCard(Number(btn.dataset.rating));
      }
      $('#btn-quit').onclick = renderDecks;
    }
    bindAudioChips();
    if ($('#btn-undo')) $('#btn-undo').onclick = undoAnswer;

    // 音声の自動再生 (Anki と同じ)
    if (Store.getSettings().autoPlayAudio) {
      playMediaList(session.showingAnswer ? card.backMedia : card.frontMedia);
    }
  }

  function showAnswer() {
    if (!session || session.showingAnswer) return;
    session.showingAnswer = true;
    renderStudy();
  }

  // 現在の面の音声をもう一度再生 (R キー)
  function replayAudio() {
    if (!session || !session.queue.length) return;
    const card = session.queue[0];
    const list = session.showingAnswer
      ? [...(card.frontMedia || []), ...(card.backMedia || [])]
      : card.frontMedia;
    playMediaList(list);
  }

  function rateCard(rating) {
    if (!session || !session.showingAnswer) return;

    // Undo 用スナップショット (回答前の状態)
    session.history.push({
      card: JSON.parse(JSON.stringify(session.queue[0])),
      queue: [...session.queue],
      wasNew: session.queue[0].state === 'new',
      wasReview: session.queue[0].state === 'review',
    });
    if (session.history.length > 20) session.history.shift();

    // 直前モード: SRS 状態も統計も変更しない
    if (session.cram) {
      const card = session.queue.shift();
      session.answered += 1;
      session.showingAnswer = false;
      if (rating === 1) {
        // できなかったカードは同じ周回の後ろの方にランダムに戻す
        const rest = session.queue.length;
        const idx = rest === 0 ? 0
          : Math.min(rest, Math.floor(rest / 2) + Math.floor(Math.random() * (Math.ceil(rest / 2) + 1)));
        session.queue.splice(Math.max(1, idx), 0, card);
      } else {
        session.correct += 1;
      }
      renderStudy();
      return;
    }

    const card = session.queue.shift();
    const snap = session.history[session.history.length - 1];
    const next = SRS.answer(card, rating);
    Store.updateCard(card.id, next);
    Store.recordAnswer(snap.wasNew, snap.wasReview);
    session.answered += 1;
    session.showingAnswer = false;

    // 学習ステップ中のカードは同じセッション内で再登場させる
    if (next.state === 'learning' || next.state === 'relearning') {
      const updated = Store.getCard(card.id);
      let idx = session.queue.findIndex(c => c.due > updated.due);
      if (idx === -1) idx = session.queue.length;
      idx = Math.max(idx, Math.min(1, session.queue.length));
      session.queue.splice(idx, 0, updated);
    }
    renderStudy();
  }

  // 直前の回答を取り消す (Anki の「取り消し」)
  function undoAnswer() {
    if (!session || !session.history.length) return;
    const entry = session.history.pop();

    // 直前モードはキューだけ戻せばよい (カードは変更していない)
    if (session.cram) {
      session.queue = entry.queue.map(c => Store.getCard(c.id) || c);
      session.answered = Math.max(0, session.answered - 1);
      session.showingAnswer = false;
      renderStudy();
      return;
    }

    // SRS 状態のみ巻き戻す (本文編集は保持)
    const { state, ease, intervalDays, stepIndex, due, reps, lapses } = entry.card;
    Store.updateCard(entry.card.id, { state, ease, intervalDays, stepIndex, due, reps, lapses });
    Store.unrecordAnswer(entry.wasNew, entry.wasReview);
    session.answered = Math.max(0, session.answered - 1);
    // キューを回答前の状態に戻す (再挿入されたコピーは除去)
    const restored = entry.queue.map(c => Store.getCard(c.id) || c);
    session.queue = restored;
    session.showingAnswer = false;
    renderStudy();
  }

  // ---------------------------------------------------------------
  // メディア添付ウィジェット (追加画面・編集モーダル共用)
  //   attachMediaControls(container, list) — list を直接書き換える
  // ---------------------------------------------------------------

  // 添付画像を縮小して同期容量を抑える (最大1280px・JPEG)
  async function compressImage(file) {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 300000) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      return blob && blob.size < file.size ? blob : file;
    } catch (e) {
      return file; // 変換できない形式はそのまま
    }
  }

  let recorder = null;
  let recorderStream = null;

  function mediaControlsHTML(side) {
    return `
      <div class="media-controls" data-side="${side}">
        <div class="media-chips"></div>
        <div class="media-buttons">
          <label class="btn outline small">
            🖼 画像/音声を追加
            <input type="file" accept="image/*,audio/*" multiple hidden class="media-file">
          </label>
          <button type="button" class="btn outline small btn-record">🎤 録音</button>
        </div>
      </div>`;
  }

  function attachMediaControls(container, list, onStatus) {
    const chipsEl = container.querySelector('.media-chips');
    const fileEl = container.querySelector('.media-file');
    const recBtn = container.querySelector('.btn-record');

    async function renderChips() {
      let html = '';
      for (const m of list) {
        const u = await Media.url(m.id);
        if (m.kind === 'image' && u) {
          html += `<span class="media-chip"><img src="${u}" alt=""><button type="button" class="chip-del" data-id="${m.id}">✕</button></span>`;
        } else {
          html += `<span class="media-chip audio" data-audio="${m.id}">🔊 ${esc(m.name || '音声')}<button type="button" class="chip-del" data-id="${m.id}">✕</button></span>`;
        }
      }
      chipsEl.innerHTML = html;
      for (const del of chipsEl.querySelectorAll('.chip-del')) {
        del.onclick = e => {
          e.stopPropagation();
          const i = list.findIndex(m => m.id === del.dataset.id);
          if (i >= 0) list.splice(i, 1);
          renderChips();
        };
      }
      for (const chip of chipsEl.querySelectorAll('.media-chip.audio')) {
        chip.onclick = () => playAudioId(chip.dataset.audio);
      }
    }

    async function addFiles(files) {
      for (const file of files) {
        const kind = file.type.startsWith('image/') ? 'image'
          : file.type.startsWith('audio/') ? 'audio' : null;
        if (!kind) continue;
        const blob = kind === 'image' ? await compressImage(file) : file;
        const ref = await Media.add(blob, kind, file.name);
        list.push(ref);
      }
      renderChips();
    }

    fileEl.onchange = async () => {
      await addFiles([...fileEl.files]);
      fileEl.value = '';
    };

    recBtn.onclick = async () => {
      if (recorder) { recorder.stop(); return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        onStatus && onStatus('このブラウザでは録音を利用できません。');
        return;
      }
      try {
        recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        onStatus && onStatus('マイクを使用できません: ' + e.message);
        return;
      }
      const chunks = [];
      recorder = new MediaRecorder(recorderStream);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        recorderStream.getTracks().forEach(t => t.stop());
        recorder = null;
        recorderStream = null;
        recBtn.textContent = '🎤 録音';
        recBtn.classList.remove('recording');
        if (blob.size) {
          const ref = await Media.add(blob, 'audio', '録音');
          list.push(ref);
          renderChips();
        }
      };
      recorder.start();
      recBtn.textContent = '⏹ 録音を停止';
      recBtn.classList.add('recording');
    };

    renderChips();
    return { addFiles, renderChips };
  }

  // ---------------------------------------------------------------
  // 画面: カード追加
  // ---------------------------------------------------------------

  function renderAdd() {
    session = null;
    stopAudio();
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
        <div class="field-row">
          <label class="field">
            <span>デッキ</span>
            <select id="add-deck">${options}</select>
          </label>
          <label class="field">
            <span>ノートタイプ</span>
            <select id="add-type">
              <option value="basic">基本</option>
              <option value="reversed">基本と反転カード</option>
              <option value="cloze">穴埋め (Cloze)</option>
            </select>
          </label>
        </div>

        <div id="fields-basic">
          <label class="field">
            <span>表面 (質問)</span>
            <textarea id="add-front" rows="3" placeholder="例: りんご を英語で？&#10;(画像はここに貼り付けも可)"></textarea>
          </label>
          ${mediaControlsHTML('front')}
          <label class="field">
            <span>裏面 (答え)</span>
            <textarea id="add-back" rows="3" placeholder="例: apple"></textarea>
          </label>
          ${mediaControlsHTML('back')}
        </div>

        <div id="fields-cloze" hidden>
          <label class="field">
            <span>本文 — 隠したい部分を {{c1::答え}} で囲みます ({{c1::答え::ヒント}} も可)</span>
            <textarea id="add-cloze" rows="4" placeholder="例: 日本の首都は {{c1::東京}} で、人口は約 {{c2::1400万}} 人。"></textarea>
          </label>
          <div class="cloze-tools">
            <button type="button" class="btn outline small" id="btn-cloze-same">選択範囲を穴埋め化 (同じ番号)</button>
            <button type="button" class="btn outline small" id="btn-cloze-new">選択範囲を穴埋め化 (新しい番号)</button>
          </div>
          <div class="media-anchor-clozefront"></div>
          <label class="field">
            <span>補足 (裏面に表示・省略可)</span>
            <textarea id="add-extra" rows="2" placeholder="答えと一緒に表示するメモ"></textarea>
          </label>
          <div class="media-anchor-clozeback"></div>
        </div>

        <label class="field">
          <span>分野 (任意 — デッキ内をさらに細かく分類できます。未設定のままでも作成できます)</span>
          <select id="add-category"></select>
        </label>

        <label class="field">
          <span>タグ (スペース区切り・省略可)</span>
          <input type="text" id="add-tags" placeholder="例: 英単語 重要">
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

    // 穴埋め用のメディア欄は basic と共有せず別に持つ
    $('.media-anchor-clozefront').innerHTML = `
      <span class="field-label">本文のメディア</span>${mediaControlsHTML('clozefront')}`;
    $('.media-anchor-clozeback').innerHTML = `
      <span class="field-label">補足のメディア</span>${mediaControlsHTML('clozeback')}`;

    const status = msg => { $('#add-status').textContent = msg; };
    const staged = { front: [], back: [], clozefront: [], clozeback: [] };
    const widgets = {};
    for (const side of Object.keys(staged)) {
      widgets[side] = attachMediaControls(
        $(`.media-controls[data-side="${side}"]`), staged[side], status);
    }

    // 画像のクリップボード貼り付け → フォーカス中の面に添付
    const pasteTarget = {
      'add-front': 'front', 'add-back': 'back',
      'add-cloze': 'clozefront', 'add-extra': 'clozeback',
    };
    app.addEventListener('paste', async e => {
      const side = pasteTarget[e.target && e.target.id];
      if (!side || !e.clipboardData) return;
      const files = [...e.clipboardData.items]
        .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
        .map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      await widgets[side].addFiles(files);
      status('✓ 画像を添付しました');
    });

    $('#add-type').onchange = () => {
      const cloze = $('#add-type').value === 'cloze';
      $('#fields-basic').hidden = cloze;
      $('#fields-cloze').hidden = !cloze;
    };

    // 分野はデッキ・ノートタイプと同じくプルダウンで選ぶ。
    // 一覧にないものは「＋ 新しい分野を追加…」で登録すると次回から選べる。
    const catSelect = $('#add-category');
    let lastCat = '';
    function renderCatSelect(keep) {
      const want = keep !== undefined ? keep : catSelect.value;
      const cats = Store.getCategories($('#add-deck').value);
      catSelect.innerHTML = optionsForCategories(cats, want);
      lastCat = catSelect.value;
    }
    catSelect.onchange = async () => {
      if (catSelect.value !== NEW_CATEGORY) { lastCat = catSelect.value; return; }
      catSelect.value = lastCat; // 「追加…」自体は選択状態にしない
      const name = await askText('新しい分野名を入力してください', '', { okLabel: '追加' });
      if (name && name.trim()) {
        const v = Store.addCategory($('#add-deck').value, name.trim());
        renderCatSelect(v);
        status(`✓ 分野「${v}」を追加しました`);
      }
    };
    $('#add-deck').addEventListener('change', () => renderCatSelect(''));
    renderCatSelect('');

    // 選択範囲を {{cN::...}} で囲む
    function wrapCloze(useNewIndex) {
      const ta = $('#add-cloze');
      const { selectionStart: s, selectionEnd: e, value } = ta;
      if (s === e) { status('穴埋めにする範囲を選択してください。'); return; }
      const existing = clozeIndices(value);
      const n = existing.length === 0 ? 1
        : useNewIndex ? Math.max(...existing) + 1 : Math.max(...existing);
      ta.setRangeText(`{{c${n}::${value.slice(s, e)}}}`, s, e, 'end');
      ta.focus();
    }
    $('#btn-cloze-same').onclick = () => wrapCloze(false);
    $('#btn-cloze-new').onclick = () => wrapCloze(true);

    const parseTags = () =>
      $('#add-tags').value.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);

    const saveCard = () => {
      const deckId = $('#add-deck').value;
      const type = $('#add-type').value;
      const tags = parseTags();
      // プルダウンで選んだ分野 ('' なら分野なし)
      const category = catSelect.value === NEW_CATEGORY ? '' : catSelect.value;

      if (type === 'cloze') {
        const text = $('#add-cloze').value.trim();
        const extra = $('#add-extra').value.trim();
        if (!text) { status('本文を入力してください。'); return; }
        const indices = clozeIndices(text);
        if (indices.length === 0) {
          status('{{c1::答え}} の形式の穴埋めが見つかりません。'); return;
        }
        const noteId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        for (const idx of indices) {
          Store.addCard(deckId, {
            type: 'cloze', noteId, clozeText: text, clozeIndex: idx,
            back: extra, tags, category,
            frontMedia: [...staged.clozefront], backMedia: [...staged.clozeback],
          });
        }
        $('#add-cloze').value = '';
        $('#add-extra').value = '';
        staged.clozefront.length = 0;
        staged.clozeback.length = 0;
        widgets.clozefront.renderChips();
        widgets.clozeback.renderChips();
        status(`✓ 穴埋めカードを ${indices.length} 枚追加しました`
          + (category ? ` (分野: ${category})` : ''));
        renderCatSelect(category);
        $('#add-cloze').focus();
        return;
      }

      const front = $('#add-front').value.trim();
      const back = $('#add-back').value.trim();
      const hasFront = front || staged.front.length;
      const hasBack = back || staged.back.length;
      if (!hasFront || !hasBack) {
        status('表面と裏面の両方に内容 (テキストまたはメディア) を入れてください。');
        return;
      }
      const noteId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      Store.addCard(deckId, {
        type: 'basic', noteId, front, back, tags, category,
        frontMedia: [...staged.front], backMedia: [...staged.back],
      });
      if (type === 'reversed') {
        Store.addCard(deckId, {
          type: 'basic', noteId, front: back, back: front, tags, category,
          frontMedia: [...staged.back], backMedia: [...staged.front],
        });
      }
      $('#add-front').value = '';
      $('#add-back').value = '';
      staged.front.length = 0;
      staged.back.length = 0;
      widgets.front.renderChips();
      widgets.back.renderChips();
      status((type === 'reversed' ? '✓ カードを 2 枚 (表↔裏) 追加しました' : '✓ カードを追加しました')
        + (category ? ` (分野: ${category})` : ''));
      renderCatSelect(category);
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
        Store.addCard($('#add-deck').value, {
          type: 'basic', front, back, tags: parseTags(),
          category: catSelect.value === NEW_CATEGORY ? '' : catSelect.value,
        });
        ok++;
      }
      status(`✓ ${ok} 枚をインポートしました${skipped ? ` (${skipped} 行をスキップ)` : ''}`);
      if (ok) { $('#import-tsv').value = ''; renderCatSelect(catSelect.value); }
    };
  }

  // ---------------------------------------------------------------
  // カード編集モーダル
  // ---------------------------------------------------------------

  function openEditModal(cardId, onSaved) {
    const card = Store.getCard(cardId);
    if (!card) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const frontMedia = [...card.frontMedia];
    const backMedia = [...card.backMedia];

    const bodyFields = card.type === 'cloze' ? `
      <label class="field">
        <span>本文 ({{c${card.clozeIndex}::…}} がこのカードの穴)</span>
        <textarea id="edit-cloze" rows="4">${esc(card.clozeText)}</textarea>
      </label>
      <span class="field-label">本文のメディア</span>
      ${mediaControlsHTML('front')}
      <label class="field">
        <span>補足 (裏面)</span>
        <textarea id="edit-extra" rows="2">${esc(card.back)}</textarea>
      </label>
      <span class="field-label">補足のメディア</span>
      ${mediaControlsHTML('back')}
    ` : `
      <label class="field">
        <span>表面</span>
        <textarea id="edit-front" rows="3">${esc(card.front)}</textarea>
      </label>
      ${mediaControlsHTML('front')}
      <label class="field">
        <span>裏面</span>
        <textarea id="edit-back" rows="3">${esc(card.back)}</textarea>
      </label>
      ${mediaControlsHTML('back')}
    `;

    overlay.innerHTML = `
      <div class="modal">
        <h3>カードを編集</h3>
        ${bodyFields}
        <label class="field">
          <span>分野 (任意)</span>
          <select id="edit-category"></select>
        </label>
        <label class="field">
          <span>タグ (スペース区切り)</span>
          <input type="text" id="edit-tags" value="${esc(card.tags.join(' '))}">
        </label>
        <div class="hint" id="edit-status"></div>
        <div class="modal-actions">
          <button class="btn text" id="edit-cancel">キャンセル</button>
          <button class="btn primary" id="edit-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const status = msg => { overlay.querySelector('#edit-status').textContent = msg; };
    attachMediaControls(overlay.querySelector('.media-controls[data-side="front"]'), frontMedia, status);
    attachMediaControls(overlay.querySelector('.media-controls[data-side="back"]'), backMedia, status);

    // 分野は登録済みの一覧から選ぶ (ここからも新規追加できる)
    const catInput = overlay.querySelector('#edit-category');
    let lastEditCat = card.category || '';
    const fillCats = keep => {
      catInput.innerHTML = optionsForCategories(Store.getCategories(card.deckId), keep);
      lastEditCat = catInput.value;
    };
    fillCats(card.category || '');
    catInput.onchange = async () => {
      if (catInput.value !== NEW_CATEGORY) { lastEditCat = catInput.value; return; }
      catInput.value = lastEditCat;
      const name = await askText('新しい分野名を入力してください', '', { okLabel: '追加' });
      if (name && name.trim()) fillCats(Store.addCategory(card.deckId, name.trim()));
    };

    const close = () => overlay.remove();
    overlay.querySelector('#edit-cancel').onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };

    overlay.querySelector('#edit-save').onclick = () => {
      const tags = overlay.querySelector('#edit-tags').value
        .split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
      const category = catInput.value === NEW_CATEGORY ? '' : catInput.value;
      if (card.type === 'cloze') {
        const text = overlay.querySelector('#edit-cloze').value.trim();
        if (!text || !clozeIndices(text).includes(card.clozeIndex)) {
          status(`本文に {{c${card.clozeIndex}::…}} を残してください。`);
          return;
        }
        Store.updateCard(card.id, {
          clozeText: text,
          back: overlay.querySelector('#edit-extra').value.trim(),
          tags, category, frontMedia, backMedia,
        });
      } else {
        const front = overlay.querySelector('#edit-front').value.trim();
        const back = overlay.querySelector('#edit-back').value.trim();
        if ((!front && !frontMedia.length) || (!back && !backMedia.length)) {
          status('表面と裏面の両方に内容を入れてください。');
          return;
        }
        Store.updateCard(card.id, { front, back, tags, category, frontMedia, backMedia });
      }
      close();
      onSaved && onSaved();
    };
  }

  // ---------------------------------------------------------------
  // 画面: カードブラウザ
  // ---------------------------------------------------------------

  function renderBrowse() {
    session = null;
    stopAudio();
    const decks = Store.getDecks();
    const options = ['<option value="">すべてのデッキ</option>',
      ...decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`)].join('');

    app.innerHTML = `
      <div class="screen">
        <h2>カード一覧</h2>
        <div class="browse-controls">
          <select id="browse-deck">${options}</select>
          <select id="browse-cat"><option value="__all">すべての分野</option></select>
          <input type="search" id="browse-search" placeholder="本文・分野・タグを検索...">
        </div>
        <div id="browse-list"></div>
      </div>`;

    // デッキ選択に応じて分野の選択肢を組み立てる
    const refreshCatOptions = () => {
      const deckId = $('#browse-deck').value || null;
      const sel = $('#browse-cat');
      const prev = sel.value;
      const cats = deckId
        ? Store.getCategories(deckId)
        : [...new Set(Store.getCards().map(c => c.category).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'ja'));
      sel.innerHTML = `<option value="__all">すべての分野</option>` +
        cats.map((c, i) => `<option value="c${i}">${esc(c)}</option>`).join('') +
        `<option value="__none">分野なし</option>`;
      sel.dataset.cats = JSON.stringify(cats);
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    };
    refreshCatOptions();

    const refresh = () => {
      const deckId = $('#browse-deck').value || null;
      const q = $('#browse-search').value.trim().toLowerCase();
      const deckName = id => { const d = Store.getDeck(id); return d ? d.name : '?'; };
      let cards = Store.getCards(deckId);

      // 分野で絞り込み
      const catSel = $('#browse-cat');
      const catList = JSON.parse(catSel.dataset.cats || '[]');
      if (catSel.value === '__none') {
        cards = cards.filter(c => !c.category);
      } else if (catSel.value.startsWith('c')) {
        const name = catList[Number(catSel.value.slice(1))];
        cards = cards.filter(c => c.category === name);
      }

      if (q) {
        cards = cards.filter(c =>
          c.front.toLowerCase().includes(q) ||
          c.back.toLowerCase().includes(q) ||
          c.clozeText.toLowerCase().includes(q) ||
          (c.category || '').toLowerCase().includes(q) ||
          c.tags.some(t => t.toLowerCase().includes(q)));
      }
      cards = [...cards].sort((a, b) => b.createdAt - a.createdAt);

      if (cards.length === 0) {
        $('#browse-list').innerHTML = '<div class="empty">カードが見つかりません。</div>';
        return;
      }
      $('#browse-list').innerHTML = cards.map(c => {
        const frontText = c.type === 'cloze'
          ? `【穴埋め c${c.clozeIndex}】${clozePlain(c.clozeText)}`
          : c.front || '(メディアのみ)';
        const backText = c.type === 'cloze' ? c.back : (c.back || '(メディアのみ)');
        const mediaIcons =
          (c.frontMedia.some(m => m.kind === 'image') || c.backMedia.some(m => m.kind === 'image') ? '🖼' : '') +
          (c.frontMedia.some(m => m.kind === 'audio') || c.backMedia.some(m => m.kind === 'audio') ? '🔊' : '');
        const tagChips = c.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('');
        return `
        <div class="browse-row" data-id="${c.id}">
          <div class="browse-main">
            <div class="browse-front">${esc(frontText)} ${mediaIcons}</div>
            <div class="browse-back">${esc(backText)}</div>
            ${tagChips ? `<div class="browse-tags">${tagChips}</div>` : ''}
          </div>
          <div class="browse-side">
            <span class="badge ${c.state}">${STATE_LABEL[c.state]}</span>
            <span class="browse-deckname">${esc(deckName(c.deckId))}${
              c.category ? ` / ${esc(c.category)}` : ''}</span>
            ${c.state === 'review' ? `<span class="browse-due">間隔 ${c.intervalDays}日</span>` : ''}
          </div>
          <div class="browse-actions">
            <button class="btn icon btn-edit" data-id="${c.id}" title="編集">✎</button>
            <button class="btn icon btn-del" data-id="${c.id}" title="削除">🗑</button>
          </div>
        </div>`;
      }).join('');

      for (const btn of document.querySelectorAll('.btn-edit')) {
        btn.onclick = () => openEditModal(btn.dataset.id, refresh);
      }
      for (const btn of document.querySelectorAll('.btn-del')) {
        btn.onclick = async () => {
          const card = Store.getCard(btn.dataset.id);
          const label = card
            ? (card.type === 'cloze' ? clozePlain(card.clozeText) : card.front).slice(0, 40)
            : '';
          const ok = await askConfirm(
            `このカードを削除しますか？${label ? `\n\n「${label}」` : ''}`,
            { okLabel: '削除する', danger: true });
          if (ok) {
            Store.deleteCard(btn.dataset.id);
            Media.sweep(Store.referencedMediaIds());
            refresh();
          }
        };
      }
    };

    $('#browse-deck').onchange = () => { refreshCatOptions(); refresh(); };
    $('#browse-cat').onchange = refresh;
    $('#browse-search').oninput = refresh;
    refresh();
  }

  // ---------------------------------------------------------------
  // 画面: 統計
  // ---------------------------------------------------------------

  function renderStats() {
    session = null;
    stopAudio();
    const cards = Store.getCards();
    const byState = { new: 0, learning: 0, relearning: 0, review: 0 };
    for (const c of cards) byState[c.state] = (byState[c.state] || 0) + 1;

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
    stopAudio();
    const s = Store.getSettings();
    app.innerHTML = `
      <div class="screen">
        <h2>設定</h2>
        <div class="field-row">
          <label class="field">
            <span>1 日あたりの新規カード上限</span>
            <input type="number" id="set-new-per-day" min="0" max="999" value="${s.newPerDay}">
          </label>
          <label class="field">
            <span>1 日あたりの復習上限</span>
            <input type="number" id="set-reviews-per-day" min="0" max="9999" value="${s.reviewsPerDay}">
          </label>
        </div>
        <label class="check-field">
          <input type="checkbox" id="set-autoplay" ${s.autoPlayAudio ? 'checked' : ''}>
          カード表示時に音声を自動再生する
        </label>
        <button class="btn primary" id="btn-save-settings">保存</button>
        <div class="hint" id="settings-status"></div>

        <h2>バックアップ</h2>
        <p class="hint">カードはブラウザの localStorage、画像・音声は IndexedDB に保存されています。
          機種変更やブラウザ変更の際は JSON (メディア込み) でエクスポートしてください。</p>
        <div class="settings-actions">
          <button class="btn outline" id="btn-export">JSON をエクスポート</button>
          <button class="btn outline" id="btn-import">JSON をインポート</button>
          <input type="file" id="import-file" accept="application/json" hidden>
        </div>
        <div class="hint" id="backup-status"></div>

        <h2>Google 同期</h2>
        <p class="hint">Google アカウントでログインするだけで、カードと画像・音声が
          クラウドに自動同期され、複数の端末で共有できます。設定は不要です。</p>
        <div id="sync-body"></div>
        <div class="hint" id="sync-status"></div>

        <h2>キーボードショートカット</h2>
        <table class="kbd-table">
          <tr><td><kbd>Space</kbd> / <kbd>Enter</kbd></td><td>答えを表示 (表示中は「普通」で回答)</td></tr>
          <tr><td><kbd>1</kbd>〜<kbd>4</kbd></td><td>もう一度 / 難しい / 普通 / 簡単</td></tr>
          <tr><td><kbd>R</kbd></td><td>音声をもう一度再生</td></tr>
          <tr><td><kbd>Z</kbd></td><td>直前の回答を取り消す</td></tr>
        </table>
      </div>`;

    $('#btn-save-settings').onclick = () => {
      Store.updateSettings({
        newPerDay: Math.max(0, Math.min(999, Number($('#set-new-per-day').value) || 0)),
        reviewsPerDay: Math.max(0, Math.min(9999, Number($('#set-reviews-per-day').value) || 0)),
        autoPlayAudio: $('#set-autoplay').checked,
      });
      $('#settings-status').textContent = '✓ 保存しました';
    };

    $('#btn-export').onclick = async () => {
      $('#backup-status').textContent = 'エクスポート中...';
      try {
        const json = await Store.exportJSON();
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `flashcards-backup-${SRS.dayKey()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        $('#backup-status').textContent = '✓ エクスポートしました';
      } catch (err) {
        $('#backup-status').textContent = `エクスポートに失敗しました: ${err.message}`;
      }
    };

    $('#btn-import').onclick = () => $('#import-file').click();
    $('#import-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const ok = await askConfirm(
        '現在のデータ (メディア含む) をインポート内容で置き換えます。よろしいですか？',
        { okLabel: '置き換える', danger: true });
      if (!ok) { e.target.value = ''; return; }
      try {
        await Store.importJSON(await file.text());
        $('#backup-status').textContent = '✓ インポートしました';
        renderSettings();
      } catch (err) {
        $('#backup-status').textContent = `インポートに失敗しました: ${err.message}`;
      }
    };

    renderSyncSection();
  }

  // Google 同期セクション (設定画面内)
  function renderSyncSection() {
    const el = $('#sync-body');
    if (!el) return;
    const setStatus = msg => { const s = $('#sync-status'); if (s) s.textContent = msg; };
    const last = Sync.lastSyncTime();
    const lastText = last ? `最終同期: ${new Date(last).toLocaleString('ja-JP')}` : 'まだ同期していません';

    if (!Sync.isAvailable()) {
      el.innerHTML = `<p class="hint">Google ログインを読み込めませんでした。
        ネットワーク接続を確認してページを再読み込みしてください。</p>`;
      return;
    }

    const user = Sync.currentUser();

    // 未ログイン
    if (!user) {
      el.innerHTML = `
        <div class="settings-actions">
          <button class="btn primary" id="btn-google-login">Google でログイン</button>
        </div>
        <p class="hint">${lastText}</p>`;
      $('#btn-google-login').onclick = async () => {
        setStatus('ログイン中...');
        try {
          await Sync.login();
          setStatus('✓ ログインしました。自動同期を開始します。');
          renderSyncSection();
          Sync.scheduleSync(500);
        } catch (err) {
          setStatus(err.message);
        }
      };
      return;
    }

    // ログイン済み — 自動同期が有効
    const d = Sync.diag();
    el.innerHTML = `
      <p class="sync-account">✓ <strong>${esc(user.email || user.displayName || 'ログイン中')}</strong>
        として自動同期中</p>
      <p class="hint sync-diag">診断: 保存先=${d.mode === 'doc' ? '単一ドキュメント (容量制限あり)' : 'サブコレクション'}
        ・ リアルタイム監視=${d.watching ? 'オン' : 'オフ'}
        ・ ID=${esc(d.uid.slice(0, 8))}…
        ${d.lastError ? `<br>⚠ 直近のエラー: ${esc(d.lastError)}` : ''}</p>
      <div class="settings-actions">
        <button class="btn primary" id="btn-sync-now">今すぐ同期</button>
        <button class="btn outline" id="btn-sync-up" title="この端末のデータでクラウドを上書き">⬆ 強制アップロード</button>
        <button class="btn outline" id="btn-sync-down" title="クラウドのデータでこの端末を上書き">⬇ 強制ダウンロード</button>
        <button class="btn text" id="btn-google-logout">ログアウト</button>
      </div>
      <p class="hint">${lastText} ・ データを変更すると数秒後に自動でアップロードされます。</p>`;

    const runSync = async force => {
      setStatus('同期中...');
      try {
        if (force === 'download' && !await askConfirm(
            'クラウドのデータでこの端末のデータを上書きします。よろしいですか？',
            { okLabel: 'ダウンロード', danger: true })) {
          setStatus(''); return;
        }
        if (force === 'upload' && !await askConfirm(
            'この端末のデータでクラウドのデータを上書きします。よろしいですか？',
            { okLabel: 'アップロード', danger: true })) {
          setStatus(''); return;
        }
        const { action } = await Sync.sync(force);
        const msg = {
          upload: '✓ 同期しました (クラウドへアップロード)',
          download: '✓ 同期しました (クラウドからダウンロード)',
          merge: '✓ 同期しました (両方の端末の内容を統合)',
          same: '✓ すでに最新の状態です',
          busy: '同期処理が実行中です。少し待ってからもう一度お試しください。',
        }[action];
        renderSettings();
        const s = $('#sync-status');
        if (s) s.textContent = msg;
      } catch (err) {
        setStatus(err.message);
      }
    };
    $('#btn-sync-now').onclick = () => runSync(null);
    $('#btn-sync-up').onclick = () => runSync('upload');
    $('#btn-sync-down').onclick = () => runSync('download');
    $('#btn-google-logout').onclick = async () => {
      await Sync.logout();
      renderSyncSection();
      setStatus('ログアウトしました。この端末のデータはそのまま残ります。');
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
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!session.showingAnswer) showAnswer();
      else rateCard(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      // 直前モードは 2 択なので 1 以外は「できた」扱い
      rateCard(session.cram && e.key !== '1' ? 3 : Number(e.key));
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      replayAudio();
    } else if (e.key === 'z' || e.key === 'Z' || ((e.ctrlKey || e.metaKey) && e.key === 'z')) {
      e.preventDefault();
      undoAnswer();
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
    for (const [f, b] of samples) {
      Store.addCard(deck.id, { type: 'basic', front: f, back: b, tags: ['サンプル'] });
    }
    Store.addCard(deck.id, {
      type: 'cloze',
      clozeText: '間隔反復では、覚えているカードほど復習の間隔が {{c1::長く}} なる。',
      clozeIndex: 1,
      back: 'これが Anki 方式の学習法です。',
      tags: ['サンプル'],
    });
  }

  // 参照されていないメディアの掃除 (起動時のみ)
  Media.sweep(Store.referencedMediaIds()).catch(() => {});

  // ---- 自動同期の配線 ----

  // ヘッダーの同期インジケーター
  function updateSyncIndicator(state, detail) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    if (!Sync.isAvailable() || !Sync.isLoggedIn()) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.remove('ok', 'error', 'warn');
    if (state === 'error') {
      el.classList.add('error');
      el.textContent = '⚠ 同期エラー';
      el.title = detail || '設定画面で詳細を確認できます';
    } else if (state === 'warn') {
      el.classList.add('warn');
      el.textContent = '⚠ 一部未同期';
      el.title = detail || '';
    } else {
      el.classList.add('ok');
      const t = new Date();
      el.textContent = `✓ 同期 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      el.title = 'クラウドと同期済み';
    }
  }
  const indicator = document.getElementById('sync-indicator');
  if (indicator) indicator.onclick = () => nav('settings');

  // データが変わったら数秒後に自動アップロード
  Store.setOnChange(() => {
    if (!Sync.isApplying()) Sync.scheduleSync();
  });
  // 学習セッション中はダウンロード適用を延期 (画面が突然変わるのを防ぐ)
  Sync.setGuard(() => !session);
  // 同期結果の反映
  Sync.onStatus(st => {
    if (!st.ok) {
      updateSyncIndicator('error', st.error);
      const s = $('#sync-status');
      if (s) s.textContent = `⚠ 自動同期に失敗しました: ${st.error}`;
      return;
    }
    if (st.mediaOmitted) {
      updateSyncIndicator('warn',
        '容量制限のためカードのみ同期し、画像・音声は同期されていません。README記載のFirestoreルール追加で解除できます。');
    } else {
      updateSyncIndicator('ok');
    }
    if ((st.action === 'download' || st.action === 'merge') && !session) {
      const active = document.querySelector('.nav-item.active');
      nav(active ? active.dataset.screen : 'decks');
      const s = $('#sync-status');
      if (s) s.textContent = '✓ クラウドの最新データを取り込みました';
    }
  });
  // ログイン状態が復元されたら起動時同期
  Sync.onAuthChanged(user => {
    if (user) Sync.scheduleSync(500);
    else updateSyncIndicator();
    if ($('#sync-body')) renderSyncSection();
  });

  nav('decks');
})();
