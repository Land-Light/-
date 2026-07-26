/*
 * sync.js — Google ログインによるデータ同期 (Google Drive appDataFolder)
 *
 * Google Identity Services (GIS) のトークンクライアントでアクセストークンを取得し、
 * Drive の「アプリ専用フォルダ (appDataFolder)」にバックアップ JSON (メディア込み) を
 * 保存・取得する。appDataFolder はこのアプリからしか見えない領域なので、
 * ユーザーの Drive を汚さない。
 *
 * 同期の方向は、ローカルとリモートに埋め込まれた lastModified を比較して
 * 新しい方を採用する (強制アップロード / ダウンロードも可)。
 */

const Sync = (() => {
  const FILE_NAME = 'flashcards-sync.json';
  const CLIENT_ID_KEY = 'flashcards-google-client-id';
  const LAST_SYNC_KEY = 'flashcards-last-sync';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  // 時計のずれを考慮した比較マージン (ms)
  const SKEW = 2000;

  let accessToken = null;

  function getClientId() {
    return localStorage.getItem(CLIENT_ID_KEY) || '';
  }

  function setClientId(id) {
    localStorage.setItem(CLIENT_ID_KEY, id.trim());
  }

  // GIS スクリプトが読み込めているか (オフラインやブロック時は false)
  function isAvailable() {
    return !!(window.google && google.accounts && google.accounts.oauth2);
  }

  function isLoggedIn() {
    return !!accessToken;
  }

  function login() {
    return new Promise((resolve, reject) => {
      if (!isAvailable()) {
        reject(new Error('Google ログインを読み込めませんでした。ネットワーク接続を確認してください。'));
        return;
      }
      const clientId = getClientId();
      if (!clientId) {
        reject(new Error('クライアント ID が設定されていません。'));
        return;
      }
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: resp => {
          if (resp.error) {
            reject(new Error('ログインできませんでした: ' + resp.error));
          } else {
            accessToken = resp.access_token;
            resolve();
          }
        },
        error_callback: err => {
          reject(new Error('ログインがキャンセルされたか、失敗しました。' +
            (err && err.type === 'popup_closed' ? '' : ' (' + (err && err.type || '不明') + ')')));
        },
      });
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function logout() {
    if (accessToken && isAvailable()) {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) { /* 失効済みでも続行 */ }
    }
    accessToken = null;
  }

  async function api(path, opts = {}) {
    const res = await fetch('https://www.googleapis.com' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) },
    });
    if (res.status === 401 || res.status === 403) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401) {
        accessToken = null;
        throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
      }
      throw new Error('Google Drive にアクセスできません (403)。Google Cloud プロジェクトで ' +
        'Drive API が有効になっているか確認してください。' + (detail ? '' : ''));
    }
    if (!res.ok) throw new Error(`Google Drive API エラー (${res.status})`);
    return res;
  }

  async function findRemote() {
    const q = encodeURIComponent(`name='${FILE_NAME}'`);
    const res = await api(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
    const json = await res.json();
    return (json.files && json.files[0]) || null;
  }

  async function downloadRemote(fileId) {
    const res = await api(`/drive/v3/files/${fileId}?alt=media`);
    return res.text();
  }

  async function uploadRemote(fileId, content) {
    if (fileId) {
      await api(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      });
    } else {
      const boundary = 'fcboundary' + Date.now().toString(36);
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        content +
        `\r\n--${boundary}--`;
      await api('/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
    }
  }

  // 同期方向の判定 (純粋関数・テスト用に公開)
  //   'upload'   ローカルの方が新しい / リモートが無い
  //   'download' リモートの方が新しい
  //   'same'     差がマージン以内
  function decideDirection(localTime, remoteTime) {
    if (!remoteTime) return 'upload';
    if (!localTime) return 'download';
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

  // 同期本体。force: 'upload' | 'download' で方向を強制。
  // 戻り値: { action: 'upload'|'download'|'same' }
  async function sync(force = null) {
    if (!isLoggedIn()) throw new Error('先に Google でログインしてください。');

    const remote = await findRemote();
    let remoteData = null;
    let remoteTime = 0;
    if (remote) {
      try {
        remoteData = JSON.parse(await downloadRemote(remote.id));
        remoteTime = remoteData.lastModified || 0;
      } catch (e) {
        remoteData = null; // 壊れたリモートはアップロードで上書き
      }
    }

    let action = force || decideDirection(Store.getLastModified(), remoteTime);
    if (action === 'download' && !remoteData) {
      throw new Error('Google Drive に同期データがまだありません。');
    }

    if (action === 'download') {
      await Store.importJSON(JSON.stringify(remoteData), { touch: false });
    } else if (action === 'upload') {
      const json = await Store.exportJSON();
      await uploadRemote(remote && remote.id, json);
    }
    markSynced();
    return { action };
  }

  return {
    getClientId, setClientId,
    isAvailable, isLoggedIn, login, logout,
    sync, decideDirection, lastSyncTime,
  };
})();
