/*
 * notify.js — 復習リマインダー通知
 *
 * Anki のデスクトップ通知に相当する機能をブラウザの Notification API で実装する。
 * サーバー (Push) は使わないため、通知は次のタイミングで出る:
 *   - 設定した時刻になったとき (アプリを開いている / バックグラウンドのタブに残している間)
 *   - アプリを開いたとき、その日の通知時刻を過ぎていて未通知の場合
 * Service Worker 経由で表示するので、タブが裏に回っていても通知は出せる。
 * ブラウザを完全に終了している間は (Push サーバーがないため) 通知できない。
 *
 * iOS / iPadOS は「ホーム画面に追加」した PWA でのみ通知が使える (iOS 16.4 以降)。
 */

const Notify = (() => {
  const LAST_KEY = 'flashcards-last-notified-day';
  const TAG = 'flashcards-review-reminder';

  let swReg = null;
  let timer = null;
  let dueCounter = () => 0;   // アプリ側から「今日の学習対象枚数」を取得する関数

  function supported() {
    return typeof Notification !== 'undefined' &&
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  }

  function permission() {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  // ホーム画面に追加された状態 (PWA) で動いているか
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // iOS はホーム画面に追加しないと通知を許可できない
  function needsInstall() {
    return isIOS() && !isStandalone();
  }

  async function register() {
    if (!supported()) return null;
    // file:// では Service Worker を使えない
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return null;
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
      return swReg;
    } catch (e) {
      console.warn('Service Worker を登録できませんでした:', e);
      return null;
    }
  }

  async function requestPermission() {
    if (typeof Notification === 'undefined') {
      throw new Error('このブラウザは通知に対応していません。');
    }
    if (needsInstall()) {
      throw new Error('iPhone / iPad では、共有ボタンから「ホーム画面に追加」してアプリとして開くと通知を使えます。');
    }
    const res = await Notification.requestPermission();
    if (res !== 'granted') {
      throw new Error(res === 'denied'
        ? '通知がブロックされています。ブラウザの設定でこのサイトの通知を許可してください。'
        : '通知が許可されませんでした。');
    }
    await register();
    return true;
  }

  async function show(title, body) {
    if (permission() !== 'granted') return false;
    const options = {
      body,
      tag: TAG,
      renotify: true,
      requireInteraction: false,
      data: { url: location.href },
    };
    try {
      if (!swReg) swReg = await navigator.serviceWorker.getRegistration();
      if (swReg) { await swReg.showNotification(title, options); return true; }
      new Notification(title, options);
      return true;
    } catch (e) {
      console.warn('通知を表示できませんでした:', e);
      return false;
    }
  }

  // ---- スケジュール ----

  function parseTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '20:00'));
    if (!m) return { h: 20, m: 0 };
    return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
  }

  // 次に通知する時刻 (今日の指定時刻を過ぎていれば明日)
  function nextFireTime(hhmm, now = Date.now()) {
    const { h, m } = parseTime(hhmm);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  function alreadyNotifiedToday(now = Date.now()) {
    return localStorage.getItem(LAST_KEY) === SRS.dayKey(now);
  }

  function markNotified(now = Date.now()) {
    localStorage.setItem(LAST_KEY, SRS.dayKey(now));
  }

  async function fire() {
    const n = dueCounter();
    if (n <= 0) return false;
    markNotified();
    return show('復習の時間です 🃏', `今日の学習カードが ${n} 枚あります。`);
  }

  // アプリのバッジ (対応環境のみ)
  function updateBadge() {
    try {
      const n = dueCounter();
      if (navigator.setAppBadge) {
        if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge();
      }
    } catch (e) { /* 未対応環境では無視 */ }
  }

  // 設定に合わせてタイマーを張り直す。
  // 起動時に「今日の通知時刻を過ぎていて未通知」ならその場で通知する。
  function schedule(settings) {
    clearTimeout(timer);
    timer = null;
    updateBadge();
    if (!settings || !settings.notifyEnabled || permission() !== 'granted') return;

    const now = Date.now();
    const { h, m } = parseTime(settings.notifyTime);
    const todayAt = new Date(now);
    todayAt.setHours(h, m, 0, 0);

    if (now >= todayAt.getTime() && !alreadyNotifiedToday(now)) fire();

    const delay = Math.max(1000, nextFireTime(settings.notifyTime, now) - now);
    // setTimeout の上限 (約24.8日) 未満なので 1 回で足りる
    timer = setTimeout(() => {
      fire();
      schedule(settings); // 翌日ぶんを張り直す
    }, delay);
  }

  function setDueCounter(fn) { dueCounter = fn; }

  function init() {
    if (permission() === 'granted') register();
    // 端末が復帰したときにタイマーのずれを補正する
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) updateBadge();
    });
  }

  return {
    supported, permission, isStandalone, isIOS, needsInstall,
    requestPermission, register, show, schedule, setDueCounter,
    nextFireTime, parseTime, alreadyNotifiedToday, updateBadge, init,
  };
})();
