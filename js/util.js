export const ROOM_RETENTION_DAYS = 7;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function normalizeRoom(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function normalizeShelf(value) {
  const shelf = String(value || "").trim().replace(/\s+/g, "").slice(0, 20);
  return /^\d{1,3}$/.test(shelf) ? shelf.padStart(3, "0") : shelf;
}

export function normalizeJan(value) {
  return String(value || "").trim();
}

export function isNumericCode(value) {
  return /^\d+$/.test(normalizeJan(value));
}

export function toInt(value) {
  const number = Number.parseInt(String(value ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

export function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

export function fallbackJanFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) >>> 0;
  }
  return `NOJAN-${hash.toString(36).toUpperCase()}`;
}

export function isFallbackJan(jan) {
  return String(jan || "").startsWith("NOJAN-");
}

export function sameProductName(a, b) {
  return normalizeKey(a) && normalizeKey(a) === normalizeKey(b);
}

export function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(values, (value) => chars[value % chars.length]).join("");
}

export function makeId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const DEVICE_KEY = "inventory-device-id";

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = makeId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function expiresAtFrom(createdAt) {
  const createdTime = Date.parse(createdAt);
  return Number.isFinite(createdTime) ? createdTime + ROOM_RETENTION_DAYS * MS_PER_DAY : 0;
}

export function isExpiredMillis(expiresAtMillis) {
  return Boolean(expiresAtMillis && expiresAtMillis <= Date.now());
}

export function formatDateTime(millis) {
  return millis
    ? new Date(millis).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })
    : "";
}

// GTIN (EAN-8 / UPC-A / EAN-13 / GTIN-14) チェックデジット検証。
// UPC-E は圧縮形式なのでこの式では検証できない。呼び出し側で除外すること。
export function validGtinCheckDigit(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
