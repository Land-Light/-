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

  // ---- 減点(「＋」で開いて -1 の番号行を選ぶ) ----
  function toAsciiNum(s) { return (s || "").replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
  function deductPlusButton(block) {  // 減点項目 見出しの「＋」ボタン
    var uls = block.querySelectorAll("ul.MuiList-root");
    for (var i = 0; i < uls.length; i++) {
      var sub = uls[i].querySelector("li.MuiListSubheader-root");
      if (sub && /減点項目/.test(sub.textContent || "")) return sub.querySelector("button");
    }
    return null;
  }
  function deductRows(block) {  // 開いた減点一覧の各行(番号と押す要素)
    var rows = [];
    [].slice.call(block.querySelectorAll(".MuiCollapse-root li.MuiListItem-root")).forEach(function (li) {
      var h6 = li.querySelector("h6");
      if (!h6 || !/-1/.test(h6.textContent || "")) return;
      var p = li.querySelector("p");
      var num = parseInt(toAsciiNum(p ? p.textContent : ""), 10);
      if (!isNaN(num)) rows.push({ num: num, el: li.querySelector(".MuiListItemButton-root") || li });
    });
    return rows;
  }
  async function applyDeductions(bodyIndex, numbers) {
    var got = 0;
    var block = await ensureIndex(bodyIndex);
    if (!block) return 0;
    if (deductRows(block).length === 0) {  // まだ開いていなければ「＋」を押す
      var plus = deductPlusButton(block);
      if (!plus) return 0;
      plus.click(); await wait(450);
      block = d.querySelector('[data-index="' + bodyIndex + '"]') || block;
    }
    for (var i = 0; i < numbers.length; i++) {
      block = d.querySelector('[data-index="' + bodyIndex + '"]') || block;
      var row = deductRows(block).filter(function (r) { return r.num === numbers[i]; })[0];
      if (row && row.el) { row.el.click(); got++; await wait(300); }
    }
    // 閉じる
    block = d.querySelector('[data-index="' + bodyIndex + '"]') || block;
    var close = [].slice.call(block.querySelectorAll("button")).filter(function (b) { return /閉じる/.test(b.textContent || ""); })[0];
    if (close) { close.click(); await wait(200); }
    return got;
  }

  async function applyDecisions(dsecs, secs) {
    var n = 0, hit = [], firstBody = null;
    function nl(x) { return (x || "").replace(/\s+/g, ""); }  // 空白差を無視して照合
    for (var s = 0; s < dsecs.length; s++) {
      var dec = dsecs[s];
      var sec = secs.filter(function (x) { return nl(x.section_label) === nl(dec.section_label); })[0];
      if (!sec || sec.body_index == null) continue;
      var block = await ensureIndex(sec.body_index);
      if (!block) continue;
      var got = 0;
      var addRows = checkboxRows(block, "add");
      (dec.add_indices || []).forEach(function (ix) { if (addRows[ix] && clickItem(addRows[ix])) { n++; got++; } });
      if (dec.radio_index != null && dec.radio_index >= 0) {
        var opt = (sec.radio_options || [])[dec.radio_index];
        // 「未回答」は自動選択しない(誤って正解を未回答にする事故を防ぐ)。人が判断。
        if (!(opt && /未回答/.test(opt.label))) {
          var radios = block.querySelectorAll("input[type=radio]");
          if (radios[dec.radio_index] && clickRadio(radios[dec.radio_index])) { n++; got++; }
        }
      }
      // 減点(採点基準の番号に対応する -1 を「＋」→行クリック→閉じる)
      var dn = (dec.deduct_numbers || []).filter(function (x) { return typeof x === "number" && x > 0; });
      if (dn.length) {
        var dg = await applyDeductions(sec.body_index, dn);
        n += dg; got += dg;
      }
      if (got > 0) { hit.push(sec.section_label); if (firstBody == null) firstBody = sec.body_index; }
      await wait(120);
    }
    if (firstBody != null) { await ensureIndex(firstBody); }  // 反映箇所が見えるようスクロール
    return { n: n, hit: hit };
  }

  // ページ送りナビ(「N / M ページ」の左右ボタン)
  function pageNav() {
    var li = [].slice.call(d.querySelectorAll("li")).filter(function (e) {
      var t = e.textContent || ""; return /\d+\s*\/\s*\d+/.test(t) && /ページ/.test(t);
    })[0];
    if (!li) return null;
    var m = (li.textContent || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return { cur: +m[1], total: +m[2], prev: li.previousElementSibling, next: li.nextElementSibling };
  }
  async function gotoPage(target) {
    for (var i = 0; i < 25; i++) {
      var p = pageNav(); if (!p) return;
      if (p.cur === target) return;
      if (p.cur < target && p.next) p.next.click();
      else if (p.prev) p.prev.click();
      await wait(500);
    }
  }
  // canvas を(縮小して)dataURL化。答案はcanvasに描画されているため。
  function canvasToData(c) {
    try {
      var scale = Math.min(1, 1400 / Math.max(c.width, c.height));
      if (scale < 1) {
        var t = d.createElement("canvas");
        t.width = Math.round(c.width * scale); t.height = Math.round(c.height * scale);
        t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
        return t.toDataURL("image/jpeg", 0.85);
      }
      return c.toDataURL("image/jpeg", 0.85);
    } catch (e) { return null; }  // taintで失敗する場合あり
  }
  function bigCanvases() {
    return [].slice.call(d.querySelectorAll("canvas")).filter(function (c) { return c.width > 300 && c.height > 300; });
  }
  function svgImages() { return [].slice.call(d.querySelectorAll("image")); }  // SVG内<image>(HTMLの<img>と別物)
  function svgHref(el) { return el.getAttribute("href") || el.getAttribute("xlink:href") || ""; }
  function blobToDataURL(b) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b); });
  }
  async function srcToData(u) {  // blob:/http/data を可能ならdataURL化(同一オリジンのblobは確実)
    if (!u) return null;
    if (/^data:/.test(u)) return u;
    try { var r = await fetch(u); var b = await r.blob(); return await blobToDataURL(b); } catch (e) { return null; }
  }
  // 答案がどの要素で描画されているかを調べる(取得できない原因の切り分け用)
  function domInfo() {
    var cs = d.querySelectorAll("canvas").length;
    var im = d.querySelectorAll("img").length;
    var sv = d.querySelectorAll("svg").length;
    var si = svgImages();
    var href = si[0] ? svgHref(si[0]).slice(0, 34) : "";
    var bg = 0, bgU = "";
    var els = d.querySelectorAll("div,section,figure,span");
    for (var i = 0; i < els.length && bg < 1; i++) {
      var b = getComputedStyle(els[i]).backgroundImage;
      if (b && b !== "none" && /url\(/.test(b)) { bg++; bgU = b.slice(0, 40); }
    }
    var obj = d.querySelectorAll("object,embed,iframe").length;
    return "canvas=" + cs + " img=" + im + " svg=" + sv + " svgimage=" + si.length +
      (href ? "(" + href + ")" : "") + " bg=" + bg + (bgU ? "(" + bgU + ")" : "") + " obj=" + obj;
  }
  // 全ページの答案画像を集める。canvas/SVG image/img を対象に、
  // dataURL化できるものは images へ、http(s)はサーバー取得用に urls へ。
  async function captureAll() {
    var images = [], urls = [];
    async function grabPage() {
      bigCanvases().forEach(function (c) { var du = canvasToData(c); if (du) images.push(du); });
      var si = svgImages();
      for (var k = 0; k < si.length; k++) {
        var h = svgHref(si[k]); if (!h) continue;
        if (/^https?:/.test(h)) urls.push(h);
        var du2 = await srcToData(h); if (du2) images.push(du2);
      }
      var im = [].slice.call(d.querySelectorAll("img")).filter(function (x) { return x.naturalWidth > 200; });
      for (var m = 0; m < im.length; m++) {
        var s = im[m].src;
        if (/^data:/.test(s)) images.push(s);
        else { if (/^https?:/.test(s)) urls.push(s); var du3 = await srcToData(s); if (du3) images.push(du3); }
      }
    }
    var p = pageNav(); var pages = p ? p.total : 1;
    if (p) await gotoPage(1);
    for (var pg = 1; pg <= pages && pg <= 8 && images.length < 8; pg++) {
      if (p) { await gotoPage(pg); await wait(700); }
      await grabPage();
    }
    return { images: images.slice(0, 8), urls: urls.slice(0, 8) };
  }

  (async function main() {
    say("採点パネルを読み取り中…(スクロールします)");
    var secs;
    try { secs = await collectSections(); } catch (e) { say("読み取りエラー: " + e, "#8f1f1f"); addCopyBtn(); return fin(); }
    if (!secs.length) { say("採点パネルが見つかりません。採点画面で実行してください。", "#8f1f1f"); addCopyBtn(); return fin(); }

    say("答案ページを取得中…(ページを送ります)");
    var cap = { images: [], urls: [] };
    try { cap = await captureAll(); } catch (e) {}
    if (cap.images.length === 0 && cap.urls.length === 0) {
      say("答案画像を取得できませんでした。以下を開発者に伝えてください:\n" + domInfo(), "#b25900");
      addCopyBtn();
      return fin();  // 答案が無いままAIに投げても誤採点になるので中止
    }
    var payload = {
      images: cap.images,
      image_urls: cap.urls,
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
    var dbg = data.debug || {};
    var dbgTxt = "\n[診断] 答案画像 " + (dbg.images_ok != null ? dbg.images_ok : "?") +
      "枚, AI選択した設問 " + (dbg.with_selection != null ? dbg.with_selection : "?") +
      "/" + (dbg.decided != null ? dbg.decided : "?") + ", 読取セクション " + secs.length;
    if (r.n === 0) {
      var why = (dbg.images_ok === 0)
        ? "答案画像をサーバーが取得できていません(画像がログイン必須の可能性)。"
        : (dbg.with_selection === 0 ? "AIが選択を返しませんでした(答案を読めていない可能性)。" : "チェックの反映に失敗しました。");
      say("反映できませんでした(0項目)。" + why + dbgTxt, "#8f1f1f");
    } else {
      say("完了: " + r.n + " 項目にチェックを入れました。" + hitTxt + dbgTxt +
          "\n※添削完了・コメント(よく使うコメントから選択)・保存/提出はご自身で。", "#137a4d");
    }
    addCopyBtn();
    fin();
  })();
})();
