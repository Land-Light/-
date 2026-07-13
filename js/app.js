import {
  normalizeRoom, normalizeShelf, normalizeJan, isNumericCode, toInt,
  escapeHtml, normalizeKey, fallbackJanFromName, isFallbackJan, sameProductName,
  generateRoomCode, makeId, getDeviceId, isExpiredMillis, formatDateTime,
  ROOM_RETENTION_DAYS
} from "./util.js";
import { parseCsv, buildCsv } from "./csv.js";
import { createStore } from "./store.js";
import { createScanner, playBeep } from "./scanner.js";
import { initHelp } from "./help.js";

const USER_KEY = "inventory-user-name";
const UNDO_LIMIT = 30;

const state = {
  roomId: "",
  userName: "",
  deviceId: "",
  roomExpiresAtMillis: 0,
  products: [],
  entries: [],
  reviewSearch: "",
  diffOnly: false,
  setupLocked: true,
  editingCountId: "",
  undoStack: [],
  mode: "none",
  expiryTimer: null,
  scanMode: "",
  scanCount: 0
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  lockScreen: $("#lockScreen"),
  appShell: $("#appShell"),
  cloudSetupNotice: $("#cloudSetupNotice"),
  createRoom: $("#createRoom"),
  joinForm: $("#joinForm"),
  userName: $("#userName"),
  roomCode: $("#roomCode"),
  activeRoomCode: $("#activeRoomCode"),
  activeUserName: $("#activeUserName"),
  syncStatus: $("#syncStatus"),
  roomExpiry: $("#roomExpiry"),
  copyInvite: $("#copyInvite"),
  logout: $("#logout"),
  tabs: document.querySelectorAll(".tab"),
  panels: document.querySelectorAll(".tab-panel"),
  productForm: $("#productForm"),
  productJan: $("#productJan"),
  productName: $("#productName"),
  expectedQty: $("#expectedQty"),
  productScanButton: $("#productScanButton"),
  productMessage: $("#productMessage"),
  productRows: $("#productRows"),
  productTotal: $("#productTotal"),
  csvImport: $("#csvImport"),
  csvImportButton: $("#csvImportButton"),
  setupLockStatus: $("#setupLockStatus"),
  setupLockToggle: $("#setupLockToggle"),
  countForm: $("#countForm"),
  countSearch: $("#countSearch"),
  shelfNo: $("#shelfNo"),
  countQty: $("#countQty"),
  countSubmit: $("#countSubmit"),
  takeoverEntryButton: $("#takeoverEntryButton"),
  undoButton: $("#undoButton"),
  productHints: $("#productHints"),
  countRows: $("#countRows"),
  countTotal: $("#countTotal"),
  selectedProduct: $("#selectedProduct"),
  scanMessage: $("#scanMessage"),
  scanButton: $("#scanButton"),
  autoScanButton: $("#autoScanButton"),
  reviewRows: $("#reviewRows"),
  reviewSearch: $("#reviewSearch"),
  diffOnly: $("#diffOnly"),
  exportRows: $("#exportRows"),
  matchTotal: $("#matchTotal"),
  shortTotal: $("#shortTotal"),
  overTotal: $("#overTotal"),
  progressText: $("#progressText"),
  progressQty: $("#progressQty"),
  progressFill: $("#progressFill"),
  exportCsv: $("#exportCsv"),
  scanStage: $("#scanStage"),
  scanVideo: $("#scanVideo"),
  scanModeLabel: $("#scanModeLabel"),
  scanEngine: $("#scanEngine"),
  scanStop: $("#scanStop"),
  scanFlash: $("#scanFlash"),
  scanLast: $("#scanLast"),
  scanStageMessage: $("#scanStageMessage"),
  scanShelf: $("#scanShelf"),
  scanShelfField: $("#scanShelfField"),
  torchButton: $("#torchButton"),
  scanUndo: $("#scanUndo"),
  zoomControl: $("#zoomControl"),
  zoomRange: $("#zoomRange")
};

function setSyncStatus(text, tone = "muted") {
  elements.syncStatus.textContent = text;
  elements.syncStatus.className = `pill ${tone}`;
}

const store = createStore({
  onProducts(products) {
    state.products = [...products].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    render();
  },
  onEntries(entries) {
    state.entries = entries;
    render();
  },
  onStatus(text, tone) {
    setSyncStatus(text, tone);
  }
});

// ---------- 集計 ----------

function findProduct(query) {
  const term = normalizeJan(query).toLowerCase();
  return state.products.find((product) => (
    product.jan.toLowerCase() === term ||
    product.name.toLowerCase() === term ||
    `${product.jan} ${product.name}`.toLowerCase() === term
  ));
}

function countsByJan(entries = state.entries) {
  return entries.reduce((totals, entry) => {
    totals[entry.jan] = (totals[entry.jan] || 0) + toInt(entry.qty);
    return totals;
  }, {});
}

function breakdownByJan(entries = state.entries) {
  return entries.reduce((groups, entry) => {
    const jan = entry.jan;
    const shelf = entry.shelfNo || "000";
    const user = entry.userName || "担当未設定";
    groups[jan] ||= {};
    groups[jan][shelf] ||= {};
    groups[jan][shelf][user] = (groups[jan][shelf][user] || 0) + toInt(entry.qty);
    return groups;
  }, {});
}

// ---------- 描画 ----------

function render() {
  renderProducts();
  renderCounts();
  renderReview();
  renderExportRows();
  setSetupLocked(state.setupLocked);
  elements.undoButton.disabled = !state.undoStack.length;
  elements.scanUndo.hidden = state.scanMode !== "auto" || !state.undoStack.length;
}

function setSetupLocked(locked) {
  state.setupLocked = locked;
  elements.setupLockStatus.textContent = locked ? "設定ロック中" : "設定を変更できます";
  elements.setupLockToggle.textContent = locked ? "ロック解除" : "ロックする";
  elements.setupLockToggle.setAttribute("aria-pressed", String(!locked));
  elements.productForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = locked;
  });
  elements.csvImport.disabled = locked;
  elements.csvImportButton.classList.toggle("disabled", locked);
  elements.csvImportButton.setAttribute("aria-disabled", String(locked));
}

function renderProducts() {
  const lockedAttribute = state.setupLocked ? " disabled" : "";
  elements.productTotal.textContent = `${state.products.length}件`;
  elements.productHints.innerHTML = state.products
    .map((product) => `<option value="${escapeHtml(product.jan)}">${escapeHtml(product.name)}</option>`)
    .join("");

  if (!state.products.length) {
    elements.productRows.innerHTML = `<tr><td class="empty" colspan="4">商品を登録してください。</td></tr>`;
    return;
  }

  elements.productRows.innerHTML = state.products.map((product) => `
    <tr>
      <td>${escapeHtml(product.jan)}</td>
      <td>${escapeHtml(product.name)}</td>
      <td class="num">${product.expected}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="ghost" data-edit="${escapeHtml(product.jan)}"${lockedAttribute}>編集</button>
          <button type="button" class="danger" data-delete-product="${escapeHtml(product.jan)}"${lockedAttribute}>削除</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderCounts() {
  const entries = state.entries
    .filter((entry) => entry.deviceId === state.deviceId && toInt(entry.qty) > 0)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = entries.reduce((sum, entry) => sum + toInt(entry.qty), 0);
  elements.countTotal.textContent = `${total}点`;

  if (!entries.length) {
    elements.countRows.innerHTML = `<tr><td class="empty" colspan="6">この端末で入力した数量はまだありません。</td></tr>`;
    return;
  }

  elements.countRows.innerHTML = entries.map((entry) => {
    const product = state.products.find((item) => item.jan === entry.jan) || { name: "未登録商品" };
    return `
      <tr>
        <td>${escapeHtml(entry.shelfNo || "000")}</td>
        <td>${escapeHtml(entry.jan)}</td>
        <td>${escapeHtml(product.name)}</td>
        <td class="num">${toInt(entry.qty)}</td>
        <td>${escapeHtml(entry.userName || state.userName)}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="ghost" data-edit-entry="${escapeHtml(entry.id)}">編集</button>
            <button type="button" class="ghost" data-minus-entry="${escapeHtml(entry.id)}">-1</button>
            <button type="button" class="danger" data-delete-entry="${escapeHtml(entry.id)}">削除</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function usersText(shelves = {}) {
  return Object.values(shelves)
    .flatMap((users) => Object.keys(users))
    .join(" ");
}

function reviewRow(jan, name, expected, counted, diff, shelves = {}) {
  const className = diff === 0 ? "" : diff < 0 ? "danger" : "status";
  const label = diff > 0 ? `+${diff}` : diff;
  const detail = Object.entries(shelves).length
    ? Object.entries(shelves)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([shelf, users]) => {
        const userText = Object.entries(users)
          .sort(([a], [b]) => a.localeCompare(b, "ja"))
          .map(([user, qty]) => `${escapeHtml(user)} ${qty}`)
          .join(" / ");
        const shelfTotal = Object.values(users).reduce((sum, qty) => sum + qty, 0);
        return `<span class="breakdown-item">棚${escapeHtml(shelf)}: ${shelfTotal}個 (${userText})</span>`;
      })
      .join("")
    : `<span class="muted-text">入力なし</span>`;
  return `
    <tr>
      <td>${escapeHtml(jan)}</td>
      <td>${escapeHtml(name)}</td>
      <td class="num">${expected}</td>
      <td class="num">${counted}</td>
      <td class="num"><span class="${className}">${label}</span></td>
      <td><div class="breakdown-list">${detail}</div></td>
    </tr>
  `;
}

function renderReview() {
  let matches = 0;
  let shorts = 0;
  let overs = 0;
  const knownJans = new Set(state.products.map((product) => product.jan));
  const totals = countsByJan();
  const breakdown = breakdownByJan();
  const reviewItems = state.products.map((product) => {
    const counted = totals[product.jan] || 0;
    const diff = counted - product.expected;
    if (diff === 0) matches += 1;
    if (diff < 0) shorts += 1;
    if (diff > 0) overs += 1;
    return { jan: product.jan, name: product.name, expected: product.expected, counted, diff, shelves: breakdown[product.jan] };
  });

  Object.entries(totals).forEach(([jan, counted]) => {
    if (!knownJans.has(jan) && counted > 0) {
      overs += 1;
      reviewItems.push({ jan, name: "未登録商品", expected: 0, counted, diff: counted, shelves: breakdown[jan] });
    }
  });

  const search = normalizeKey(state.reviewSearch);
  const rows = reviewItems
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.jan.localeCompare(b.jan, "ja", { numeric: true }))
    .filter((item) => !state.diffOnly || item.diff !== 0)
    .filter((item) => {
      if (!search) return true;
      return normalizeKey(item.jan).includes(search) ||
        normalizeKey(item.name).includes(search) ||
        normalizeKey(usersText(item.shelves)).includes(search);
    })
    .map((item) => reviewRow(item.jan, item.name, item.expected, item.counted, item.diff, item.shelves));

  elements.matchTotal.textContent = `一致 ${matches}`;
  elements.shortTotal.textContent = `不足 ${shorts}`;
  elements.overTotal.textContent = `過剰 ${overs}`;
  elements.reviewRows.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td class="empty" colspan="6">確認する商品がありません。</td></tr>`;

  const totalSkus = state.products.length;
  const countedSkus = state.products.filter((product) => (totals[product.jan] || 0) > 0).length;
  const percent = totalSkus ? Math.round((countedSkus / totalSkus) * 100) : 0;
  const countedQty = Object.values(totals).reduce((sum, qty) => sum + qty, 0);
  const expectedQty = state.products.reduce((sum, product) => sum + toInt(product.expected), 0);
  elements.progressText.textContent = `進捗 ${countedSkus} / ${totalSkus} SKU (${percent}%)`;
  elements.progressQty.textContent = `入力 ${countedQty}点 / 予定 ${expectedQty}点`;
  elements.progressFill.style.width = `${percent}%`;
}

function shelfMemo(shelves = {}) {
  return Object.entries(shelves)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shelf, users]) => {
      const shelfTotal = Object.values(users).reduce((sum, qty) => sum + toInt(qty), 0);
      return `棚${shelf}: ${shelfTotal}`;
    })
    .join(" / ");
}

function exportRowsData() {
  const totals = countsByJan();
  const breakdown = breakdownByJan();
  const knownJans = new Set(state.products.map((product) => product.jan));
  const extraJans = Object.keys(totals).filter((jan) => !knownJans.has(jan));

  return [...state.products.map((product) => product.jan), ...extraJans]
    .map((jan) => ({
      code: jan,
      qty: totals[jan] || 0,
      memo: shelfMemo(breakdown[jan])
    }))
    .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true }));
}

function renderExportRows() {
  const rows = exportRowsData();
  elements.exportRows.innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.code)}</td>
        <td class="num">${row.qty}</td>
        <td>${escapeHtml(row.memo)}</td>
      </tr>
    `).join("")
    : `<tr><td class="empty" colspan="3">出力する商品がありません。</td></tr>`;
}

// ---------- 商品マスタ更新 ----------

// NOJAN 仮登録品と本登録品の統合を含む商品upsert。
// stateを楽観更新しつつ、確定したストア操作を返す。
function upsertProduct(product) {
  const productName = String(product.name || "").trim();
  const ops = { saves: new Map(), deleteJans: new Set(), entrySaves: new Map() };
  const recordSave = (item) => ops.saves.set(item.jan, item);

  const sameNameIndex = state.products.findIndex((item) => (
    item.jan !== product.jan &&
    sameProductName(item.name, productName) &&
    (isFallbackJan(item.jan) || isFallbackJan(product.jan))
  ));
  if (sameNameIndex >= 0) {
    const existing = state.products[sameNameIndex];
    const merged = {
      jan: isFallbackJan(product.jan) && !isFallbackJan(existing.jan) ? existing.jan : product.jan,
      name: productName || existing.name,
      expected: product.expected
    };
    if (existing.jan !== merged.jan) {
      state.entries.forEach((entry) => {
        if (entry.jan === existing.jan) {
          entry.jan = merged.jan;
          entry.updatedAt = new Date().toISOString();
          ops.entrySaves.set(entry.id, entry);
        }
      });
      ops.deleteJans.add(existing.jan);
    }
    state.products.splice(sameNameIndex, 1);
    const duplicateIndex = state.products.findIndex((item) => item.jan === merged.jan);
    if (duplicateIndex >= 0) {
      state.products[duplicateIndex] = {
        ...state.products[duplicateIndex],
        name: merged.name || state.products[duplicateIndex].name,
        expected: merged.expected
      };
      recordSave(state.products[duplicateIndex]);
    } else {
      state.products.push(merged);
      recordSave(merged);
    }
    state.products.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return ops;
  }

  const index = state.products.findIndex((item) => item.jan === product.jan);
  if (index >= 0) {
    const existing = state.products[index];
    state.products[index] = {
      ...product,
      name: productName && existing.name === existing.jan ? productName : product.name
    };
    recordSave(state.products[index]);
  } else {
    state.products.push(product);
    recordSave(product);
  }
  state.products.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return ops;
}

function commitProductOps(ops) {
  if (ops.saves.size === 1) {
    store.saveProduct([...ops.saves.values()][0]);
  } else if (ops.saves.size > 1) {
    store.saveProducts([...ops.saves.values()]);
  }
  if (ops.entrySaves.size) store.saveEntries([...ops.entrySaves.values()]);
  ops.deleteJans.forEach((jan) => store.deleteProduct(jan, []));
}

function mergeProductOps(target, ops) {
  ops.saves.forEach((value, key) => target.saves.set(key, value));
  ops.entrySaves.forEach((value, key) => target.entrySaves.set(key, value));
  ops.deleteJans.forEach((jan) => target.deleteJans.add(jan));
}

// ---------- 数量入力 ----------

function pushUndo(record) {
  state.undoStack.push(record);
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

function addCount({ codeOrName, shelfNo, qty }) {
  const searchValue = normalizeJan(codeOrName);
  const product = findProduct(searchValue);
  const jan = product ? product.jan : isNumericCode(searchValue) ? searchValue : fallbackJanFromName(searchValue);
  const shelf = normalizeShelf(shelfNo);
  const amount = Math.max(1, toInt(qty));
  if (!jan || !shelf) return { ok: false };

  if (!product) {
    const ops = upsertProduct({ jan, name: searchValue, expected: 0 });
    commitProductOps(ops);
  }

  const existing = state.entries.find((item) => (
    item.deviceId === state.deviceId &&
    item.jan === jan &&
    normalizeShelf(item.shelfNo) === shelf &&
    toInt(item.qty) > 0
  ));
  let entry;
  if (existing) {
    existing.qty = toInt(existing.qty) + amount;
    existing.userName = state.userName;
    existing.updatedAt = new Date().toISOString();
    entry = existing;
    pushUndo({ entryId: entry.id, qty: amount, wasNew: false });
  } else {
    entry = {
      id: makeId(),
      deviceId: state.deviceId,
      userName: state.userName,
      jan,
      shelfNo: shelf,
      qty: amount,
      createdAt: new Date().toISOString()
    };
    state.entries.push(entry);
    pushUndo({ entryId: entry.id, qty: amount, wasNew: true });
  }
  store.saveEntry(entry);
  render();
  const savedProduct = state.products.find((item) => item.jan === jan);
  return { ok: true, jan, name: savedProduct?.name || searchValue, total: toInt(entry.qty) };
}

function undoLast() {
  for (;;) {
    const record = state.undoStack.pop();
    if (!record) return null;
    const entry = state.entries.find((item) => item.id === record.entryId && item.deviceId === state.deviceId);
    if (!entry || toInt(entry.qty) <= 0) continue;
    const newQty = toInt(entry.qty) - record.qty;
    const product = state.products.find((item) => item.jan === entry.jan);
    if (newQty > 0 && !record.wasNew) {
      entry.qty = newQty;
      entry.updatedAt = new Date().toISOString();
      store.saveEntry(entry);
    } else {
      state.entries = state.entries.filter((item) => item.id !== entry.id);
      store.deleteEntry(entry.id);
    }
    render();
    return { name: product?.name || entry.jan, qty: record.qty };
  }
}

function saveCountFromInputs() {
  const searchValue = normalizeJan(elements.countSearch.value);
  const shelf = normalizeShelf(elements.shelfNo.value);
  const qty = Math.max(1, toInt(elements.countQty.value));
  if (!searchValue || !shelf) return false;

  if (state.editingCountId) {
    const entry = state.entries.find((item) => item.id === state.editingCountId && item.deviceId === state.deviceId);
    if (entry) {
      const product = findProduct(searchValue);
      const jan = product ? product.jan : isNumericCode(searchValue) ? searchValue : fallbackJanFromName(searchValue);
      if (!product) {
        commitProductOps(upsertProduct({ jan, name: searchValue, expected: 0 }));
      }
      entry.jan = jan;
      entry.shelfNo = shelf;
      entry.qty = qty;
      entry.userName = state.userName;
      entry.updatedAt = new Date().toISOString();
      store.saveEntry(entry);
    }
    state.editingCountId = "";
    elements.countSubmit.textContent = "加算";
  } else {
    const result = addCount({ codeOrName: searchValue, shelfNo: shelf, qty });
    if (!result.ok) return false;
  }

  elements.countSearch.value = "";
  elements.shelfNo.value = shelf;
  elements.countQty.value = "1";
  elements.selectedProduct.hidden = true;
  render();
  return true;
}

// ---------- スキャン ----------

const scanner = createScanner({
  video: elements.scanVideo,
  onCode: handleScannedCode,
  onStatus: (text) => showStageMessage(text)
});

let scanFillTarget = null;

function showStageMessage(message) {
  elements.scanStageMessage.textContent = message;
}

function flashViewport() {
  elements.scanFlash.classList.remove("active");
  void elements.scanFlash.offsetWidth;
  elements.scanFlash.classList.add("active");
}

function showLastRead(text) {
  elements.scanLast.hidden = false;
  elements.scanLast.textContent = text;
}

async function openScanStage(mode, { fillTarget = null } = {}) {
  if (scanner.isRunning()) return;
  state.scanMode = mode;
  state.scanCount = 0;
  scanFillTarget = fillTarget;
  elements.scanStage.hidden = false;
  document.body.classList.add("scan-active");
  elements.scanLast.hidden = true;
  elements.torchButton.hidden = true;
  elements.zoomControl.hidden = true;
  elements.scanUndo.hidden = true;
  elements.scanModeLabel.textContent = mode === "auto" ? "連続スキャン(自動加算)" : "カメラ読取";
  elements.scanShelfField.hidden = mode !== "auto";
  if (mode === "auto") {
    elements.scanShelf.value = normalizeShelf(elements.shelfNo.value);
  }
  showStageMessage("カメラを起動しています…");

  try {
    await scanner.start();
  } catch (error) {
    showStageMessage(error.message || "カメラを開始できませんでした。ブラウザのカメラ権限を確認してください。");
    setTimeout(() => closeScanStage(), 2600);
    return;
  }

  elements.scanEngine.textContent = scanner.engineType() === "native" ? "高速エンジン" : "標準エンジン";
  elements.torchButton.hidden = !hasTorch();
  const zoom = scanner.zoomRange();
  if (zoom) {
    elements.zoomRange.min = zoom.min;
    elements.zoomRange.max = zoom.max;
    elements.zoomRange.step = zoom.step || 0.1;
    elements.zoomRange.value = zoom.min;
    elements.zoomControl.hidden = false;
  }
  if (mode === "auto") {
    const shelf = normalizeShelf(elements.scanShelf.value);
    showStageMessage(shelf
      ? `棚 ${shelf} に読み取った商品を自動で+1します。`
      : "棚番を入力するとスキャンで自動加算されます。");
    elements.scanUndo.hidden = !state.undoStack.length;
  } else {
    showStageMessage("JANコードを枠内に映してください。");
  }
}

function hasTorch() {
  try {
    return Boolean(elements.scanVideo.srcObject?.getVideoTracks?.()[0]?.getCapabilities?.().torch);
  } catch (error) {
    return false;
  }
}

function closeScanStage() {
  scanner.stop();
  state.scanMode = "";
  scanFillTarget = null;
  elements.scanStage.hidden = true;
  document.body.classList.remove("scan-active");
}

function handleScannedCode({ code }) {
  if (state.scanMode === "fill") {
    playBeep("ok");
    flashViewport();
    const target = scanFillTarget;
    closeScanStage();
    if (target) {
      target.value = code;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      if (target === elements.productJan) showProductMessage(`読み取りました: ${code}`);
    }
    return;
  }
  if (state.scanMode === "scan-add") {
    playBeep("ok");
    flashViewport();
    elements.countSearch.value = code;
    elements.countSearch.dispatchEvent(new Event("input", { bubbles: true }));
    const shelf = normalizeShelf(elements.shelfNo.value);
    closeScanStage();
    if (shelf) {
      const saved = saveCountFromInputs();
      showCountMessage(saved ? `読み取りました: ${code} / 加算しました` : `読み取りました: ${code} / 棚番を入力してください`);
    } else {
      showCountMessage(`読み取りました: ${code} / 棚番を入力して「加算」を押してください`);
    }
    return;
  }
  if (state.scanMode === "auto") {
    const shelf = normalizeShelf(elements.scanShelf.value);
    if (!shelf) {
      playBeep("error");
      showStageMessage("棚番が未入力です。下の棚番を入力してください。");
      return;
    }
    elements.shelfNo.value = shelf;
    const result = addCount({ codeOrName: code, shelfNo: shelf, qty: 1 });
    if (result.ok) {
      state.scanCount += 1;
      playBeep("ok");
      flashViewport();
      showLastRead(`${state.scanCount}件目 / ${result.name} → 棚${shelf} 計${result.total}`);
      showStageMessage("スキャン中(同じ商品は約1.5秒後に再加算できます)");
      elements.scanUndo.hidden = false;
    } else {
      playBeep("error");
      showStageMessage("登録できませんでした。もう一度読み取ってください。");
    }
  }
}

function showCountMessage(message) {
  elements.scanMessage.hidden = false;
  elements.scanMessage.textContent = message;
}

function showProductMessage(message) {
  elements.productMessage.hidden = false;
  elements.productMessage.textContent = message;
}

// ---------- 部屋の入退室 ----------

function startExpiryWatch() {
  clearInterval(state.expiryTimer);
  state.expiryTimer = setInterval(checkRoomExpiry, 60 * 1000);
}

async function checkRoomExpiry() {
  if (!state.roomId || !state.roomExpiresAtMillis) return;
  if (!isExpiredMillis(state.roomExpiresAtMillis)) return;
  const expiredRoomId = state.roomId;
  leaveRoom();
  await store.purgeRoom(expiredRoomId).catch(() => null);
  window.alert(`作成から${ROOM_RETENTION_DAYS}日経過したため、部屋を削除しました。`);
}

async function enterRoom(roomId, userName) {
  state.roomId = normalizeRoom(roomId);
  state.userName = String(userName || "").trim();
  state.deviceId = getDeviceId();
  state.setupLocked = true;
  state.undoStack = [];
  state.editingCountId = "";
  state.products = [];
  state.entries = [];
  localStorage.setItem(USER_KEY, state.userName);
  elements.activeRoomCode.textContent = `部屋 ${state.roomId}`;
  elements.activeUserName.textContent = `担当 ${state.userName}`;
  elements.lockScreen.hidden = true;
  elements.appShell.hidden = false;
  render();

  setSyncStatus("接続中", "muted");
  try {
    const { expiresAtMillis } = await store.joinRoom(state.roomId);
    state.roomExpiresAtMillis = expiresAtMillis || 0;
    if (expiresAtMillis) {
      elements.roomExpiry.hidden = false;
      elements.roomExpiry.textContent = `期限 ${formatDateTime(expiresAtMillis)}`;
    } else {
      elements.roomExpiry.hidden = true;
    }
  } catch (error) {
    setSyncStatus(`同期失敗: ${error.message}`, "danger");
  }
  startExpiryWatch();
  history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(state.roomId)}`);
}

function leaveRoom() {
  closeScanStage();
  store.leaveRoom();
  clearInterval(state.expiryTimer);
  state.roomId = "";
  state.roomExpiresAtMillis = 0;
  state.products = [];
  state.entries = [];
  state.undoStack = [];
  elements.lockScreen.hidden = false;
  elements.appShell.hidden = true;
  history.replaceState(null, "", location.pathname);
}

// ---------- イベント ----------

elements.createRoom.addEventListener("click", () => {
  const userName = elements.userName.value.trim();
  if (!userName) {
    elements.userName.focus();
    return;
  }
  enterRoom(generateRoomCode(), userName);
});

elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomId = normalizeRoom(elements.roomCode.value);
  const userName = elements.userName.value.trim();
  if (!userName) {
    elements.userName.focus();
    return;
  }
  if (!roomId) return;
  enterRoom(roomId, userName);
});

elements.logout.addEventListener("click", () => {
  leaveRoom();
});

elements.copyInvite.addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomId)}`;
  await navigator.clipboard.writeText(url);
  setSyncStatus("リンクコピー済み", "ok");
});

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    elements.tabs.forEach((item) => item.classList.toggle("active", item === tab));
    elements.panels.forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.tab));
  });
});

elements.setupLockToggle.addEventListener("click", () => {
  if (state.setupLocked) {
    const answer = window.prompt("設定ロックを解除するには「解除」と入力してください。");
    if (answer !== "解除") {
      setSyncStatus("設定ロック中", "danger");
      return;
    }
    setSetupLocked(false);
    renderProducts();
    setSyncStatus("設定ロック解除中", "ok");
    return;
  }
  setSetupLocked(true);
  renderProducts();
  setSyncStatus("設定をロックしました", "ok");
});

elements.productForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.setupLocked) {
    setSyncStatus("設定ロック中", "danger");
    return;
  }
  const product = {
    jan: normalizeJan(elements.productJan.value),
    name: elements.productName.value.trim(),
    expected: toInt(elements.expectedQty.value)
  };
  if (!product.jan || !product.name) return;
  commitProductOps(upsertProduct(product));
  elements.productForm.reset();
  elements.expectedQty.value = "0";
  render();
});

elements.productRows.addEventListener("click", (event) => {
  if (state.setupLocked) {
    setSyncStatus("設定ロック中", "danger");
    return;
  }
  const editJan = event.target.dataset.edit;
  const deleteJan = event.target.dataset.deleteProduct;
  if (editJan) {
    const product = state.products.find((item) => item.jan === editJan);
    if (!product) return;
    elements.productJan.value = product.jan;
    elements.productName.value = product.name;
    elements.expectedQty.value = product.expected;
  }
  if (deleteJan) {
    const relatedEntryIds = state.entries
      .filter((entry) => entry.jan === deleteJan)
      .map((entry) => entry.id);
    state.products = state.products.filter((item) => item.jan !== deleteJan);
    state.entries = state.entries.filter((entry) => entry.jan !== deleteJan);
    store.deleteProduct(deleteJan, relatedEntryIds);
    render();
  }
});

elements.csvImport.addEventListener("change", async (event) => {
  if (state.setupLocked) {
    event.target.value = "";
    setSyncStatus("設定ロック中", "danger");
    return;
  }
  const file = event.target.files[0];
  if (!file) return;
  const products = parseCsv(await readCsvFileText(file), state.products, fallbackJanFromName);
  if (!products.length) {
    event.target.value = "";
    setSyncStatus("取り込める商品がありません", "danger");
    return;
  }
  const allOps = { saves: new Map(), deleteJans: new Set(), entrySaves: new Map() };
  products.forEach((product) => mergeProductOps(allOps, upsertProduct(product)));
  commitProductOps(allOps);
  event.target.value = "";
  render();
  setSyncStatus(`CSV取込 ${products.length}件`, "ok");
});

// スマレジやExcelが出力するCSVはShift-JISのことが多いので、文字コードを自動判別する。
async function readCsvFileText(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    return new TextDecoder("shift_jis").decode(buffer);
  }
}

elements.countSearch.addEventListener("input", () => {
  const product = findProduct(elements.countSearch.value);
  elements.selectedProduct.hidden = !product;
  elements.selectedProduct.textContent = product ? `${product.name} / 予定 ${product.expected}` : "";
});

elements.reviewSearch.addEventListener("input", () => {
  state.reviewSearch = elements.reviewSearch.value;
  renderReview();
});

elements.diffOnly.addEventListener("change", () => {
  state.diffOnly = elements.diffOnly.checked;
  renderReview();
});

elements.shelfNo.addEventListener("input", () => {
  elements.shelfNo.value = elements.shelfNo.value.replace(/\s+/g, "").slice(0, 20);
});

elements.shelfNo.addEventListener("blur", () => {
  if (elements.shelfNo.value) elements.shelfNo.value = normalizeShelf(elements.shelfNo.value);
});

elements.scanShelf.addEventListener("input", () => {
  elements.scanShelf.value = elements.scanShelf.value.replace(/\s+/g, "").slice(0, 20);
});

elements.scanShelf.addEventListener("blur", () => {
  if (elements.scanShelf.value) {
    elements.scanShelf.value = normalizeShelf(elements.scanShelf.value);
    elements.shelfNo.value = elements.scanShelf.value;
  }
});

elements.countForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCountFromInputs();
});

elements.undoButton.addEventListener("click", () => {
  const undone = undoLast();
  if (undone) {
    showCountMessage(`取消しました: ${undone.name} -${undone.qty}`);
  }
});

elements.scanUndo.addEventListener("click", () => {
  const undone = undoLast();
  if (undone) {
    playBeep("error");
    showLastRead(`取消: ${undone.name} -${undone.qty}`);
  }
  elements.scanUndo.hidden = !state.undoStack.length;
});

elements.takeoverEntryButton.addEventListener("click", () => {
  const candidates = state.entries
    .filter((entry) => entry.deviceId !== state.deviceId && toInt(entry.qty) > 0)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!candidates.length) {
    setSyncStatus("引継ぎできる他担当者の入力はありません", "muted");
    return;
  }

  const lines = candidates.slice(0, 20).map((entry, index) => {
    const product = state.products.find((item) => item.jan === entry.jan) || { name: "未登録商品" };
    return `${index + 1}: ${entry.userName || "担当未設定"} / ${entry.shelfNo || "000"} / ${product.name} / ${toInt(entry.qty)}点`;
  });
  const answer = window.prompt(`引き継ぐ入力の番号を入力してください。\n\n${lines.join("\n")}`);
  const index = toInt(answer) - 1;
  const entry = candidates[index];
  if (!entry) return;

  const previousUser = entry.userName || "担当未設定";
  const product = state.products.find((item) => item.jan === entry.jan) || { name: "未登録商品" };
  const ok = window.confirm(
    `${previousUser}さんの入力を${state.userName}さんに引き継ぎます。\n` +
    `棚番: ${entry.shelfNo || "000"}\n` +
    `商品: ${product.name}\n` +
    `数量: ${toInt(entry.qty)}\n\nよろしいですか？`
  );
  if (!ok) return;
  entry.deviceId = state.deviceId;
  entry.userName = state.userName;
  entry.updatedAt = new Date().toISOString();
  store.saveEntry(entry);
  setSyncStatus("入力を引き継ぎました", "ok");
  render();
});

elements.countRows.addEventListener("click", (event) => {
  const editId = event.target.dataset.editEntry;
  const minusId = event.target.dataset.minusEntry;
  const deleteId = event.target.dataset.deleteEntry;
  if (editId) {
    const entry = state.entries.find((item) => item.id === editId && item.deviceId === state.deviceId);
    if (!entry) return;
    state.editingCountId = editId;
    elements.countSearch.value = entry.jan;
    elements.shelfNo.value = entry.shelfNo || "";
    elements.countQty.value = toInt(entry.qty) || 1;
    elements.countSubmit.textContent = "更新";
    elements.countSearch.dispatchEvent(new Event("input", { bubbles: true }));
    elements.countSearch.focus();
    return;
  }
  if (minusId) {
    const entry = state.entries.find((item) => item.id === minusId && item.deviceId === state.deviceId);
    if (entry) {
      entry.qty = Math.max(0, toInt(entry.qty) - 1);
      entry.updatedAt = new Date().toISOString();
      if (entry.qty > 0) {
        store.saveEntry(entry);
      } else {
        state.entries = state.entries.filter((item) => item.id !== entry.id);
        store.deleteEntry(entry.id);
      }
    }
  }
  if (deleteId) {
    state.entries = state.entries.filter((entry) => !(entry.id === deleteId && entry.deviceId === state.deviceId));
    store.deleteEntry(deleteId);
    if (state.editingCountId === deleteId) {
      state.editingCountId = "";
      elements.countSubmit.textContent = "加算";
      elements.countForm.reset();
      elements.countQty.value = "1";
    }
  }
  render();
});

elements.exportCsv.addEventListener("click", () => {
  const header = ["商品コード", "棚卸数量", "明細メモ"];
  const csv = buildCsv(header, exportRowsData().map((row) => [row.code, row.qty, row.memo]));
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `inventory-${state.roomId}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

elements.productScanButton.addEventListener("click", () => {
  if (state.setupLocked) {
    setSyncStatus("設定ロック中", "danger");
    return;
  }
  openScanStage("fill", { fillTarget: elements.productJan });
});

elements.scanButton.addEventListener("click", () => {
  openScanStage("scan-add");
});

elements.autoScanButton.addEventListener("click", () => {
  openScanStage("auto");
});

elements.scanStop.addEventListener("click", () => {
  const total = state.scanCount;
  const wasAuto = state.scanMode === "auto";
  closeScanStage();
  if (wasAuto) {
    showCountMessage(total ? `連続スキャンを終了しました: ${total}件` : "連続スキャンを終了しました。");
  }
});

elements.torchButton.addEventListener("click", async () => {
  const on = await scanner.toggleTorch();
  elements.torchButton.classList.toggle("active", on);
  elements.torchButton.textContent = on ? "ライト消灯" : "ライト";
});

elements.zoomRange.addEventListener("input", () => {
  scanner.setZoom(elements.zoomRange.value);
});

// ---------- 起動 ----------

async function boot() {
  initHelp(document.querySelector("#helpButton"));
  const config = window.INVENTORY_FIREBASE || {};
  state.mode = await store.init(config);
  elements.cloudSetupNotice.hidden = state.mode === "cloud";

  const urlRoom = normalizeRoom(new URLSearchParams(location.search).get("room"));
  elements.userName.value = localStorage.getItem(USER_KEY) || "";
  if (urlRoom) {
    elements.roomCode.value = urlRoom;
  }
}

boot();
