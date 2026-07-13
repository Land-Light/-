import { ROOM_RETENTION_DAYS, MS_PER_DAY, toInt } from "./util.js";

const FIREBASE_SDK_VERSION = "12.16.0";
const sdkUrl = (name) => `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/${name}`;

const productDocId = (jan) => encodeURIComponent(String(jan));

// クラウド(Firestore)とローカル(localStorage)を同じインターフェースで扱うデータ層。
// 書き込みは投げっぱなしにでき、変化は onProducts / onEntries コールバックで届く。
export function createStore({ onProducts, onEntries, onStatus }) {
  let backend = null;

  async function init(config) {
    if (config?.projectId && config?.apiKey) {
      try {
        backend = await createFirestoreBackend(config, { onProducts, onEntries, onStatus });
        return "cloud";
      } catch (error) {
        console.error("Firestore init failed", error);
        onStatus?.(`クラウド接続失敗: ${error.message}`, "danger");
      }
    }
    backend = createLocalBackend({ onProducts, onEntries, onStatus });
    return "local";
  }

  return {
    init,
    mode: () => backend?.mode || "none",
    joinRoom: (...args) => backend.joinRoom(...args),
    leaveRoom: (...args) => backend.leaveRoom(...args),
    saveProduct: (...args) => backend.saveProduct(...args),
    saveProducts: (...args) => backend.saveProducts(...args),
    deleteProduct: (...args) => backend.deleteProduct(...args),
    saveEntry: (...args) => backend.saveEntry(...args),
    saveEntries: (...args) => backend.saveEntries(...args),
    deleteEntry: (...args) => backend.deleteEntry(...args),
    purgeRoom: (...args) => backend.purgeRoom(...args)
  };
}

async function createFirestoreBackend(config, { onProducts, onEntries, onStatus }) {
  const { initializeApp } = await import(sdkUrl("firebase-app.js"));
  const firestore = await import(sdkUrl("firebase-firestore.js"));
  const {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, collection, getDoc, getDocs, getDocFromCache, setDoc, deleteDoc,
    onSnapshot, writeBatch, query, limit, Timestamp
  } = firestore;

  const app = initializeApp(config);
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (error) {
    // 永続キャッシュ非対応環境(プライベートブラウズ等)はメモリキャッシュで続行。
    db = initializeFirestore(app, {});
  }

  let roomId = "";
  let unsubscribers = [];
  let roomExpiresAt = null;

  const roomRef = (id) => doc(db, "rooms", id);
  const productsCol = (id) => collection(db, "rooms", id, "products");
  const entriesCol = (id) => collection(db, "rooms", id, "entries");

  function expiresTimestamp() {
    return roomExpiresAt || Timestamp.fromMillis(Date.now() + ROOM_RETENTION_DAYS * MS_PER_DAY);
  }

  async function purgeRoom(id) {
    for (const col of [productsCol(id), entriesCol(id)]) {
      for (;;) {
        const snap = await getDocs(query(col, limit(200)));
        if (snap.empty) break;
        const batch = writeBatch(db);
        snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
        await batch.commit();
        if (snap.size < 200) break;
      }
    }
    await deleteDoc(roomRef(id));
  }

  async function ensureRoom(id) {
    let snap = null;
    try {
      snap = await getDoc(roomRef(id));
    } catch (error) {
      try {
        snap = await getDocFromCache(roomRef(id));
      } catch (cacheError) {
        snap = null;
      }
    }
    if (snap?.exists()) {
      const expires = snap.data().expiresAt;
      if (expires?.toMillis && expires.toMillis() <= Date.now()) {
        onStatus?.("期限切れの部屋データを削除しています…", "muted");
        await purgeRoom(id).catch(() => null);
      } else {
        roomExpiresAt = expires?.toMillis ? expires : null;
        return;
      }
    }
    roomExpiresAt = Timestamp.fromMillis(Date.now() + ROOM_RETENTION_DAYS * MS_PER_DAY);
    setDoc(roomRef(id), {
      createdAt: new Date().toISOString(),
      expiresAt: roomExpiresAt
    }).catch(() => null);
  }

  async function joinRoom(id) {
    leaveRoom();
    roomId = id;
    roomExpiresAt = null;
    await ensureRoom(id);

    const productsUnsub = onSnapshot(productsCol(id), { includeMetadataChanges: true }, (snap) => {
      const products = snap.docs.map((docSnap) => {
        const data = docSnap.data();
        return { jan: data.jan, name: data.name, expected: toInt(data.expected) };
      });
      onProducts?.(products);
      reportPending(snap);
    }, (error) => onStatus?.(`同期失敗: ${error.message}`, "danger"));

    const entriesUnsub = onSnapshot(entriesCol(id), { includeMetadataChanges: true }, (snap) => {
      const entries = snap.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          deviceId: data.deviceId,
          userName: data.userName,
          jan: data.jan,
          shelfNo: data.shelfNo,
          qty: toInt(data.qty),
          createdAt: data.createdAt,
          updatedAt: data.updatedAt
        };
      });
      onEntries?.(entries);
      reportPending(snap);
    }, (error) => onStatus?.(`同期失敗: ${error.message}`, "danger"));

    unsubscribers = [productsUnsub, entriesUnsub];
    return { expiresAtMillis: roomExpiresAt?.toMillis?.() || 0 };
  }

  function reportPending(snap) {
    if (snap.metadata.hasPendingWrites || !navigator.onLine) {
      onStatus?.("端末に保存済み・送信待ち", "muted");
    } else if (snap.metadata.fromCache) {
      onStatus?.("キャッシュ表示・接続待ち", "muted");
    } else {
      onStatus?.("リアルタイム同期中", "ok");
    }
  }

  function leaveRoom() {
    unsubscribers.forEach((unsub) => unsub());
    unsubscribers = [];
    roomId = "";
    roomExpiresAt = null;
  }

  function saveProduct(product) {
    if (!roomId) return;
    setDoc(doc(productsCol(roomId), productDocId(product.jan)), {
      jan: product.jan,
      name: product.name,
      expected: toInt(product.expected),
      updatedAt: new Date().toISOString(),
      expiresAt: expiresTimestamp()
    }).catch((error) => onStatus?.(`保存失敗: ${error.message}`, "danger"));
  }

  async function saveProducts(products) {
    if (!roomId || !products.length) return;
    const chunkSize = 400;
    for (let i = 0; i < products.length; i += chunkSize) {
      const batch = writeBatch(db);
      products.slice(i, i + chunkSize).forEach((product) => {
        batch.set(doc(productsCol(roomId), productDocId(product.jan)), {
          jan: product.jan,
          name: product.name,
          expected: toInt(product.expected),
          updatedAt: new Date().toISOString(),
          expiresAt: expiresTimestamp()
        });
      });
      batch.commit().catch((error) => onStatus?.(`保存失敗: ${error.message}`, "danger"));
    }
  }

  async function deleteProduct(jan, relatedEntryIds = []) {
    if (!roomId) return;
    const batch = writeBatch(db);
    batch.delete(doc(productsCol(roomId), productDocId(jan)));
    relatedEntryIds.forEach((entryId) => batch.delete(doc(entriesCol(roomId), entryId)));
    batch.commit().catch((error) => onStatus?.(`削除失敗: ${error.message}`, "danger"));
  }

  function saveEntry(entry) {
    if (!roomId) return;
    setDoc(doc(entriesCol(roomId), entry.id), {
      deviceId: entry.deviceId,
      userName: entry.userName,
      jan: entry.jan,
      shelfNo: entry.shelfNo,
      qty: toInt(entry.qty),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt || entry.createdAt,
      expiresAt: expiresTimestamp()
    }).catch((error) => onStatus?.(`保存失敗: ${error.message}`, "danger"));
  }

  function saveEntries(entries) {
    entries.forEach(saveEntry);
  }

  function deleteEntry(entryId) {
    if (!roomId) return;
    deleteDoc(doc(entriesCol(roomId), entryId))
      .catch((error) => onStatus?.(`削除失敗: ${error.message}`, "danger"));
  }

  return {
    mode: "cloud",
    joinRoom,
    leaveRoom,
    saveProduct,
    saveProducts,
    deleteProduct,
    saveEntry,
    saveEntries,
    deleteEntry,
    purgeRoom
  };
}

function createLocalBackend({ onProducts, onEntries, onStatus }) {
  const localKey = (id) => `inventory-room:${id}`;
  let roomId = "";
  let data = { createdAt: "", products: [], entries: [] };

  function load(id) {
    try {
      const saved = JSON.parse(localStorage.getItem(localKey(id)) || "{}");
      return {
        createdAt: saved.createdAt || "",
        products: Array.isArray(saved.products) ? saved.products : [],
        entries: Array.isArray(saved.entries) ? saved.entries : []
      };
    } catch (error) {
      return { createdAt: "", products: [], entries: [] };
    }
  }

  function persist() {
    if (!roomId) return;
    localStorage.setItem(localKey(roomId), JSON.stringify(data));
  }

  function emit() {
    onProducts?.([...data.products]);
    onEntries?.([...data.entries]);
    onStatus?.("この端末のみ(クラウド未設定)", "muted");
  }

  function pruneExpired() {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("inventory-room:"))
      .forEach((key) => {
        try {
          const saved = JSON.parse(localStorage.getItem(key) || "{}");
          const created = Date.parse(saved.createdAt || "");
          if (Number.isFinite(created) && created + ROOM_RETENTION_DAYS * MS_PER_DAY <= Date.now()) {
            localStorage.removeItem(key);
          }
        } catch (error) {
          localStorage.removeItem(key);
        }
      });
  }

  return {
    mode: "local",
    async joinRoom(id) {
      pruneExpired();
      roomId = id;
      data = load(id);
      if (!data.createdAt) {
        data.createdAt = new Date().toISOString();
        persist();
      }
      queueMicrotask(emit);
      return { expiresAtMillis: Date.parse(data.createdAt) + ROOM_RETENTION_DAYS * MS_PER_DAY };
    },
    leaveRoom() {
      persist();
      roomId = "";
    },
    saveProduct(product) {
      const index = data.products.findIndex((item) => item.jan === product.jan);
      if (index >= 0) data.products[index] = { ...product };
      else data.products.push({ ...product });
      persist();
      emit();
    },
    async saveProducts(products) {
      products.forEach((product) => {
        const index = data.products.findIndex((item) => item.jan === product.jan);
        if (index >= 0) data.products[index] = { ...product };
        else data.products.push({ ...product });
      });
      persist();
      emit();
    },
    async deleteProduct(jan, relatedEntryIds = []) {
      data.products = data.products.filter((item) => item.jan !== jan);
      data.entries = data.entries.filter((entry) => !relatedEntryIds.includes(entry.id));
      persist();
      emit();
    },
    saveEntry(entry) {
      const index = data.entries.findIndex((item) => item.id === entry.id);
      if (index >= 0) data.entries[index] = { ...entry };
      else data.entries.push({ ...entry });
      persist();
      emit();
    },
    saveEntries(entries) {
      entries.forEach((entry) => {
        const index = data.entries.findIndex((item) => item.id === entry.id);
        if (index >= 0) data.entries[index] = { ...entry };
        else data.entries.push({ ...entry });
      });
      persist();
      emit();
    },
    deleteEntry(entryId) {
      data.entries = data.entries.filter((entry) => entry.id !== entryId);
      persist();
      emit();
    },
    async purgeRoom(id) {
      localStorage.removeItem(localKey(id));
      if (id === roomId) {
        data = { createdAt: "", products: [], entries: [] };
        emit();
      }
    }
  };
}
