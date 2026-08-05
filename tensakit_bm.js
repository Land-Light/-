/* Tensakit 採点ブックマークレット本体。
 * ブックマークレット(ローダー)から注入され、Tensakit採点画面の中で動く。
 * ・採点パネル(加点項目/減点項目/添削完了)を読み取り
 * ・答案画像(canvas)を取得
 * ・アプリのAPIに送ってAIに加点/減点を判断させ
 * ・返ってきた通りにチェックを入れる(コメントは扱わない=使い回し)
 * サーバー側でブラウザを起動しないので無料プランでも動く。
 * __API_BASE__ はサーバーが配信時に実際のアプリURL(末尾/付き)へ置換する。
 */
(function () {
  var API = "__API_BASE__api/tensakit-decide";
  var d = document;

  // 二重起動防止
  if (window.__tk_running) { return; }
  window.__tk_running = true;

  function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // 採点パネルの実際のHTML(構造調整用)。開発者が設問タイプを直すために使う。
  function panelHTML() {
    try {
      var h = [].slice.call(d.querySelectorAll("*")).filter(function (el) {
        return /添削完了/.test(el.textContent || "") && el.children.length <= 4;
      })[0];
      if (!h) return "";
      var c = h;
      for (var k = 0; k < 8 && c.parentElement; k++) c = c.parentElement;
      return (c.outerHTML || "").slice(0, 300000);
    } catch (e) { return ""; }
  }

  // ---- 画面上の小さな状態表示 ----
  var box = d.getElementById("__tk_box");
  if (!box) {
    box = d.createElement("div");
    box.id = "__tk_box";
    box.style.cssText =
      "position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:360px;" +
      "background:#0d2a4d;color:#fff;font:13px/1.6 sans-serif;padding:12px 14px;" +
      "border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:pre-wrap;";
    d.body.appendChild(box);
  }
  box.innerHTML = "";
  var txt = d.createElement("div");
  box.appendChild(txt);
  function say(msg, color) {
    box.style.background = color || "#0d2a4d";
    txt.textContent = "【AI採点】" + msg;
  }
  function done() { window.__tk_running = false; }

  // 採点パネルの実HTMLをコピーするボタン(開発用)。say()で消えないよう box 直下に置く。
  function addCopyBtn(getText) {
    var b = d.createElement("button");
    b.textContent = "パネルHTMLをコピー(開発用)";
    b.style.cssText =
      "margin-top:10px;display:block;padding:7px 12px;font:12px sans-serif;" +
      "border:0;border-radius:6px;background:#fff;color:#0d2a4d;font-weight:700;";
    b.onclick = function () {
      var s = getText() || "";
      try {
        navigator.clipboard.writeText(s).then(function () { b.textContent = "コピーしました"; },
          function () { b.textContent = "コピー失敗(手動選択してください)"; });
      } catch (e) { b.textContent = "コピー失敗: " + e; }
    };
    box.appendChild(b);
  }

  // ---- 採点パネルの読み取り(要素の参照も保持しておく) ----
  function scrape() {
    var heads = [].slice.call(d.querySelectorAll("*")).filter(function (el) {
      return el.children.length <= 4 &&
        /添削完了/.test(el.textContent || "") &&
        ![].slice.call(el.children).some(function (c) { return /添削完了/.test(c.textContent || ""); });
    });
    var secs = [];
    heads.forEach(function (head, hi) {
      var label = norm((head.textContent || "").replace("添削完了", ""));
      var container = head;
      for (var k = 0; k < 5 && container.parentElement; k++) container = container.parentElement;
      var doneEl = head.querySelector('input[type=checkbox]') ||
        (head.parentElement && head.parentElement.querySelector('input[type=checkbox]'));
      var addEls = [], dedEls = [], addOpt = [], dedOpt = [], mode = "";
      [].slice.call(container.querySelectorAll("*")).forEach(function (n) {
        var t = norm(n.textContent || "");
        if (n.children.length === 0 && /加点項目/.test(t)) mode = "add";
        else if (n.children.length === 0 && /減点項目/.test(t)) mode = "ded";
        if (n.matches && n.matches("input[type=checkbox]") && n !== doneEl) {
          var row = n.closest("li,label,tr,div") || n.parentElement;
          var lab = norm(row ? row.textContent : "");
          if (mode === "add") { addOpt.push({ index: addEls.length, label: lab }); addEls.push(n); }
          else if (mode === "ded") { dedOpt.push({ index: dedEls.length, label: lab }); dedEls.push(n); }
        }
      });
      secs.push({
        section_label: label || ("セクション" + (hi + 1)),
        add_options: addOpt, deduct_options: dedOpt,
        _addEls: addEls, _dedEls: dedEls, _doneEl: doneEl
      });
    });
    return secs;
  }

  // ---- 答案画像を取得(canvas優先) ----
  function grabImages() {
    var out = [];
    var cvs = [].slice.call(d.querySelectorAll("canvas"))
      .filter(function (c) { return c.width > 200 && c.height > 200; })
      .sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
    for (var i = 0; i < cvs.length && out.length < 3; i++) {
      try { out.push(cvs[i].toDataURL("image/png")); } catch (e) { /* tainted */ }
    }
    if (out.length === 0) {
      var imgs = [].slice.call(d.querySelectorAll("img"))
        .filter(function (im) { return im.naturalWidth > 300 && im.naturalHeight > 300 && /^data:/.test(im.src); })
        .sort(function (a, b) { return (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight); });
      imgs.slice(0, 3).forEach(function (im) { out.push(im.src); });
    }
    return out;
  }

  // ---- チェックを入れる(React制御のMUIチェックボックスはclickでOK) ----
  function tick(el) {
    if (!el) return;
    var checked = el.getAttribute("aria-checked") === "true" || el.checked;
    if (!checked) {
      var target = el.closest("label,li,div") || el;
      target.click();
    }
  }

  say("採点パネルを読み取り中…");
  var secs;
  try { secs = scrape(); } catch (e) { say("パネル読み取りでエラー: " + e, "#8f1f1f"); return done(); }
  if (!secs.length) {
    say("採点パネルが見つかりませんでした。採点画面(加点項目・添削完了が見える状態)で実行してください。", "#8f1f1f");
    addCopyBtn(panelHTML);
    return done();
  }
  var images = grabImages();
  if (!images.length) {
    say("答案画像を取得できませんでした(canvas無し)。この画面を開発者に伝えてください。", "#b25900");
    // 画像なしでも選択肢のテキストだけで判断を試みる場合はそのまま送る
  }

  var payload = {
    images: images,
    panel_html: panelHTML(),
    sections: secs.map(function (s) {
      return { section_label: s.section_label, add_options: s.add_options, deduct_options: s.deduct_options };
    })
  };

  say("AIが採点中…(数十秒かかります)");
  fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.error) { say("サーバーエラー: " + data.error, "#8f1f1f"); return done(); }
    var checked = 0, dsecs = data.sections || [];
    dsecs.forEach(function (dec) {
      var sec = secs.filter(function (s) { return s.section_label === dec.section_label; })[0];
      if (!sec) return;
      (dec.add_indices || []).forEach(function (i) { tick(sec._addEls[i]); checked++; });
      (dec.deduct_indices || []).forEach(function (i) { tick(sec._dedEls[i]); checked++; });
      // ※「添削完了」は自動で押さない(誤採点で正解が0点=バツになるのを防ぐ)。
      //   点検後にご自身でチェックしてください。
    });
    say("完了: " + dsecs.length + "セクション / " + checked + "項目にチェックしました。\n" +
        "※添削完了は自動では押しません。内容を確認し、コメント選択・添削完了・保存/提出はご自身で。", "#137a4d");
    addCopyBtn(panelHTML);
    done();
  }).catch(function (e) {
    say("通信エラー: " + e + "\n(サイトのCSP制限でAPIに繋げない可能性があります。開発者に伝えてください)", "#8f1f1f");
    addCopyBtn(panelHTML);
    done();
  });
})();
