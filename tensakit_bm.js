/* Tensakit 採点ブックマークレット本体(実DOM対応版)。
 * 採点パネルは仮想リスト(div[data-index])で、画面内のセクションしかDOMに無い。
 * そのためパネルをスクロールして全セクションを描画・収集し、
 * ・各設問の「加点項目/減点項目」チェックボックス、または「生徒の回答」ラジオを読み取り
 * ・答案画像(canvas)と一緒にサーバーのAIへ送って選択を判断し
 * ・返ってきた通りにチェック/選択を入れる(添削完了・コメントは手動)。
 * 現在表示中のページの設問を対象にする(ページを変えたら再実行)。
 * __API_BASE__ はサーバーが配信時に実アプリURL(末尾/)へ置換する。
 */
(function () {
  var API = "__API_BASE__api/tensakit-decide";
  var d = document;
  if (window.__tk_running) { return; }
  window.__tk_running = true;

  function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- 状態表示オーバーレイ ----
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
  function say(msg, color) { box.style.background = color || "#0d2a4d"; txt.textContent = "【AI採点】" + msg; }
  function fin() { window.__tk_running = false; }

  function clean(el) {
    var h = (el && el.outerHTML) || "";
    return h.replace(/<style[\s\S]*?<\/style>/gi, "").slice(0, 250000);
  }
  function panelHTML() {
    try {
      var ins = [].slice.call(d.querySelectorAll("input[type=checkbox],input[type=radio]"));
      var body = "";
      if (ins.length) {
        var a = ins[0];
        ins.forEach(function (n) { while (a && !a.contains(n)) a = a.parentElement; });
        for (var k = 0; k < 3 && a && a.parentElement; k++) a = a.parentElement;
        body = clean(a);
      } else body = "(inputなし。パネル未表示かも)";
      return "=== TENSAKIT PANEL inputs=" + ins.length + " iframes=" + d.querySelectorAll("iframe").length + " ===\n" + body;
    } catch (e) { return "panelHTML error: " + e; }
  }
  function addCopyBtn() {
    var b = d.createElement("button");
    b.textContent = "パネルHTMLを表示してコピー(開発用)";
    b.style.cssText = "margin-top:10px;display:block;padding:7px 12px;font:12px sans-serif;border:0;border-radius:6px;background:#fff;color:#0d2a4d;font-weight:700;";
    b.onclick = function () {
      var s = panelHTML();
      var ta = d.getElementById("__tk_ta");
      if (!ta) { ta = d.createElement("textarea"); ta.id = "__tk_ta"; ta.style.cssText = "margin-top:8px;width:100%;height:120px;font:11px monospace;color:#111;background:#fff;border-radius:6px;padding:6px;"; box.appendChild(ta); }
      ta.value = s; ta.focus(); ta.select();
      var ok = false; try { ok = d.execCommand("copy"); } catch (e) {}
      if (!ok && navigator.clipboard) { try { navigator.clipboard.writeText(s); ok = true; } catch (e) {} }
      b.textContent = (ok ? "コピーしました" : "枠を長押し→全選択→コピー") + " (" + s.length + "文字)";
    };
    box.appendChild(b);
  }

  // ---- 仮想リストのスクロール要素 ----
  function getScroller() {
    var any = d.querySelector("[data-index]");
    if (!any) return null;
    var el = any.parentElement;
    while (el) { var o = getComputedStyle(el).overflowY; if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight + 4) return el; el = el.parentElement; }
    el = any.parentElement;
    while (el) { if (el.scrollHeight > el.clientHeight + 4) return el; el = el.parentElement; }
    return null;
  }

  // 1つの data-index ブロックを解析(ヘッダー or 本体)
  function parseBlock(el) {
    var t = norm(el.textContent || "");
    if (/添削完了/.test(t)) return { header: true, label: norm(t.replace("添削完了", "")) };
    var add = [], ded = [], radios = [];
    [].slice.call(el.querySelectorAll("ul.MuiList-root")).forEach(function (ul) {
      var sub = ul.querySelector("li.MuiListSubheader-root");
      var head = sub ? norm(sub.textContent) : "";
      [].slice.call(ul.querySelectorAll("li.MuiListItem-root")).forEach(function (li) {
        if (!li.querySelector("input[type=checkbox]")) return; // ボタン(適切な理由/減点なし)は除外
        var lab = norm(li.textContent);
        if (/加点/.test(head)) add.push(lab);
        else if (/減点/.test(head)) ded.push(lab);
      });
    });
    [].slice.call(el.querySelectorAll("input[type=radio]")).forEach(function (r) {
      var row = r.closest("label,li,div") || r.parentElement;
      radios.push(norm(row ? row.textContent : ""));
    });
    return { header: false, add: add, ded: ded, radios: radios };
  }

  // パネルをスクロールしながら全 data-index を収集し、セクションを組み立てる
  async function collectSections() {
    var scroller = getScroller();
    var recs = {};
    function grab() {
      [].slice.call(d.querySelectorAll("[data-index]")).forEach(function (el) {
        var i = el.getAttribute("data-index");
        if (recs[i] && recs[i]._filled) return;
        var p = parseBlock(el); p._filled = true; p.i = +i; recs[i] = p;
      });
    }
    if (scroller) {
      scroller.scrollTop = 0; await wait(220); grab();
      var stp = Math.max(150, scroller.clientHeight * 0.7);
      for (var y = 0; y <= scroller.scrollHeight + scroller.clientHeight; y += stp) { scroller.scrollTop = y; await wait(170); grab(); }
      scroller.scrollTop = 0; await wait(150);
    } else grab();
    var keys = Object.keys(recs).map(Number).sort(function (a, b) { return a - b; });
    var secs = [], cur = null;
    keys.forEach(function (k) {
      var r = recs[k];
      if (r.header) { cur = { section_label: r.label, body_index: null, add_options: [], deduct_options: [], radio_options: [] }; secs.push(cur); }
      else if (cur) {
        if (cur.body_index === null) cur.body_index = k;
        r.add.forEach(function (l) { cur.add_options.push({ index: cur.add_options.length, label: l }); });
        r.ded.forEach(function (l) { cur.deduct_options.push({ index: cur.deduct_options.length, label: l }); });
        r.radios.forEach(function (l) { cur.radio_options.push({ index: cur.radio_options.length, label: l }); });
      }
    });
    return secs;
  }

  // data-index を画面内に描画させて返す
  async function ensureIndex(i) {
    var scroller = getScroller();
    for (var t = 0; t < 60; t++) {
      var el = d.querySelector('[data-index="' + i + '"]');
      if (el) { el.scrollIntoView({ block: "center" }); await wait(150); return d.querySelector('[data-index="' + i + '"]'); }
      if (!scroller) return null;
      var r = [].slice.call(d.querySelectorAll("[data-index]")).map(function (e) { return +e.getAttribute("data-index"); });
      var mx = Math.max.apply(null, r), mn = Math.min.apply(null, r);
      if (i > mx) scroller.scrollTop += scroller.clientHeight * 0.7;
      else if (i < mn) scroller.scrollTop -= scroller.clientHeight * 0.7;
      else scroller.scrollTop += scroller.clientHeight * 0.3;
      await wait(150);
    }
    return null;
  }

  function checkboxRows(block, kind) {
    var res = [];
    [].slice.call(block.querySelectorAll("ul.MuiList-root")).forEach(function (ul) {
      var sub = ul.querySelector("li.MuiListSubheader-root");
      var head = sub ? norm(sub.textContent) : "";
      if (kind === "add" && !/加点/.test(head)) return;
      if (kind === "ded" && !/減点/.test(head)) return;
      [].slice.call(ul.querySelectorAll("li.MuiListItem-root")).forEach(function (li) {
        if (!li.querySelector("input[type=checkbox]")) return;
        if (/添削完了/.test(li.textContent || "")) return; // 添削完了は絶対に触らない
        res.push(li);
      });
    });
    return res;
  }
  function isChecked(cb) { return !!cb && (cb.checked || cb.getAttribute("aria-checked") === "true"); }
  // 実際にチェックが入るまで複数の方法を試し、入ったか(true/false)を返す
  function clickItem(li) {
    var cb = li && li.querySelector("input[type=checkbox]");
    if (!cb) return false;
    if (isChecked(cb)) return true;
    (li.querySelector(".MuiListItemButton-root") || li).click();
    if (!isChecked(cb)) cb.click();
    if (!isChecked(cb)) { try { cb.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (e) {} }
    return isChecked(cb);
  }
  function clickRadio(r) {
    if (!r) return false;
    if (r.checked) return true;
    (r.closest("label,li,div") || r).click();
    if (!r.checked) r.click();
    if (!r.checked) { try { r.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (e) {} }
    return r.checked;
  }

  async function applyDecisions(dsecs, secs) {
    var n = 0, hit = [], firstBody = null;
    for (var s = 0; s < dsecs.length; s++) {
      var dec = dsecs[s];
      var sec = secs.filter(function (x) { return x.section_label === dec.section_label; })[0];
      if (!sec || sec.body_index == null) continue;
      var block = await ensureIndex(sec.body_index);
      if (!block) continue;
      var got = 0;
      var addRows = checkboxRows(block, "add");
      (dec.add_indices || []).forEach(function (ix) { if (addRows[ix] && clickItem(addRows[ix])) { n++; got++; } });
      var dedRows = checkboxRows(block, "ded");
      (dec.deduct_indices || []).forEach(function (ix) { if (dedRows[ix] && clickItem(dedRows[ix])) { n++; got++; } });
      if (dec.radio_index != null && dec.radio_index >= 0) {
        var opt = (sec.radio_options || [])[dec.radio_index];
        // 「未回答」は自動選択しない(誤って正解を未回答にする事故を防ぐ)。人が判断。
        if (!(opt && /未回答/.test(opt.label))) {
          var radios = block.querySelectorAll("input[type=radio]");
          if (radios[dec.radio_index] && clickRadio(radios[dec.radio_index])) { n++; got++; }
        }
      }
      if (got > 0) { hit.push(sec.section_label); if (firstBody == null) firstBody = sec.body_index; }
      await wait(120);
    }
    if (firstBody != null) { await ensureIndex(firstBody); }  // 反映箇所が見えるようスクロール
    return { n: n, hit: hit };
  }

  function blobToDataURL(b) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b); });
  }
  // 答案画像を取得。Tensakitは描画用の透明canvasが重なっているので、
  // まず実際の答案<img>をfetchしてdataURL化し、補助的にcanvasも入れる。
  async function grabImages() {
    var out = [];
    var imgs = [].slice.call(d.querySelectorAll("img"))
      .filter(function (im) { return im.naturalWidth > 300 && im.naturalHeight > 300; })
      .sort(function (a, b) { return (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight); });
    for (var j = 0; j < imgs.length && out.length < 2; j++) {
      var src = imgs[j].src;
      if (/^data:/.test(src)) { out.push(src); continue; }
      try { var resp = await fetch(src); var bl = await resp.blob(); out.push(await blobToDataURL(bl)); } catch (e) {}
    }
    if (out.length === 0) {
      var cvs = [].slice.call(d.querySelectorAll("canvas"))
        .filter(function (c) { return c.width > 200 && c.height > 200; })
        .sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
      for (var i = 0; i < cvs.length && out.length < 2; i++) { try { out.push(cvs[i].toDataURL("image/png")); } catch (e) {} }
    }
    return out;
  }

  (async function main() {
    say("採点パネルを読み取り中…(スクロールします)");
    var secs;
    try { secs = await collectSections(); } catch (e) { say("読み取りエラー: " + e, "#8f1f1f"); addCopyBtn(); return fin(); }
    if (!secs.length) { say("採点パネルが見つかりません。採点画面で実行してください。", "#8f1f1f"); addCopyBtn(); return fin(); }

    var images = await grabImages();
    var payload = {
      images: images,
      panel_html: panelHTML(),
      sections: secs.map(function (s) {
        return { section_label: s.section_label, add_options: s.add_options, deduct_options: s.deduct_options, radio_options: s.radio_options };
      })
    };

    say("AIが採点中…(数十秒)  設問 " + secs.length + " 件");
    var data;
    try {
      var res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      data = await res.json();
    } catch (e) { say("通信エラー: " + e + "\n(CSP制限の可能性)", "#8f1f1f"); addCopyBtn(); return fin(); }
    if (data.error) { say("サーバーエラー: " + data.error, "#8f1f1f"); addCopyBtn(); return fin(); }

    var r = { n: 0, hit: [] };
    try { r = await applyDecisions(data.sections || [], secs); }
    catch (e) { say("反映エラー: " + e, "#8f1f1f"); addCopyBtn(); return fin(); }

    var hitTxt = r.hit.length ? ("\n加点/選択した設問: " + r.hit.join(" , ")) : "";
    if (r.n === 0) {
      say("チェックを反映できませんでした(0項目)。読み取ったセクション " + secs.length +
          " 件。ボタン構造が変わった可能性があります。開発用ボタンでHTMLを送ってください。", "#8f1f1f");
    } else {
      say("完了: " + r.n + " 項目にチェックを入れました。" + hitTxt +
          "\n※添削完了・コメント(よく使うコメントから選択)・保存/提出はご自身で。", "#137a4d");
    }
    addCopyBtn();
    fin();
  })();
})();
