(function(){
  const SAVE_KEY = "gyosei_quiz_progress_v2";
  const CLOUD_FIELD = "gyoseiAdminLaw";
  const QUESTIONS = window.QUESTIONS || [];

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
    correct: document.getElementById("correctText"),
    login: document.getElementById("loginBtn"),
    userRow: document.getElementById("userRow"),
    userAvatar: document.getElementById("userAvatar"),
    userName: document.getElementById("userName"),
    syncStatus: document.getElementById("syncStatus"),
    signOut: document.getElementById("signOutBtn")
  };

  let state = loadState();
  let list = [];
  let current = 0;
  let reviewRunAnswers = {};
  let fbAuth = null;
  let fbDb = null;
  let currentUser = null;
  let syncTimer = null;
  let isPullingCloud = false;

  function defaultState(){
    return {
      answers: {},
      wrongEver: {},
      filterYear: "all",
      filterMode: "all",
      shuffled: false,
      orderSeed: Date.now(),
      currentQuestionId: null,
      lastAnsweredQuestionId: null,
      updatedAt: null
    };
  }

  function loadState(){
    try{
      const parsed = JSON.parse(localStorage.getItem(SAVE_KEY));
      const loaded = Object.assign(defaultState(), parsed || {});
      loaded.answers = Object.assign({}, loaded.answers || {});
      loaded.wrongEver = Object.assign({}, loaded.wrongEver || {});
      loaded.currentQuestionId = loaded.currentQuestionId || null;
      loaded.lastAnsweredQuestionId = loaded.lastAnsweredQuestionId || null;
      loaded.updatedAt = parsed && parsed.updatedAt ? parsed.updatedAt : null;
      Object.keys(loaded.answers).forEach(id => {
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

  function saveState(options){
    const opts = options || {};
    if(!opts.keepUpdatedAt) state.updatedAt = new Date().toISOString();
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    if(!opts.skipCloud) scheduleCloudPush();
  }

  function setSyncStatus(text){
    if(els.syncStatus) els.syncStatus.textContent = text;
  }

  function serializeCloudState(){
    return {
      answers: state.answers || {},
      wrongEver: state.wrongEver || {},
      filterYear: state.filterYear,
      filterMode: state.filterMode,
      currentQuestionId: state.currentQuestionId || null,
      lastAnsweredQuestionId: state.lastAnsweredQuestionId || null,
      updatedAt: state.updatedAt || new Date().toISOString()
    };
  }

  function countAnswers(answers){
    return Object.keys(answers || {}).length;
  }

  function hasProgress(savedState){
    if(!savedState) return false;
    return countAnswers(savedState.answers) > 0
      || Object.keys(savedState.wrongEver || {}).length > 0
      || !!savedState.currentQuestionId
      || !!savedState.lastAnsweredQuestionId;
  }

  function mergeStates(localState, cloudState){
    const local = Object.assign(defaultState(), localState || {});
    const cloud = cloudState || {};
    const localAnswers = Object.assign({}, local.answers || {});
    const cloudAnswers = Object.assign({}, cloud.answers || {});
    const mergedAnswers = Object.assign({}, cloudAnswers, localAnswers);
    Object.keys(cloudAnswers).forEach(id => {
      if(localAnswers[id] && cloudAnswers[id] && cloudAnswers[id].at > localAnswers[id].at){
        mergedAnswers[id] = cloudAnswers[id];
      }
    });

    const wrongEver = Object.assign({}, cloud.wrongEver || {}, local.wrongEver || {});
    Object.keys(mergedAnswers).forEach(id => {
      const q = QUESTIONS.find(item => item.id === id);
      if(q && mergedAnswers[id] && mergedAnswers[id].choice !== q.answer) wrongEver[id] = true;
    });
    const localHasProgress = hasProgress(local);
    const cloudHasProgress = hasProgress(cloud);
    const cloudHasMoreAnswers = countAnswers(cloudAnswers) > countAnswers(localAnswers);
    const cloudIsNewer = (cloud.updatedAt || "") > (local.updatedAt || "");
    const preferCloudPosition = cloudHasProgress && (!localHasProgress || cloudHasMoreAnswers || cloudIsNewer);

    return Object.assign({}, local, {
      answers: mergedAnswers,
      wrongEver,
      filterYear: preferCloudPosition && cloud.filterYear ? cloud.filterYear : local.filterYear,
      filterMode: preferCloudPosition && cloud.filterMode ? cloud.filterMode : local.filterMode,
      currentQuestionId: preferCloudPosition ? (cloud.currentQuestionId || cloud.lastAnsweredQuestionId || local.currentQuestionId) : local.currentQuestionId,
      lastAnsweredQuestionId: preferCloudPosition ? (cloud.lastAnsweredQuestionId || local.lastAnsweredQuestionId) : local.lastAnsweredQuestionId,
      updatedAt: [local.updatedAt, cloud.updatedAt].filter(Boolean).sort().pop() || new Date().toISOString()
    });
  }

  function scheduleCloudPush(){
    if(!currentUser || !fbDb || isPullingCloud) return;
    clearTimeout(syncTimer);
    setSyncStatus("同期待ち");
    syncTimer = window.setTimeout(pushCloud, 900);
  }

  async function pushCloud(){
    if(!currentUser || !fbDb) return;
    try{
      setSyncStatus("同期中...");
      const payload = {};
      payload[CLOUD_FIELD] = serializeCloudState();
      payload[CLOUD_FIELD + "UpdatedAt"] = firebase.firestore.FieldValue.serverTimestamp();
      await fbDb.collection("users").doc(currentUser.uid).set(payload, { merge: true });
      setSyncStatus("同期済み");
    }catch(e){
      console.warn("cloud push failed", e);
      setSyncStatus("同期失敗");
    }
  }

  async function pullCloud(user){
    if(!fbDb || !user) return;
    try{
      isPullingCloud = true;
      setSyncStatus("同期中...");
      const doc = await fbDb.collection("users").doc(user.uid).get();
      if(doc.exists && doc.data() && doc.data()[CLOUD_FIELD]){
        const before = countAnswers(state.answers);
        state = mergeStates(state, doc.data()[CLOUD_FIELD]);
        saveState({ skipCloud: true, keepUpdatedAt: true });
        buildList();
        const after = countAnswers(state.answers);
        setSyncStatus(after > before ? "同期完了" : "同期済み");
      }else{
        setSyncStatus("同期中...");
      }
    }catch(e){
      console.warn("cloud pull failed", e);
      setSyncStatus("同期失敗");
    }finally{
      isPullingCloud = false;
    }
    await pushCloud();
  }

  function loadScript(src){
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="' + src + '"]');
      if(existing){
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        if(existing.dataset.loaded === "true") resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.onload = () => {
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(script);
    });
  }

  async function ensureFirebase(){
    if(window.firebase && firebase.auth && firebase.firestore) return;
    const base = "https://www.gstatic.com/firebasejs/10.12.2/";
    await loadScript(base + "firebase-app-compat.js");
    await loadScript(base + "firebase-auth-compat.js");
    await loadScript(base + "firebase-firestore-compat.js");
  }

  async function initFirebase(){
    if(!els.login) return;
    els.login.disabled = true;
    els.login.textContent = "同期準備中";
    try{
      await ensureFirebase();
    }catch(e){
      console.warn("Firebase SDK load failed", e);
      els.login.textContent = "同期準備失敗";
      return;
    }
    const firebaseConfig = {
      apiKey: "AIzaSyDN5ECeFBJszQhu3Su7Fb9n963AgrgCOUY",
      authDomain: "test-a7757.firebaseapp.com",
      projectId: "test-a7757",
      storageBucket: "test-a7757.firebasestorage.app",
      messagingSenderId: "997078342375",
      appId: "1:997078342375:web:dde122958af05b3d36e042"
    };
    try{
      if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      els.login.disabled = false;
      els.login.textContent = "Googleで同期";
      fbAuth.getRedirectResult().catch(err => {
        if(err.code && err.code !== "auth/no-auth-event"){
          alert("ログインに失敗しました。\n" + (err.message || err.code || err));
        }
      });
      fbAuth.onAuthStateChanged(user => {
        currentUser = user;
        renderAuth(user);
        if(user) pullCloud(user);
      });
    }catch(e){
      console.warn("Firebase init failed", e);
      els.login.disabled = true;
      els.login.textContent = "同期準備失敗";
    }
  }

  function renderAuth(user){
    if(!els.login || !els.userRow) return;
    els.login.hidden = !!user;
    els.userRow.hidden = !user;
    if(user){
      els.userAvatar.src = user.photoURL || "";
      els.userName.textContent = user.displayName || user.email || "Googleアカウント";
      setSyncStatus("同期中...");
    }
  }

  function signIn(){
    if(!fbAuth) return;
    const provider = new firebase.auth.GoogleAuthProvider();
    fbAuth.signInWithRedirect(provider).catch(err => {
      alert("ログインに失敗しました。\n" + (err.message || err.code || err));
    });
  }

  function signOut(){
    if(fbAuth) fbAuth.signOut();
  }

  function seededRandom(seed){
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  function buildList(){
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
    const preferredId = state.currentQuestionId || state.lastAnsweredQuestionId;
    const preferredIndex = preferredId ? list.findIndex(q => q.id === preferredId) : -1;
    current = preferredIndex >= 0 ? preferredIndex : Math.min(current, Math.max(list.length - 1, 0));
    render();
  }

  function setCurrentQuestion(id, options){
    state.currentQuestionId = id || null;
    saveState(options);
  }

  function normalize(){
    els.year.value = state.filterYear;
    els.mode.value = state.filterMode;
    els.shuffle.classList.toggle("active", state.shuffled);
  }

  function answer(choice){
    const q = list[current];
    if(!q) return;
    state.currentQuestionId = q.id;
    state.lastAnsweredQuestionId = q.id;
    if(state.filterMode === "review"){
      if(reviewRunAnswers[q.id]) return;
      reviewRunAnswers[q.id] = { choice, at: new Date().toISOString() };
    }else{
      if(state.answers[q.id]) return;
      state.answers[q.id] = { choice, at: new Date().toISOString() };
      if(choice !== q.answer) state.wrongEver[q.id] = true;
    }
    saveState();
    render();
    window.setTimeout(() => { els.pane.scrollTop = els.pane.scrollHeight; }, 60);
  }

  function resetButtons(){
    els.yes.className = "answer-btn yes";
    els.no.className = "answer-btn no";
    els.yes.disabled = false;
    els.no.disabled = false;
    els.yesLabel.textContent = "○";
    els.noLabel.textContent = "×";
  }

  function applyAnswered(q, user){
    els.yes.disabled = true;
    els.no.disabled = true;
    const ok = user.choice === q.answer;
    els.result.hidden = false;
    els.resultCard.className = "result-card " + (ok ? "ok" : "ng");
    els.resultMark.textContent = ok ? "○" : "×";
    els.resultWord.textContent = ok ? "正解" : "不正解";
    els.resultAnswer.textContent = "正答は " + (q.answer === 1 ? "○" : "×");
    els.exp.textContent = q.explanation;

    if(state.filterMode === "review"){
      els.answerBadge.textContent = "まとめ解き回答済み";
      els.answerBadge.style.background = "#fff4cc";
      els.answerBadge.style.color = "#6b4b00";
    }else{
      els.answerBadge.textContent = ok ? "正解済み" : "誤答";
      els.answerBadge.style.background = ok ? "#d6f1df" : "#ffe1de";
      els.answerBadge.style.color = ok ? "#12633d" : "#9f2f27";
    }

    if(q.answer === 1){
      els.yes.className = "answer-btn yes correct";
      els.yesLabel.textContent = "正解";
      els.no.className = user.choice === 2 ? "answer-btn no wrong" : "answer-btn no dim";
      els.noLabel.textContent = user.choice === 2 ? "選択" : "×";
    }else{
      els.no.className = "answer-btn no correct";
      els.noLabel.textContent = "正解";
      els.yes.className = user.choice === 1 ? "answer-btn yes wrong" : "answer-btn yes dim";
      els.yesLabel.textContent = user.choice === 1 ? "選択" : "○";
    }
  }

  function renderStats(){
    const scope = QUESTIONS.filter(q => state.filterYear === "all" || String(q.year) === state.filterYear);
    const answered = scope.filter(q => state.answers[q.id]);
    const correct = answered.filter(q => state.answers[q.id].choice === q.answer);
    const reviewCount = scope.filter(q => state.wrongEver[q.id]).length;
    const pct = answered.length ? Math.round(correct.length / answered.length * 100) : "-";
    els.score.textContent = "正答率 " + pct + "%";
    els.answered.textContent = state.filterMode === "review"
      ? "一度間違えた " + reviewCount + "問をまとめ解き"
      : answered.length + " / " + scope.length + " 回答済み";
    els.correct.textContent = correct.length + " 正解";
    els.fill.style.width = scope.length ? Math.round(answered.length / scope.length * 100) + "%" : "0%";
  }

  function renderEmpty(){
    els.section.textContent = "該当する問題がありません";
    els.pos.textContent = "0 / 0";
    els.qText.textContent = state.filterMode === "review"
      ? "まだまとめ解きに入る問題はありません。通常演習で一度でも間違えた問題が、ここに自動で集まります。"
      : "この条件に合う問題はありません。年度または範囲を切り替えてください。";
    els.qBadge.textContent = "Q -";
    els.yearBadge.textContent = state.filterYear === "all" ? "全年度" : state.filterYear + "年度";
    els.answerBadge.textContent = "空";
    els.answerBadge.style.background = "";
    els.answerBadge.style.color = "";
    els.result.hidden = true;
    els.yes.disabled = true;
    els.no.disabled = true;
    els.prev.disabled = true;
    els.next.disabled = true;
    els.yesLabel.textContent = "○";
    els.noLabel.textContent = "×";
  }

  function render(){
    normalize();
    renderStats();
    if(!list.length){
      renderEmpty();
      return;
    }

    const q = list[current];
    const user = state.filterMode === "review" ? reviewRunAnswers[q.id] : state.answers[q.id];
    els.section.textContent = state.filterMode === "review" ? "間違えた問題まとめ解き： " + q.topic : q.topic;
    els.pos.textContent = (current + 1) + " / " + list.length;
    els.qBadge.textContent = "Q " + String(q.no).padStart(3, "0");
    els.yearBadge.textContent = q.year + "年度";
    els.answerBadge.textContent = state.filterMode === "review"
      ? (user ? "まとめ解き回答済み" : "まとめ解き中")
      : (state.wrongEver[q.id] ? "まとめ解き登録済み" : (user ? "回答済み" : "未回答"));
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
  els.prev.addEventListener("click", () => {
    if(current > 0){
      current--;
      if(list[current]) setCurrentQuestion(list[current].id);
      render();
      els.pane.scrollTop = 0;
    }
  });
  els.next.addEventListener("click", () => {
    if(current < list.length - 1){
      current++;
      if(list[current]) setCurrentQuestion(list[current].id);
      render();
      els.pane.scrollTop = 0;
    }
  });
  els.year.addEventListener("change", () => { state.filterYear = els.year.value; state.currentQuestionId = null; current = 0; saveState(); buildList(); });
  els.mode.addEventListener("change", () => { state.filterMode = els.mode.value; state.currentQuestionId = null; current = 0; reviewRunAnswers = {}; saveState(); buildList(); });
  els.shuffle.addEventListener("click", () => {
    state.shuffled = !state.shuffled;
    state.orderSeed = Date.now();
    state.currentQuestionId = null;
    current = 0;
    reviewRunAnswers = {};
    saveState();
    buildList();
  });
  els.reset.addEventListener("click", () => {
    if(confirm("回答記録をリセットしますか？")){
      state = defaultState();
      reviewRunAnswers = {};
      saveState();
      buildList();
    }
  });
  if(els.login) els.login.addEventListener("click", signIn);
  if(els.signOut) els.signOut.addEventListener("click", signOut);

  document.addEventListener("keydown", event => {
    if(event.key === "ArrowLeft") els.prev.click();
    if(event.key === "ArrowRight") els.next.click();
    if(event.key === "o" || event.key === "O" || event.key === "1") els.yes.click();
    if(event.key === "x" || event.key === "X" || event.key === "2") els.no.click();
  });

  if("serviceWorker" in navigator){
    navigator.serviceWorker.getRegistrations()
      .then(registrations => registrations.forEach(registration => registration.unregister()))
      .catch(() => {});
  }

  initFirebase();
  buildList();
})();
