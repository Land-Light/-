import { digitsOnly, validGtinCheckDigit } from "./util.js";

// ネイティブ BarcodeDetector(Chrome/Android: ハードウェア支援で最速)を優先し、
// 非対応ブラウザ(iOS Safari等)は同梱の zxing-wasm へフォールバックする。
const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf", "code_39", "qr_code"];
const ZXING_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E", "Code128", "ITF", "Code39", "QRCode"];

// 読取領域(ROI): 画面中央の横帯だけをデコードする。
// フレーム全体を舐めるより速く、隣の棚の別バーコードを誤読しにくい。
const ROI_WIDTH_RATIO = 0.94;
const ROI_HEIGHT_RATIO = 0.5;
const ROI_MAX_WIDTH = 720;

const VOTE_RESET_MS = 1200;
const GLOBAL_ACCEPT_GAP_MS = 350;

let zxingLoadPromise = null;

function vendorBase() {
  return new URL("../vendor/zxing/", import.meta.url).href;
}

function loadZxing() {
  zxingLoadPromise ||= new Promise((resolve, reject) => {
    if (window.ZXingWASM) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `${vendorBase()}index.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("バーコードエンジンを読み込めませんでした"));
    document.head.appendChild(script);
  }).then(() => window.ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith(".wasm") ? `${vendorBase()}zxing_reader.wasm` : prefix + path)
    },
    fireImmediately: true
  })).then(() => true);
  return zxingLoadPromise;
}

async function pickEngine() {
  if ("BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((format) => supported.includes(format));
      if (formats.includes("ean_13")) {
        return { type: "native", detector: new window.BarcodeDetector({ formats }) };
      }
    } catch (error) {
      // フォールバックへ。
    }
  }
  await loadZxing();
  return { type: "zxing" };
}

function normalizeScannedCode(raw) {
  const value = String(raw || "").trim();
  const digits = digitsOnly(value);
  if ([8, 12, 13, 14].includes(digits.length) && /^[\d\s-]+$/.test(value)) return digits;
  return value;
}

function isEanFamily(format) {
  return /^(ean[-_]?(13|8)|upc[-_]?a)$/i.test(String(format));
}

function isUpcE(format) {
  return /upc[-_]?e/i.test(String(format));
}

// 誤読ガード: EAN/UPC系はチェックデジットを再検証し、外れたコードは捨てる。
function sanitizeCode(raw, format) {
  const code = normalizeScannedCode(raw);
  if (!code) return "";
  if (isUpcE(format)) return code;
  if (isEanFamily(format) || /^\d{8}$|^\d{12,14}$/.test(code)) {
    if (/^\d{8}$|^\d{12,14}$/.test(code) && !validGtinCheckDigit(code)) return "";
  }
  return code;
}

// 同一コードを連続フレームで確認してから確定する(1回の誤読で登録しない)。
// EAN/UPC はチェックデジット済みなので2票、その他は3票。
function requiredVotes(format, code) {
  if ((isEanFamily(format) || isUpcE(format)) && /^\d{8}$|^\d{12,14}$/.test(code)) return 2;
  if (/qr/i.test(String(format))) return 2;
  return 3;
}

let audioContext = null;

export function playBeep(kind = "ok") {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = kind === "ok" ? 1865 : 440;
    gain.gain.setValueAtTime(0.08, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.12);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.13);
  } catch (error) {
    // 音が出せない環境では黙って続行。
  }
  if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 60 : [40, 60, 40]);
}

export function createScanner({ video, onCode, onStatus, cooldownMs = 1500 }) {
  let running = false;
  let stream = null;
  let track = null;
  let engine = null;
  let torchOn = false;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  let candidate = "";
  let candidateFormat = "";
  let votes = 0;
  let lastSeenAt = 0;
  let lastGlobalAcceptAt = 0;
  const lastAcceptedAt = new Map();

  function resetVotes() {
    candidate = "";
    candidateFormat = "";
    votes = 0;
  }

  function grabRoi() {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return null;
    const roiWidth = Math.floor(videoWidth * ROI_WIDTH_RATIO);
    const roiHeight = Math.floor(videoHeight * ROI_HEIGHT_RATIO);
    const roiX = Math.floor((videoWidth - roiWidth) / 2);
    const roiY = Math.floor((videoHeight - roiHeight) / 2);
    const scale = Math.min(1, ROI_MAX_WIDTH / roiWidth);
    canvas.width = Math.max(1, Math.floor(roiWidth * scale));
    canvas.height = Math.max(1, Math.floor(roiHeight * scale));
    context.drawImage(video, roiX, roiY, roiWidth, roiHeight, 0, 0, canvas.width, canvas.height);
    return true;
  }

  async function decodeFrame() {
    if (!grabRoi()) return [];
    if (engine.type === "native") {
      try {
        const codes = await engine.detector.detect(canvas);
        return codes.map((code) => ({ raw: code.rawValue, format: code.format }));
      } catch (error) {
        return [];
      }
    }
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const results = await window.ZXingWASM.readBarcodes(imageData, {
        formats: ZXING_FORMATS,
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        maxNumberOfSymbols: 1
      });
      return results
        .filter((result) => result.isValid !== false && result.text)
        .map((result) => ({ raw: result.text, format: result.format }));
    } catch (error) {
      return [];
    }
  }

  function consider(raw, format) {
    const code = sanitizeCode(raw, format);
    if (!code) return;
    const now = Date.now();
    if (now - lastSeenAt > VOTE_RESET_MS) resetVotes();
    lastSeenAt = now;
    if (code === candidate) {
      votes += 1;
    } else {
      candidate = code;
      candidateFormat = format;
      votes = 1;
    }
    if (votes < requiredVotes(candidateFormat, code)) return;
    if (now - (lastAcceptedAt.get(code) || 0) < cooldownMs) return;
    if (now - lastGlobalAcceptAt < GLOBAL_ACCEPT_GAP_MS) return;
    lastAcceptedAt.set(code, now);
    lastGlobalAcceptAt = now;
    resetVotes();
    onCode?.({ code, format });
  }

  async function loop() {
    while (running) {
      const results = await decodeFrame();
      if (running && results.length) consider(results[0].raw, results[0].format);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("このブラウザではカメラを開始できません。HTTPSのURLで開いているか確認してください。");
    }
    onStatus?.("カメラを起動しています…");
    engine = await pickEngine();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 }
      }
    });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
      else video.onloadedmetadata = resolve;
    });
    await video.play();

    track = stream.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.() || {};
    const advanced = [];
    if (capabilities.focusMode?.includes?.("continuous")) advanced.push({ focusMode: "continuous" });
    if (advanced.length) track.applyConstraints({ advanced }).catch(() => null);

    running = true;
    resetVotes();
    lastAcceptedAt.clear();
    loop();
    onStatus?.(engine.type === "native" ? "スキャン中(高速モード)" : "スキャン中");
  }

  function stop() {
    running = false;
    torchOn = false;
    if (stream) {
      stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
      stream = null;
    }
    track = null;
    video.srcObject = null;
  }

  function capabilities() {
    return track?.getCapabilities?.() || {};
  }

  async function toggleTorch() {
    if (!track || !capabilities().torch) return false;
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {
      torchOn = false;
    });
    return torchOn;
  }

  function zoomRange() {
    const zoom = capabilities().zoom;
    return zoom && typeof zoom.min === "number" ? zoom : null;
  }

  function setZoom(value) {
    if (!track || !zoomRange()) return;
    track.applyConstraints({ advanced: [{ zoom: Number(value) }] }).catch(() => null);
  }

  // 確定直後に同じコードをすぐ再登録したい場合(意図的な連続数え上げ)のために
  // クールダウンを明示的に解除できる。
  function clearCooldown(code) {
    if (code) lastAcceptedAt.delete(code);
    else lastAcceptedAt.clear();
  }

  return {
    start,
    stop,
    toggleTorch,
    zoomRange,
    setZoom,
    clearCooldown,
    isRunning: () => running,
    engineType: () => engine?.type || ""
  };
}
