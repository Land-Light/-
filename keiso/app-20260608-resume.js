(function(){
  const SAVE_KEY = "keiso_quiz_progress_v1";
  const els = {
    year: document.getElementById("yearSelect"),
    mode: document.getElementById("modeSelect"),
    shuffle: document.getElementById("shuffleBtn"),
    reset: document.getElementById("resetBtn"),
    score: document.getElementById("scorePill"),
    section: document.getElementById("sectionName"),
    pos: document.getElementById("positionText"),
    fill: document.getElementById("progressFill"),
    pane: document.getElementById("questionPane"),
    qBadge: document.getElementById("qBadge"),
    yearBadge: document.getElementById("yearBadge"),
    answerBadge: document.getElementById("answerBadge"),
    qText: document.getElementById("questionText"),
    result: document.getElementById("resultBox"),
    resultCard: document.getElementById("resultCard"),
    resultMark: document.getElementById("resultMark"),
    resultWord: document.getElementById("resultWord"),
    resultAnswer: document.getElementById("resultAnswer"),
    exp: document.getElementById("explanationText"),
    yes: document.getElementById("yesBtn"),
    no: document.getElementById("noBtn"),
    yesLabel: document.getElementById("yesLabel"),
    noLabel: document.getElementById("noLabel"),
    prev: document.getElementById("prevBtn"),
    next: document.getElementById("nextBtn"),
    answered: document.getElementById("answeredText"),
    correct: document.getElementById("correctText")
  };

  let state = loadState();
  let list = [];
  let current = 0;
  let reviewRunAnswers = {};

  function defaultState(){
    return {
      answers: {},
      wrongEver: {},
      filterYear: "all",
      filterMode: "all",
      currentId: null,
      shuffled: false,
      orderSeed: Date.now()
    };
  }

  function loadState(){
    try{
      const parsed = JSON.parse(localStorage.getItem(SAVE_KEY));
      const loaded = Object.assign(defaultState(), parsed || {});
      loaded.wrongEver = Object.assign({}, loaded.wrongEver || {});
      Object.keys(loaded.answers || {}).forEach(id => {
        const q = QUESTIONS.find(item => item.id === id);
        if(q && loaded.answers[id] && loaded.answers[id].choice !== q.answer){
          loaded.wrongEver[id] = true;
        }
      });
      return loaded;
    }catch(e){
      return defaultState();
    }
  }

  function saveState(){
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  }

  function seededRandom(seed){
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  function persistCurrent(){
    const q = list[current];
    if(!q) return;
    state.currentId = q.id;
    saveState();
  }

  function buildList(restoreCurrent = true){
    list = QUESTIONS.filter(q => state.filterYear === "all" || String(q.year) === state.filterYear);
    if(state.filterMode === "wrong"){
      list = list.filter(q => state.answers[q.id] && state.answers[q.id].choice !== q.answer);
    }
    if(state.filterMode === "review"){
      list = list.filter(q => state.wrongEver[q.id]);
    }
    if(state.filterMode === "unanswered"){
      list = list.filter(q => !state.answers[q.id]);
    }
    if(state.shuffled){
      list = list.slice().sort((a,b) => seededRandom(state.orderSeed + a.idNum) - seededRandom(state.orderSeed + b.idNum));
    }
    if(restoreCurrent && state.currentId){
      const restored = list.findIndex(q => q.id === state.currentId);
      current = restored >= 0 ? restored : Math.min(current, Math.max(list.length - 1, 0));
    }else{
      current = Math.min(current, Math.max(list.length - 1, 0));
    }
    render();
    persistCurrent();
  }

  function normalize(){
    els.year.value = state.filterYear;
    els.mode.value = state.filterMode;
  }

  function answer(choice){
    const q = list[current];
    if(!q) return;
    if(state.filterMode === "review"){
      if(reviewRunAnswers[q.id]) return;
      reviewRunAnswers[q.id] = { choice, at: new Date().toISOString() };
    }else{
      if(state.answers[q.id]) return;
      state.answers[q.id] = { choice, at: new Date().toISOString() };
      if(choice !== q.answer) state.wrongEver[q.id] = true;
    }
    state.currentId = q.id;
    saveState();
    render();
    window.setTimeout(() => { els.pane.scrollTop = els.pane.scrollHeight; }, 60);
  }

  function resetButtons(){
    els.yes.className = "answer-btn yes";
    els.no.className = "answer-btn no";
    els.yes.disabled = false;
    els.no.disabled = false;
    els.yesLabel.textContent = "";
    els.noLabel.textContent = "";
  }

  function applyAnswered(q, user){
    els.yes.disabled = true;
    els.no.disabled = true;
    const ok = user.choice === q.answer;
    els.result.hidden = false;
    els.resultCard.className = "result-card " + (ok ? "ok" : "ng");
    els.resultMark.textContent = ok ? "○" : "×";
    els.resultWord.textContent = ok ? "正解" : "不正解";
    els.resultAnswer.textContent = "正解は " + (q.answer === 1 ? "1（正しい）" : "2（誤り）");
    els.exp.textContent = q.explanation;
    if(state.filterMode === "review"){
      els.answerBadge.textContent = "復習登録済み";
      els.answerBadge.style.background = "#fff4cc";
      els.answerBadge.style.color = "#6b4b00";
    }else{
      els.answerBadge.textContent = user.choice === q.answer ? "正解済み" : "誤答";
      els.answerBadge.style.background = user.choice === q.answer ? "#d6f1df" : "#ffe1de";
      els.answerBadge.style.color = user.choice === q.answer ? "#12633d" : "#9f2f27";
    }

    if(q.answer === 1){
      els.yes.className = "answer-btn yes correct";
      els.yesLabel.textContent = "正解";
      if(user.choice === 2){
        els.no.className = "answer-btn no wrong";
        els.noLabel.textContent = "不正解";
      }else{
        els.no.className = "answer-btn no dim";
      }
    }else{
      els.no.className = "answer-btn no correct";
      els.noLabel.textContent = "正解";
      if(user.choice === 1){
        els.yes.className = "answer-btn yes wrong";
        els.yesLabel.textContent = "不正解";
      }else{
        els.yes.className = "answer-btn yes dim";
      }
    }
  }

  function renderStats(){
    const scope = QUESTIONS.filter(q => state.filterYear === "all" || String(q.year) === state.filterYear);
    const answered = scope.filter(q => state.answers[q.id]);
    const correct = answered.filter(q => state.answers[q.id].choice === q.answer);
    const reviewCount = scope.filter(q => state.wrongEver[q.id]).length;
    const pct = answered.length ? Math.round(correct.length / answered.length * 100) : "-";
    els.score.textContent = "正解率 " + pct + (pct === "-" ? "%" : "%");
    els.answered.textContent = state.filterMode === "review"
      ? reviewCount + " 問を復習中"
      : answered.length + " / " + scope.length + " 回答済み";
    els.correct.textContent = correct.length + " 正解";
    els.fill.style.width = scope.length ? Math.round(answered.length / scope.length * 100) + "%" : "0%";
  }

  function render(){
    normalize();
    renderStats();
    if(!list.length){
      els.section.textContent = "該当する問題がありません";
      els.pos.textContent = "0 / 0";
      els.qText.textContent = state.filterMode === "review"
        ? "まだ復習コースに登録された問題はありません。通常演習で一度でも間違えた問題が、ここに自動で入ります。"
        : "この条件に合う問題はありません。年度や範囲を切り替えてください。";
      els.qBadge.textContent = "Q -";
      els.yearBadge.textContent = state.filterYear === "all" ? "全年度" : state.filterYear + "年度";
      els.answerBadge.textContent = "空";
      els.result.hidden = true;
      els.yes.disabled = true;
      els.no.disabled = true;
      els.prev.disabled = true;
      els.next.disabled = true;
      return;
    }

    const q = list[current];
    const user = state.filterMode === "review" ? reviewRunAnswers[q.id] : state.answers[q.id];
    els.section.textContent = state.filterMode === "review" ? "復習コース：" + q.topic : q.topic;
    els.pos.textContent = (current + 1) + " / " + list.length;
    els.qBadge.textContent = "Q " + q.no;
    els.yearBadge.textContent = q.year + "年度";
    els.answerBadge.textContent = state.wrongEver[q.id] ? "復習登録済み" : (user ? "回答済み" : "未回答");
    els.answerBadge.style.background = "";
    els.answerBadge.style.color = "";
    els.qText.textContent = q.text;
    els.result.hidden = true;
    resetButtons();
    if(user) applyAnswered(q, user);
    els.prev.disabled = current === 0;
    els.next.disabled = current >= list.length - 1;
  }

  els.yes.addEventListener("click", () => answer(1));
  els.no.addEventListener("click", () => answer(2));
  els.prev.addEventListener("click", () => { if(current > 0){ current--; persistCurrent(); render(); els.pane.scrollTop = 0; } });
  els.next.addEventListener("click", () => { if(current < list.length - 1){ current++; persistCurrent(); render(); els.pane.scrollTop = 0; } });
  els.year.addEventListener("change", () => { state.filterYear = els.year.value; state.currentId = null; current = 0; saveState(); buildList(false); });
  els.mode.addEventListener("change", () => { state.filterMode = els.mode.value; state.currentId = null; current = 0; reviewRunAnswers = {}; saveState(); buildList(false); });
  els.shuffle.addEventListener("click", () => { state.shuffled = !state.shuffled; state.orderSeed = Date.now(); state.currentId = null; current = 0; reviewRunAnswers = {}; saveState(); buildList(false); });
  els.reset.addEventListener("click", () => {
    if(confirm("回答記録をリセットしますか？")){
      state = defaultState();
      current = 0;
      saveState();
      buildList(false);
    }
  });

  if("serviceWorker" in navigator && location.protocol !== "file:"){
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  buildList();
})();
