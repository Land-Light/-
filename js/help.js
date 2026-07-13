// 入室画面の「使い方」ボタンから開く、ページ送り式の説明スライド。
// イラストはインラインSVG(装飾)+ 箇条書きテキストで構成する。

const ACCENT = "#1f7a5b";
const ACCENT_SOFT = "#bfe3d2";
const INK = "#24483d";

function phoneArt(x, y, w = 62, h = 108) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#fff" stroke="${ACCENT}" stroke-width="3"/>
    <rect x="${x + 10}" y="${y + 12}" width="${w - 20}" height="8" rx="4" fill="${ACCENT_SOFT}"/>
    <rect x="${x + 10}" y="${y + 26}" width="${w - 26}" height="8" rx="4" fill="#e2ece6"/>
    <rect x="${x + 10}" y="${y + 40}" width="${w - 20}" height="8" rx="4" fill="#e2ece6"/>
  `;
}

const SLIDES = [
  {
    title: "「部屋」を作ってみんなで共有",
    points: [
      "担当者名を入れて「部屋を作る」を押すと、6桁の部屋コードができます。",
      "ほかの人は「リンクコピー」で送られたURLを開くか、部屋コードを入力して参加します。",
      "入力した数はリアルタイムで全員の画面に反映されます。",
      "部屋は作成から7日たつと自動で削除されます。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="2台のスマホで部屋コードを共有するイラスト">
      ${phoneArt(28, 21)}
      ${phoneArt(230, 21)}
      <rect x="117" y="56" width="86" height="32" rx="16" fill="${ACCENT}"/>
      <text x="160" y="78" text-anchor="middle" fill="#fff" font-size="15" font-weight="bold" font-family="ui-monospace, monospace">A7KQ2M</text>
      <path d="M96 72 h14 m-7 -6 l7 6 l-7 6" stroke="${ACCENT}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M224 72 h-14 m7 -6 l-7 6 l7 6" stroke="${ACCENT}" stroke-width="3" fill="none" stroke-linecap="round"/>
    </svg>`
  },
  {
    title: "商品マスタの登録と「ロック」",
    points: [
      "「設定」タブで、棚卸する商品(JAN・商品名・予定数)を登録します。",
      "誤操作防止のため、最初はロックされています。「ロック解除」を押して「解除」と入力すると編集できます。",
      "JANは手入力のほか、カメラ読取でも入れられます。",
      "編集が終わったら「ロックする」で再ロックしておくと安心です。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="商品登録フォームと鍵のイラスト">
      <rect x="30" y="30" width="170" height="26" rx="6" fill="#fff" stroke="#c9d6cd" stroke-width="2"/>
      <text x="40" y="48" fill="#8aa295" font-size="13">4901234567894</text>
      <rect x="30" y="64" width="170" height="26" rx="6" fill="#fff" stroke="#c9d6cd" stroke-width="2"/>
      <text x="40" y="82" fill="#8aa295" font-size="13">緑茶 500ml</text>
      <rect x="30" y="98" width="90" height="26" rx="6" fill="${ACCENT}"/>
      <text x="75" y="116" text-anchor="middle" fill="#fff" font-size="13" font-weight="bold">登録</text>
      <rect x="240" y="62" width="52" height="44" rx="8" fill="${ACCENT}"/>
      <path d="M252 62 v-12 a14 14 0 0 1 28 0 v12" stroke="${ACCENT}" stroke-width="7" fill="none"/>
      <circle cx="266" cy="80" r="6" fill="#fff"/>
      <rect x="263" y="82" width="6" height="14" rx="3" fill="#fff"/>
    </svg>`
  },
  {
    title: "スマレジなどのデータをCSV取込",
    points: [
      "スマレジ等のレジ・在庫システムから出力した商品データ(CSV)を、そのまま取り込めます。",
      "Excelで作った表も「CSV形式で保存」すれば取り込めます。文字コード(Shift-JIS / UTF-8)は自動判別します。",
      "「JANコード」「商品名」「在庫数」などの列を自動で見つけます。関係ない列が混ざっていても無視します。",
      "金額・価格などの列を在庫数と間違えることはありません。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="CSVファイルをアプリに取り込むイラスト">
      <rect x="36" y="22" width="92" height="106" rx="8" fill="#fff" stroke="${ACCENT}" stroke-width="3"/>
      <text x="82" y="45" text-anchor="middle" fill="${ACCENT}" font-size="14" font-weight="bold">CSV</text>
      <line x1="48" y1="58" x2="116" y2="58" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="48" y1="74" x2="116" y2="74" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="48" y1="90" x2="116" y2="90" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="48" y1="106" x2="116" y2="106" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="70" y1="52" x2="70" y2="112" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="96" y1="52" x2="96" y2="112" stroke="#c9d6cd" stroke-width="2"/>
      <path d="M142 75 h34 m-12 -9 l12 9 l-12 9" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
      ${phoneArt(212, 21)}
      <text x="243" y="112" text-anchor="middle" fill="${ACCENT}" font-size="11" font-weight="bold">自動判別</text>
    </svg>`
  },
  {
    title: "数量入力の基本",
    points: [
      "「入力」タブでJANをカメラ読取するか、商品名で検索して選びます。",
      "棚番と数量を入れて「加算」。同じ棚×同じ商品は自動で合算されます。",
      "マスタに無い商品も仮登録されるので、そのまま数えられます。",
      "間違えたら明細の「編集」「-1」「削除」、または「直前取消」ボタンで戻せます。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="バーコードと入力欄のイラスト">
      <g fill="${INK}">
        <rect x="40" y="26" width="6" height="44"/><rect x="50" y="26" width="3" height="44"/>
        <rect x="58" y="26" width="9" height="44"/><rect x="71" y="26" width="3" height="44"/>
        <rect x="79" y="26" width="6" height="44"/><rect x="90" y="26" width="3" height="44"/>
        <rect x="97" y="26" width="8" height="44"/><rect x="110" y="26" width="4" height="44"/>
        <rect x="119" y="26" width="7" height="44"/>
      </g>
      <text x="83" y="86" text-anchor="middle" fill="${INK}" font-size="12" font-family="ui-monospace, monospace">4901234567894</text>
      <rect x="170" y="30" width="70" height="26" rx="6" fill="#fff" stroke="#c9d6cd" stroke-width="2"/>
      <text x="205" y="48" text-anchor="middle" fill="#8aa295" font-size="12">棚 001</text>
      <rect x="248" y="30" width="42" height="26" rx="6" fill="#fff" stroke="#c9d6cd" stroke-width="2"/>
      <text x="269" y="48" text-anchor="middle" fill="#8aa295" font-size="12">×1</text>
      <rect x="170" y="66" width="120" height="30" rx="8" fill="${ACCENT}"/>
      <text x="230" y="87" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">加算</text>
      <rect x="40" y="106" width="250" height="24" rx="6" fill="#eef4f1"/>
      <text x="50" y="123" fill="${INK}" font-size="12">001 / 4901234567894 / 緑茶 500ml / 1</text>
    </svg>`
  },
  {
    title: "連続スキャン(かざすだけで+1)",
    points: [
      "「連続スキャン」を押して棚番を決めたら、あとは商品を枠にかざすだけで1点ずつ自動加算されます。",
      "読み取るとピッと音とバイブでお知らせ。読み間違いを防ぐ検算付きです。",
      "同じ商品を続けて数えるときは、約1.5秒あけてかざし直してください。",
      "暗い場所は「ライト」、遠い棚は「ズーム」が使えます(対応スマホのみ)。読み間違えたら「直前取消」。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="スキャン画面のイラスト">
      <rect x="106" y="12" width="108" height="130" rx="12" fill="#0d1a13" stroke="${ACCENT}" stroke-width="3"/>
      <rect x="120" y="46" width="80" height="46" rx="8" fill="none" stroke="#7ee8bb" stroke-width="3"/>
      <line x1="126" y1="69" x2="194" y2="69" stroke="#7ee8bb" stroke-width="2"/>
      <g fill="#e8f5ee">
        <rect x="130" y="54" width="4" height="30"/><rect x="138" y="54" width="2" height="30"/>
        <rect x="144" y="54" width="6" height="30"/><rect x="154" y="54" width="2" height="30"/>
        <rect x="160" y="54" width="4" height="30"/><rect x="168" y="54" width="5" height="30"/>
        <rect x="177" y="54" width="2" height="30"/><rect x="183" y="54" width="4" height="30"/>
      </g>
      <circle cx="236" cy="40" r="18" fill="${ACCENT}"/>
      <text x="236" y="46" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">+1</text>
      <path d="M262 30 q10 10 0 20 M270 22 q18 18 0 36" stroke="${ACCENT_SOFT}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="160" y="126" text-anchor="middle" fill="#9fc3b2" font-size="11">ピッ ♪</text>
    </svg>`
  },
  {
    title: "複数人で同時に数える",
    points: [
      "何台で入力しても自動で合算されます。同時に入力してもデータは壊れません。",
      "「入力」タブには自分の入力だけが表示され、全員分は「確認」タブで見られます。",
      "途中で帰る人がいるときは「引継ぎ」機能が使えます(詳しくは次のページ)。",
      "電波が切れても端末に保存され、つながったときに自動送信されます。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="複数のスマホが同期するイラスト">
      ${phoneArt(30, 30, 54, 92)}
      ${phoneArt(133, 30, 54, 92)}
      ${phoneArt(236, 30, 54, 92)}
      <circle cx="160" cy="14" r="9" fill="${ACCENT}"/>
      <path d="M57 30 Q100 2 151 12 M160 23 v7 M263 30 Q220 2 169 12" stroke="${ACCENT_SOFT}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="57" y="142" text-anchor="middle" fill="${INK}" font-size="11">佐藤</text>
      <text x="160" y="142" text-anchor="middle" fill="${INK}" font-size="11">鈴木</text>
      <text x="263" y="142" text-anchor="middle" fill="${INK}" font-size="11">田中</text>
    </svg>`
  },
  {
    title: "引継ぎ(途中で退室する人がいるとき)",
    points: [
      "数えている途中で帰る人・抜ける人がいても大丈夫。残った入力は消えずに全体の合計に残ります。",
      "続きを自分が直したいときは、「入力」タブの「引継ぎ」ボタンを押します。",
      "他の担当者の入力一覧から番号を選ぶと、その明細が自分のものになり、自分の「入力」タブで編集・修正できるようになります。",
      "たとえば「田中さんが棚005を数えかけで帰った」ときに、続きを引き取って仕上げる、という使い方ができます。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="入力明細を別の担当者へ引き継ぐイラスト">
      <circle cx="70" cy="42" r="16" fill="#c9d6cd"/>
      <path d="M42 96 a28 20 0 0 1 56 0" fill="#c9d6cd"/>
      <path d="M92 24 l14 -10 M99 30 l16 -4" stroke="#c9d6cd" stroke-width="3" stroke-linecap="round"/>
      <text x="70" y="122" text-anchor="middle" fill="#8aa295" font-size="11">お先に…</text>
      <circle cx="250" cy="42" r="16" fill="${ACCENT}"/>
      <path d="M222 96 a28 20 0 0 1 56 0" fill="${ACCENT}"/>
      <text x="250" y="122" text-anchor="middle" fill="${INK}" font-size="11" font-weight="bold">続きは任せて</text>
      <rect x="128" y="46" width="66" height="40" rx="6" fill="#fff" stroke="${ACCENT}" stroke-width="2.5"/>
      <line x1="136" y1="58" x2="186" y2="58" stroke="#c9d6cd" stroke-width="2.5"/>
      <line x1="136" y1="66" x2="186" y2="66" stroke="#c9d6cd" stroke-width="2.5"/>
      <line x1="136" y1="74" x2="172" y2="74" stroke="#c9d6cd" stroke-width="2.5"/>
      <path d="M198 66 h18 m-8 -7 l8 7 l-8 7" stroke="${ACCENT}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    </svg>`
  },
  {
    title: "差異確認と進捗",
    points: [
      "「確認」タブで、予定数と数えた数の差異を確認できます。差異が大きい順に並びます。",
      "進捗バーで「全体のうち何商品まで数え終わったか」がひと目でわかります。",
      "「差異ありだけ表示」やJAN・商品名・担当者の検索で絞り込めます。",
      "商品ごとに「どの棚で誰が何個数えたか」の内訳も表示されます。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="進捗バーと差異表のイラスト">
      <rect x="36" y="24" width="248" height="14" rx="7" fill="#e2e9e3"/>
      <rect x="36" y="24" width="174" height="14" rx="7" fill="${ACCENT}"/>
      <text x="284" y="55" text-anchor="end" fill="${INK}" font-size="12" font-weight="bold">進捗 70%</text>
      <rect x="36" y="68" width="248" height="24" rx="6" fill="#fff" stroke="#e2e9e3" stroke-width="2"/>
      <text x="46" y="85" fill="${INK}" font-size="12">緑茶 500ml</text>
      <rect x="222" y="72" width="52" height="17" rx="8" fill="#fde8e8"/>
      <text x="248" y="85" text-anchor="middle" fill="#b63b3b" font-size="11" font-weight="bold">-2</text>
      <rect x="36" y="100" width="248" height="24" rx="6" fill="#fff" stroke="#e2e9e3" stroke-width="2"/>
      <text x="46" y="117" fill="${INK}" font-size="12">コーヒー微糖</text>
      <rect x="222" y="104" width="52" height="17" rx="8" fill="#fff1dc"/>
      <text x="248" y="117" text-anchor="middle" fill="#b66916" font-size="11" font-weight="bold">+1</text>
    </svg>`
  },
  {
    title: "CSV出力(スマレジへそのまま取込)",
    points: [
      "「CSV出力」ボタンで、左から「商品コード・棚卸数量・明細メモ」の3列のCSVをダウンロードできます。",
      "スマレジの棚卸のCSV取込に、このファイルをそのまま使えます。商品コード(JAN)と棚卸数量の列を指定して取り込んでください。",
      "明細メモには棚番ごとの数量内訳が入っているので、あとから「どの棚に何個あったか」を確認できます。",
      "部屋は7日で自動削除されるので、棚卸が終わったらCSVを保存しておきましょう。"
    ],
    art: `<svg viewBox="0 0 320 150" role="img" aria-label="CSVをダウンロードするイラスト">
      ${phoneArt(46, 21)}
      <path d="M124 75 h34 m-12 -9 l12 9 l-12 9" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <rect x="182" y="30" width="86" height="92" rx="8" fill="#fff" stroke="${ACCENT}" stroke-width="3"/>
      <text x="225" y="55" text-anchor="middle" fill="${ACCENT}" font-size="14" font-weight="bold">CSV</text>
      <line x1="194" y1="68" x2="256" y2="68" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="194" y1="82" x2="256" y2="82" stroke="#c9d6cd" stroke-width="2"/>
      <line x1="194" y1="96" x2="256" y2="96" stroke="#c9d6cd" stroke-width="2"/>
      <path d="M283 96 v22 m-8 -9 l8 9 l8 -9 M269 126 h28" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  }
];

export function initHelp(openButton) {
  const modal = document.createElement("div");
  modal.className = "help-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="help-card" role="dialog" aria-modal="true" aria-label="使い方">
      <div class="help-head">
        <span class="help-count"></span>
        <button type="button" class="help-close" aria-label="閉じる">×</button>
      </div>
      <div class="help-art"></div>
      <h2 class="help-title"></h2>
      <ul class="help-points"></ul>
      <div class="help-nav">
        <button type="button" class="help-prev ghost">‹ 前へ</button>
        <div class="help-dots"></div>
        <button type="button" class="help-next">次へ ›</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const card = modal.querySelector(".help-card");
  const artEl = modal.querySelector(".help-art");
  const titleEl = modal.querySelector(".help-title");
  const pointsEl = modal.querySelector(".help-points");
  const countEl = modal.querySelector(".help-count");
  const dotsEl = modal.querySelector(".help-dots");
  const prevButton = modal.querySelector(".help-prev");
  const nextButton = modal.querySelector(".help-next");
  const closeButton = modal.querySelector(".help-close");

  let page = 0;

  function show(index) {
    page = Math.max(0, Math.min(SLIDES.length - 1, index));
    const slide = SLIDES[page];
    artEl.innerHTML = slide.art;
    titleEl.textContent = slide.title;
    pointsEl.innerHTML = slide.points.map((point) => `<li>${point}</li>`).join("");
    countEl.textContent = `使い方 ${page + 1} / ${SLIDES.length}`;
    dotsEl.innerHTML = SLIDES.map((_, i) =>
      `<button type="button" class="help-dot${i === page ? " active" : ""}" data-page="${i}" aria-label="${i + 1}ページ目"></button>`
    ).join("");
    prevButton.disabled = page === 0;
    nextButton.textContent = page === SLIDES.length - 1 ? "閉じる" : "次へ ›";
    card.scrollTop = 0;
  }

  function open() {
    modal.hidden = false;
    document.body.classList.add("help-open");
    show(0);
    nextButton.focus();
  }

  function close() {
    modal.hidden = true;
    document.body.classList.remove("help-open");
  }

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  prevButton.addEventListener("click", () => show(page - 1));
  nextButton.addEventListener("click", () => {
    if (page === SLIDES.length - 1) close();
    else show(page + 1);
  });
  dotsEl.addEventListener("click", (event) => {
    const target = event.target.closest(".help-dot");
    if (target) show(Number(target.dataset.page));
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (modal.hidden) return;
    if (event.key === "Escape") close();
    if (event.key === "ArrowRight") show(page + 1);
    if (event.key === "ArrowLeft") show(page - 1);
  });

  // スワイプでページ送り
  let touchStartX = 0;
  card.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0].clientX;
  }, { passive: true });
  card.addEventListener("touchend", (event) => {
    const delta = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) < 45) return;
    show(delta < 0 ? page + 1 : page - 1);
  }, { passive: true });
}
