/*
 * media.js — 画像・音声ファイルの保存 (IndexedDB)
 *
 * localStorage は容量が小さい (約5MB) ため、メディアは IndexedDB に
 * Blob のまま保存し、カード側には { id, kind } の参照だけを持たせる。
 * kind: 'image' | 'audio'
 */

const Media = (() => {
  const DB_NAME = 'flashcards-media-v1';
  const STORE = 'media';

  let dbPromise = null;
  const urlCache = new Map(); // id -> objectURL

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function uid() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function putRecord(record) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getRecord(id) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function allRecords() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(id) {
    const d = await db();
    if (urlCache.has(id)) {
      URL.revokeObjectURL(urlCache.get(id));
      urlCache.delete(id);
    }
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // Blob を保存して参照 ({ id, kind, name }) を返す
  async function add(blob, kind, name = '') {
    const id = uid();
    await putRecord({ id, kind, name, type: blob.type || '', blob });
    return { id, kind, name };
  }

  // 表示用の objectURL (キャッシュ付き)。存在しなければ null。
  async function url(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const rec = await getRecord(id);
    if (!rec) return null;
    const u = URL.createObjectURL(rec.blob);
    urlCache.set(id, u);
    return u;
  }

  // どのカードからも参照されていないメディアを削除
  async function sweep(referencedIds) {
    const records = await allRecords();
    for (const rec of records) {
      if (!referencedIds.has(rec.id)) await remove(rec.id);
    }
  }

  // ---- バックアップ用 (base64 変換) ----

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',', 2)[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function exportAll() {
    const records = await allRecords();
    const out = [];
    for (const rec of records) {
      out.push({
        id: rec.id, kind: rec.kind, name: rec.name, type: rec.type,
        data: await blobToBase64(rec.blob),
      });
    }
    return out;
  }

  async function importAll(list) {
    // インポートは全置き換え
    const existing = await allRecords();
    for (const rec of existing) await remove(rec.id);
    for (const item of list || []) {
      await putRecord({
        id: item.id, kind: item.kind, name: item.name || '', type: item.type || '',
        blob: base64ToBlob(item.data, item.type || ''),
      });
    }
  }

  return { add, url, remove, sweep, exportAll, importAll, getRecord };
})();
