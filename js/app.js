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
  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

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

  function deckCounts(deckId) {
    const eod = SRS.endOfToday();
    const cards = Store.getCards(deckId);
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
  function buildQueue(deckId) {
    const eod = SRS.endOfToday();
    const cards = Store.getCards(deckId);
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
  // 画面: デッキ一覧 (ホーム)
  // ---------------------------------------------------------------

  function renderDecks() {
    session = null;
    stopAudio();
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
        Media.sweep(Store.referencedMediaIds());
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
    session = { deckId, queue, answered: 0, showingAnswer: false, history: [] };
    renderStudy();
  }

  // カードの表/裏の本文 HTML (メディア込み)
  async function faceHTML(card, showAnswer) {
    if (card.type === 'cloze') {
      let html = `<div class="card-text">${clozeHTML(card.clozeText, card.clozeIndex, showAnswer)}</div>`;
      html += await mediaHTML(card.frontMedia);
      if (showAnswer && (card.back || (card.backMedia || []).length)) {
        html += `<hr class="card-divider">`;
        if (card.back) html += `<div class="card-text answer extra">${fmt(card.back)}</div>`;
        html += await mediaHTML(card.backMedia);
      }
      return html;
    }
    let html = `<div class="card-text">${fmt(card.front)}</div>`;
    html += await mediaHTML(card.frontMedia);
    if (showAnswer) {
      html += `<hr class="card-divider">`;
      html += `<div class="card-text answer">${fmt(card.back)}</div>`;
      html += await mediaHTML(card.backMedia);
    }
    return html;
  }

  async function renderStudy() {
    if (!session) { renderDecks(); return; }

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

    if (!session.showingAnswer) {
      app.innerHTML = `
        <div class="screen study">
          <div class="study-meta">
            <span>${esc(deck ? deck.name : '')}</span>
            <span class="badge ${card.state}">${STATE_LABEL[card.state]}</span>
            <span class="meta-right">残り ${session.queue.length} 枚 ${undoBtn}</span>
          </div>
          <div class="card-face">${body}</div>
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
            <span class="badge ${card.state}">${STATE_LABEL[card.state]}</span>
            <span class="meta-right">残り ${session.queue.length} 枚 ${undoBtn}</span>
          </div>
          <div class="card-face">${body}</div>
          <div class="rate-row">${buttons}</div>
          <button class="btn text" id="btn-quit">学習を終了</button>
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
        const ref = await Media.add(file, kind, file.name);
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
            back: extra, tags,
            frontMedia: [...staged.clozefront], backMedia: [...staged.clozeback],
          });
        }
        $('#add-cloze').value = '';
        $('#add-extra').value = '';
        staged.clozefront.length = 0;
        staged.clozeback.length = 0;
        widgets.clozefront.renderChips();
        widgets.clozeback.renderChips();
        status(`✓ 穴埋めカードを ${indices.length} 枚追加しました`);
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
        type: 'basic', noteId, front, back, tags,
        frontMedia: [...staged.front], backMedia: [...staged.back],
      });
      if (type === 'reversed') {
        Store.addCard(deckId, {
          type: 'basic', noteId, front: back, back: front, tags,
          frontMedia: [...staged.back], backMedia: [...staged.front],
        });
      }
      $('#add-front').value = '';
      $('#add-back').value = '';
      staged.front.length = 0;
      staged.back.length = 0;
      widgets.front.renderChips();
      widgets.back.renderChips();
      status(type === 'reversed' ? '✓ カードを 2 枚 (表↔裏) 追加しました' : '✓ カードを追加しました');
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
        Store.addCard($('#add-deck').value, { type: 'basic', front, back, tags: parseTags() });
        ok++;
      }
      status(`✓ ${ok} 枚をインポートしました${skipped ? ` (${skipped} 行をスキップ)` : ''}`);
      if (ok) $('#import-tsv').value = '';
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

    const close = () => overlay.remove();
    overlay.querySelector('#edit-cancel').onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };

    overlay.querySelector('#edit-save').onclick = () => {
      const tags = overlay.querySelector('#edit-tags').value
        .split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
      if (card.type === 'cloze') {
        const text = overlay.querySelector('#edit-cloze').value.trim();
        if (!text || !clozeIndices(text).includes(card.clozeIndex)) {
          status(`本文に {{c${card.clozeIndex}::…}} を残してください。`);
          return;
        }
        Store.updateCard(card.id, {
          clozeText: text,
          back: overlay.querySelector('#edit-extra').value.trim(),
          tags, frontMedia, backMedia,
        });
      } else {
        const front = overlay.querySelector('#edit-front').value.trim();
        const back = overlay.querySelector('#edit-back').value.trim();
        if ((!front && !frontMedia.length) || (!back && !backMedia.length)) {
          status('表面と裏面の両方に内容を入れてください。');
          return;
        }
        Store.updateCard(card.id, { front, back, tags, frontMedia, backMedia });
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
          <input type="search" id="browse-search" placeholder="本文・タグを検索...">
        </div>
        <div id="browse-list"></div>
      </div>`;

    const refresh = () => {
      const deckId = $('#browse-deck').value || null;
      const q = $('#browse-search').value.trim().toLowerCase();
      const deckName = id => { const d = Store.getDeck(id); return d ? d.name : '?'; };
      let cards = Store.getCards(deckId);
      if (q) {
        cards = cards.filter(c =>
          c.front.toLowerCase().includes(q) ||
          c.back.toLowerCase().includes(q) ||
          c.clozeText.toLowerCase().includes(q) ||
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
            <span class="browse-deckname">${esc(deckName(c.deckId))}</span>
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
        btn.onclick = () => {
          if (confirm('このカードを削除しますか？')) {
            Store.deleteCard(btn.dataset.id);
            Media.sweep(Store.referencedMediaIds());
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
      if (!confirm('現在のデータ (メディア含む) をインポート内容で置き換えます。よろしいですか？')) return;
      try {
        await Store.importJSON(await file.text());
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
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!session.showingAnswer) showAnswer();
      else rateCard(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      rateCard(Number(e.key));
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

  nav('decks');
})();
