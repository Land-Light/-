/* Tensakit 構造取得(開発用)ブックマークレット。
 * 採点も画面遷移もせず、今表示されている採点パネルのHTMLを取り出して
 * テキスト枠に表示・コピーするだけ。減点項目を「＋」で開いた状態など、
 * 特定の画面状態をそのまま開発者に送るために使う。
 */
(function () {
  var d = document;
  function clean(el) {
    var h = (el && el.outerHTML) || "";
    return h.replace(/<style[\s\S]*?<\/style>/gi, "").slice(0, 250000);
  }
  var ins = [].slice.call(d.querySelectorAll("input[type=checkbox],input[type=radio]"));
  var el;
  if (ins.length) {
    el = ins[0];
    ins.forEach(function (n) { while (el && !el.contains(n)) el = el.parentElement; });
    for (var k = 0; k < 4 && el && el.parentElement; k++) el = el.parentElement;
  } else {
    // チェックボックスが無い状態(減点ダイアログ等)は、'減点項目'を含む塊を拾う
    el = [].slice.call(d.querySelectorAll("*")).filter(function (x) {
      return /減点項目|加点項目|添削完了/.test(x.textContent || "") && x.children.length <= 30;
    })[0] || d.body;
    for (var j = 0; j < 4 && el && el.parentElement; j++) el = el.parentElement;
  }
  var html = "=== TENSAKIT DUMP inputs=" + ins.length + " ===\n" + clean(el);

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
