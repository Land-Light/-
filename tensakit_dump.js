/* Tensakit 構造取得(開発用)ブックマークレット。
 * 採点も画面遷移もせず、今表示されている採点パネルのHTMLを取り出して
 * テキスト枠に表示・コピーするだけ。減点項目を「＋」で開いた状態など、
 * 特定の画面状態をそのまま開発者に送るために使う。
 */
(function () {
  var d = document;
  function clean(el) {
    var h = (el && el.outerHTML) || "";
    h = h.replace(/<style[\s\S]*?<\/style>/gi, "");
    // 巨大なbase64画像データを除去(これが容量を食って肝心のパネルが切れる)
    h = h.replace(/(href|src|xlink:href)="data:[^"]*"/gi, '$1="data:..."');
    return h.slice(0, 200000);
  }
  function txt(x) { return x.textContent || ""; }
  var el = null, tag = "";
  // (1) 減点の「＋」を開いた状態(減点項目 と 閉じる を両方含む最小要素)を最優先
  var open = [].slice.call(d.querySelectorAll("div,section,ul,li"))
    .filter(function (x) { return /減点項目/.test(txt(x)) && /閉じる/.test(txt(x)) && x.children.length <= 80; })
    .sort(function (a, b) { return a.children.length - b.children.length; });
  if (open.length) { el = open[0]; tag = "減点ダイアログ"; }
  // (2) 通常の採点パネル(減点項目/加点項目を含む塊)
  if (!el) {
    var pan = [].slice.call(d.querySelectorAll("div,section,ul"))
      .filter(function (x) { return /減点項目|加点項目/.test(txt(x)) && x.children.length <= 60; })
      .sort(function (a, b) { return b.children.length - a.children.length; });
    if (pan.length) { el = pan[0]; for (var k = 0; k < 3 && el.parentElement; k++) el = el.parentElement; tag = "採点パネル"; }
  }
  if (!el) { el = d.body; tag = "body"; }
  var html = "=== TENSAKIT DUMP (" + tag + ") ===\n" + clean(el);

  var old = d.getElementById("__tk_dump"); if (old) old.remove();
  var box = d.createElement("div");
  box.id = "__tk_dump";
  box.style.cssText = "position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;" +
    "background:#0d2a4d;color:#fff;padding:10px 12px;border-radius:10px;font:12px sans-serif;";
  var msg = d.createElement("div"); msg.textContent = "採点パネルのHTML(下の枠を全選択→コピーして貼り付け):";
  var ta = d.createElement("textarea");
  ta.value = html;
  ta.style.cssText = "width:100%;height:150px;margin-top:6px;font:11px monospace;color:#111;background:#fff;border-radius:6px;padding:6px;";
  var close = d.createElement("button");
  close.textContent = "閉じる";
  close.style.cssText = "margin-top:6px;padding:5px 12px;border:0;border-radius:6px;background:#fff;color:#0d2a4d;font-weight:700;";
  close.onclick = function () { box.remove(); };
  box.appendChild(msg); box.appendChild(ta); box.appendChild(close);
  d.body.appendChild(box);
  ta.focus(); ta.select();
  try { d.execCommand("copy"); } catch (e) {}
})();
