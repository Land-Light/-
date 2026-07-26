/*
 * sync.js — Google ログインによる自動クラウド同期 (Firebase Auth + Firestore)
 *
 * 既存アプリ (会社法クイズなど) と同じ Firebase プロジェクトを使う。
 * Google でログインするだけで、事前設定なしに同期できる。
 *
 * 保存先:
 *   優先: users/{uid}/flashcards/meta + chunk-N  (サブコレクション。容量制限なし)
 *   代替: users/{uid} ドキュメントの fcData フィールド (merge 書き込み)
 *         — Firestore のルールがサブコレクションを許可していない場合に自動で切替。
 *           1 ドキュメント 1MB 制限があるため、メディアが多いと上限に当たる。
 *
 * 同期の方向は、ローカルとリモートに埋め込まれた lastModified を比較して
 * 新しい方を採用する (強制アップロード / ダウンロードも可)。
 * データ変更後は数秒のデバウンスで自動アップロードする。
 */

const Sync = (() => {
  // 既存アプリ (gh-pages ルートの会社法クイズ) と同じ公開ウェブ設定
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDN5ECeFBJszQhu3Su7Fb9n963AgrgCOUY',
    authDomain: 'test-a7757.firebaseapp.com',
    projectId: 'test-a7757',
    storageBucket: 'test-a7757.firebasestorage.app',
    messagingSenderId: '997078342375',
    appId: '1:997078342375:web:dde122958af05b3d36e042',
  };

  const LAST_SYNC_KEY = 'flashcards-last-sync';
  const MODE_KEY = 'flashcards-sync-mode'; // 'sub' | 'doc'
  const CHUNK = 900000;          // Firestore の 1MB/doc 制限より小さく分割
  const MAX_DOC_FIELD = 900000;  // 単一ドキュメント代替モードの上限
  const SKEW = 2000;             // 時計ずれの許容 (ms)

  let inited = false;
  let applying = false;  // ダウンロード適用中 (変更フックによる再同期を抑制)
  let syncing = false;
  let guard = () => true; // false の間は自動同期を延期 (学習セッション中など)
  let pushTimer = null;
  let statusCb = null;

  function isAvailable() {
    return typeof firebase !== 'undefined' && !!firebase.auth && !!firebase.firestore;
  }

  function init() {
    if (inited) return true;
    if (!isAvailable()) return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      // モバイルでのリダイレクトログインの戻りを処理
      firebase.auth().getRedirectResult().catch(err => {
        if (err && err.code && err.code !== 'auth/no-auth-event') {
          console.warn('ログインエラー:', err.code);
        }
      });
      inited = true;
    } catch (e) {
      console.warn('Firebase の初期化に失敗しました:', e);
    }
    return inited;
  }

  function currentUser() {
    return init() ? firebase.auth().currentUser : null;
  }

  function isLoggedIn() {
    return !!currentUser();
  }

  function onAuthChanged(cb) {
    if (init()) firebase.auth().onAuthStateChanged(cb);
  }

  async function login() {
    if (!init()) {
      throw new Error('Google ログインを読み込めませんでした。ネットワーク接続を確認してください。');
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (err) {
      const code = err && err.code;
      if (code === 'auth/popup-blocked') {
        await firebase.auth().signInWithRedirect(provider);
        return;
      }
      if (code === 'auth/popup-closed-by-user' ||
          code === 'auth/cancelled-popup-request' ||
          code === 'auth/popup-cancelled-by-user') {
        throw new Error('ログインがキャンセルされました。');
      }
      throw new Error('ログインできませんでした: ' + (code || err));
    }
  }

  async function logout() {
    clearTimeout(pushTimer);
    if (init()) await firebase.auth().signOut();
  }

  // ---- Firestore 読み書き ----

  function userDoc() {
    return firebase.firestore().collection('users').doc(currentUser().uid);
  }

  function subCol() {
    return userDoc().collection('flashcards');
  }

  function getMode() {
    return localStorage.getItem(MODE_KEY) || 'sub';
  }

  function setMode(m) {
    localStorage.setItem(MODE_KEY, m);
  }

  function isPermissionError(e) {
    return !!e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');
  }

  // サブコレクションモード
  async function subRead() {
    const meta = await subCol().doc('meta').get();
    if (!meta.exists) return null;
    const { lastModified = 0, chunkCount = 0 } = meta.data() || {};
    if (!chunkCount) return null;
    const snaps = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) => subCol().doc('chunk-' + i).get()));
    let json = '';
    for (const s of snaps) {
      if (!s.exists) return null; // 書き込み途中の不整合はリモート無し扱い
      json += (s.data() || {}).data || '';
    }
    return { json, lastModified };
  }

  async function subWrite(json, lastModified) {
    const prev = await subCol().doc('meta').get();
    const prevCount = prev.exists ? ((prev.data() || {}).chunkCount || 0) : 0;
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    for (let i = 0; i < chunks.length; i++) {
      await subCol().doc('chunk-' + i).set({ data: chunks[i] });
    }
    // meta は最後に書く (読む側は meta → chunk の順なので途中状態を掴みにくい)
    await subCol().doc('meta').set({
      lastModified,
      chunkCount: chunks.length,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    for (let i = chunks.length; i < prevCount; i++) {
      await subCol().doc('chunk-' + i).delete().catch(() => {});
    }
  }

  // 単一ドキュメント代替モード (既存クイズアプリと同じ users/{uid} に merge)
  async function docRead() {
    const snap = await userDoc().get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    if (!d.fcData) return null;
    return { json: d.fcData, lastModified: d.fcModified || 0 };
  }

  async function docWrite(json, lastModified) {
    if (json.length > MAX_DOC_FIELD) {
      throw new Error('データが大きすぎて同期できません (画像・音声の合計が上限を超えています)。' +
        '不要なメディアを削除するか、README 記載の Firestore ルールを追加すると上限を解除できます。');
    }
    await userDoc().set({
      fcData: json,
      fcModified: lastModified,
      fcUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async function remoteRead() {
    if (getMode() === 'doc') return docRead();
    try {
      return await subRead();
    } catch (e) {
      if (isPermissionError(e)) { setMode('doc'); return docRead(); }
      throw e;
    }
  }

  async function remoteWrite(json, lastModified) {
    if (getMode() === 'doc') return docWrite(json, lastModified);
    try {
      return await subWrite(json, lastModified);
    } catch (e) {
      if (isPermissionError(e)) { setMode('doc'); return docWrite(json, lastModified); }
      throw e;
    }
  }

  // ---- 同期本体 ----

  // 前回同期が成立した時点の lastModified (両側で一致していた値)
  const MARKER_KEY = 'flashcards-synced-marker';

  function getMarker() {
    const v = localStorage.getItem(MARKER_KEY);
    return v === null ? null : Number(v);
  }

  function setMarker(v) {
    localStorage.setItem(MARKER_KEY, String(v));
  }

  // 同期方向の判定 (純粋関数・テスト用に公開)
  // marker がある場合は「前回同期からどちらが変わったか」で決める
  // (端末の時計がずれていても正しく動く)。無い場合は時刻比較。
  function decideDirection(localTime, remoteTime, marker = null) {
    if (!remoteTime) return 'upload';
    if (!localTime) return 'download';
    if (marker !== null) {
      const localChanged = localTime !== marker;
      const remoteChanged = remoteTime !== marker;
      if (!localChanged && !remoteChanged) return 'same';
      if (localChanged && !remoteChanged) return 'upload';
      if (!localChanged && remoteChanged) return 'download';
      // 両方変更 (競合) → 新しい方を採用
      return remoteTime > localTime ? 'download' : 'upload';
    }
    if (remoteTime > localTime + SKEW) return 'download';
    if (localTime > remoteTime + SKEW) return 'upload';
    return 'same';
  }

  function lastSyncTime() {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  }

  function markSynced() {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  }

  function isApplying() {
    return applying;
  }

  // force: 'upload' | 'download' | null (自動判定)
  async function sync(force = null) {
    if (!isLoggedIn()) throw new Error('先に Google でログインしてください。');
    if (syncing) return { action: 'busy' };
    syncing = true;
    try {
      const remote = await remoteRead();
      const remoteTime = remote ? remote.lastModified : 0;
      const action = force || decideDirection(Store.getLastModified(), remoteTime, getMarker());
      if (action === 'download') {
        if (!remote) throw new Error('クラウドに同期データがまだありません。');
        applying = true;
        try {
          await Store.importJSON(remote.json, { touch: false });
        } finally {
          applying = false;
        }
        setMarker(remoteTime);
      } else if (action === 'upload') {
        const json = await Store.exportJSON();
        await remoteWrite(json, Store.getLastModified());
        setMarker(Store.getLastModified());
      } else {
        setMarker(Store.getLastModified());
      }
      markSynced();
      return { action };
    } finally {
      syncing = false;
    }
  }

  // ---- 自動同期 ----

  function setGuard(fn) { guard = fn; }
  function onStatus(fn) { statusCb = fn; }

  // データ変更後などに呼ぶ。デバウンスして自動同期。
  function scheduleSync(delay = 4000) {
    if (!isLoggedIn() || applying) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(runAutoSync, delay);
  }

  async function runAutoSync() {
    if (!isLoggedIn() || syncing) return;
    if (!guard()) { scheduleSync(15000); return; } // 学習中はあとで再試行
    try {
      const r = await sync(null);
      if (statusCb) statusCb({ ok: true, action: r.action });
    } catch (e) {
      console.warn('自動同期に失敗しました:', e);
      if (statusCb) statusCb({ ok: false, error: e.message });
    }
  }

  return {
    isAvailable, init, currentUser, isLoggedIn, login, logout, onAuthChanged,
    sync, decideDirection, lastSyncTime, isApplying,
    setGuard, onStatus, scheduleSync,
  };
})();
