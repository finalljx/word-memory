/* 词卡 · 前端逻辑：翻转自测 / 间隔复习 / 选择与听写 */

const S = {
  deckId: localStorage.getItem('wm.deck') || 'taste',
  decks: [],
  words: [],
  stats: null,
  queue: [],
  i: 0,
  revealed: false,
  shownAt: 0,
  done: 0,
  wrong: [],
  busy: false,
  view: 'learn',
  quiz: null,
  quizType: 'choice',
  quizScore: { right: 0, total: 0 },
  quizSeen: new Set(),
  quizWrong: new Set(),
  quizTotal: 0,
  quizOnly: [],
  quizDone: false,
  answered: false,
  mastery: false,
  round: 1,
  roundWrong: [],
  roundsLog: [],
  modalWordId: null,
  ai: { enabled: false, model: '' },
  wrongWords: [],
  overview: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const state = await api(`/api/state?deck=${encodeURIComponent(S.deckId)}`);
    if (!state.decks.some((d) => d.id === S.deckId)) S.deckId = state.decks[0].id;
    S.decks = state.decks;
    S.words = state.words;
    S.stats = state.stats;
    renderDecks();
    renderToday();
    await loadAiStatus();
    await loadWrong();
    await startSession();
    const initial = location.hash.replace('#', '');
    if (initial.startsWith('print/')) {
      const [, kind, id] = initial.split('/');
      if (kind === 'wrong') openPrint('wrong', null, 'admin');
      else if (kind === 'deck' && id) openPrint('deck', decodeURIComponent(id), 'decks');
      return;
    }
    if (['quiz', 'stats', 'admin', 'decks'].includes(initial)) switchView(initial);
  } catch (err) {
    console.error(err);
    $('#card-wrap').innerHTML = `<div class="done"><h2>服务没连上</h2><p>请确认 server.js 正在运行。</p></div>`;
  }
}

function recentDecks() {
  const list = [...S.decks].sort((a, b) => {
    const ta = a.lastOpenedAt || '';
    const tb = b.lastOpenedAt || '';
    if (ta !== tb) return tb.localeCompare(ta);
    return (b.sort ?? 0) - (a.sort ?? 0);
  });
  const top = list.slice(0, 3);
  if (!top.some((d) => d.id === S.deckId)) {
    const current = S.decks.find((d) => d.id === S.deckId);
    if (current) top.unshift(current);
  }
  return top;
}

function renderDecks() {
  const recent = recentDecks();
  $('#decks').innerHTML =
    recent
      .map(
        (d) =>
          `<button class="deck ${d.id === S.deckId ? 'active' : ''}" data-deck="${esc(d.id)}">${esc(
            d.title
          )}<span style="opacity:.5"> · ${d.total}</span></button>`
      )
      .join('') +
    `<button class="deck deck-all" data-decks-page="1">全部 ${S.decks.length} 个 →</button>`;
}

function renderToday() {
  updateWrongChip();
  const s = S.stats;
  if (!s || !s.todayReviews) {
    $('#today').textContent = '今天还没开始';
    return;
  }
  $('#today').textContent = `今日 ${s.todayReviews} 次 · 正确率 ${s.accuracy}%`;
}

/* ---------------- 学习 ---------------- */

async function startSession() {
  S.mastery = false;
  S.round = 1;
  S.roundWrong = [];
  S.roundsLog = [];
  const q = await api(`/api/queue?deck=${encodeURIComponent(S.deckId)}&limit=60`);
  S.queue = q.items;
  S.stats = q.stats;
  S.i = 0;
  S.done = 0;
  S.wrong = [];
  S.busy = false;
  renderToday();
  if (!S.queue.length) {
    renderIdle();
    updateSessionBar(0, 0);
    return;
  }
  renderCard();
  updateSessionBar(S.queue.length, 0);
}

function updateSessionBar(total, done) {
  $('#session-count').textContent = `${done} / ${total}`;
  $('#session-fill').style.width = total ? `${(done / total) * 100}%` : '0%';
  $('#session-label').textContent = S.mastery
    ? `第 ${S.round} 轮闯关`
    : total
      ? '今日复习'
      : '今日任务';
}

function renderCard() {
  const w = S.queue[S.i];
  if (!w) return;
  S.revealed = false;
  S.shownAt = Date.now();
  $('#actions').style.display = 'flex';
  $('.fineprint').style.display = '';
  $('#btn-forgot').disabled = true;
  $('#btn-got').disabled = true;

  const chunks = (w.chunks || []).map((c) => `<span class="chunk">${esc(c)}</span>`).join('');
  const extracts = (w.extracts || []).map((e) => `<span>${esc(e)}</span>`).join('');

  $('#card-wrap').innerHTML = `
    <div class="card" id="card">
      <div class="card-inner">
        <div class="face front">
          ${w.pos ? `<div class="pos">${esc(w.pos)}</div>` : ''}
          <h1 class="word">${esc(w.word)}</h1>
          <div class="ipa">${esc(w.ipa)}
            <button class="speak" data-say="${esc(w.word)}" title="听发音 (S)">🔊</button>
          </div>
          <div class="front-def">
            <span class="label">英文解释</span>
            <p>${esc(w.enDef || '待补齐')}</p>
          </div>
          <div class="front-hint">看英文解释，回想中文意思</div>
          <div class="flip-hint">点卡片或按空格翻面</div>
        </div>
        <div class="face back">
          <div class="back-top">
            <span class="cn">${esc(w.cn || '待补齐')}${w.deckTitle ? `<span class="deck-tag">${esc(w.deckTitle)}</span>` : ''}</span>
            ${w.pos ? `<span class="pos">${esc(w.pos)}</span>` : ''}
            <button class="speak back-speak" data-say="${esc(w.word)}" title="听发音 (S)">🔊</button>
          </div>
          <div class="back-body">
            <div class="col">
              <div class="def-block">
                <span class="label">英文解释</span>
                <p>${esc(w.enDef || '待补齐')}</p>
              </div>
              <div class="hook-block">
                <span class="label">主钩</span>
                <p>${esc(w.hook || '还没有主钩，去管理页点 AI 补齐')}</p>
              </div>
              ${w.altHook ? `<div class="row"><span class="label">备钩</span><p>${esc(w.altHook)}</p></div>` : ''}
            </div>
            <div class="col">
              <div class="row"><span class="label">音节</span><p>${esc(w.syllables)}</p></div>
              <div class="row"><span class="label">词块</span><p>${chunks}</p></div>
              ${w.family ? `<div class="row"><span class="label">词族</span><p>${esc(w.family)}</p></div>` : ''}
              <div class="example">${esc(w.example)}</div>
              <div class="extract">${extracts}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const card = $('#card');
  card.addEventListener('click', (e) => {
    if (e.target.closest('.speak')) return;
    if (!S.revealed) flip();
  });
  card.querySelectorAll('.speak').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speak(w.word);
    });
  });
}

function flip() {
  if (S.revealed) return;
  S.revealed = true;
  $('#card')?.classList.add('flipped');
  $('#btn-forgot').disabled = false;
  $('#btn-got').disabled = false;
}

function syncProgress(wordId, p) {
  const w = S.words.find((x) => x.id === wordId);
  if (!w || !p) return;
  w.progress = {
    ...w.progress,
    box: p.box,
    dueAt: p.due_at,
    total: p.total,
    correct: p.correct,
    wrongCount: p.wrong_count,
    lastResult: p.last_result,
    lastReviewedAt: p.last_reviewed_at,
  };
}

async function review(remembered) {
  if (!S.revealed || S.busy) return;
  const w = S.queue[S.i];
  S.busy = true;
  $('#btn-forgot').disabled = true;
  $('#btn-got').disabled = true;
  try {
    const res = await api(`/api/review?deck=${encodeURIComponent(S.deckId)}`, {
      method: 'POST',
      body: JSON.stringify({
        wordId: w.id,
        remembered,
        mode: 'flip',
        elapsedMs: Date.now() - S.shownAt,
      }),
    });
    S.stats = res.stats;
    syncProgress(w.id, res.progress);
    loadWrong();
    renderToday();
    S.done++;
    if (!remembered) {
      S.wrong.push(w);
      if (S.mastery) S.roundWrong.push(w);
    }
    S.i++;
    updateSessionBar(S.queue.length, S.done);
    if (S.i >= S.queue.length) {
      if (S.mastery) endRound();
      else renderDone();
    } else renderCard();
  } catch (err) {
    console.error(err);
    toast('保存失败，检查服务');
  } finally {
    S.busy = false;
  }
}

function renderDone() {
  $('#actions').style.display = 'none';
  $('.fineprint').style.display = 'none';
  const total = S.queue.length;
  const wrong = S.wrong.length;
  const right = total - wrong;
  $('#card-wrap').innerHTML = `
    <div class="done">
      <h2>这一轮完了</h2>
      <p>${wrong ? '有 ' + wrong + ' 个词需要再练一遍。' : '全部记住了，明天会按间隔再考你一次。'}</p>
      <div class="done-stats">
        <div><b>${total}</b><span>复习</span></div>
        <div><b>${right}</b><span>记住</span></div>
        <div><b>${wrong}</b><span>没记住</span></div>
      </div>
      <div class="done-actions">
        ${wrong ? `<button class="btn primary" id="again">再练没记住的 ${wrong} 个</button>` : ''}
        <button class="btn ghost" id="to-quiz">去自测</button>
      </div>
    </div>`;
  $('#again')?.addEventListener('click', () => {
    S.queue = S.wrong.slice();
    S.i = 0;
    S.done = 0;
    S.wrong = [];
    renderCard();
    updateSessionBar(S.queue.length, 0);
  });
  $('#to-quiz').addEventListener('click', () => switchView('quiz'));
}

function renderIdle() {
  const next = nextDue();
  $('#actions').style.display = 'none';
  $('.fineprint').style.display = 'none';
  $('#card-wrap').innerHTML = `
    <div class="done">
      <h2>今天的词都过完了</h2>
      <p>${next ? `下一次复习在 ${next}。` : '去自测里再练几轮吧。'}</p>
      <div class="done-actions">
        <button class="btn primary" id="to-quiz">去自测</button>
        <button class="btn ghost" id="to-stats">看进度</button>
      </div>
    </div>`;
  $('#to-quiz').addEventListener('click', () => switchView('quiz'));
  $('#to-stats').addEventListener('click', () => switchView('stats'));
}

function nextDue() {
  const now = Date.now();
  const times = S.words
    .map((w) => new Date(w.progress.dueAt).getTime())
    .filter((t) => t > now)
    .sort((a, b) => a - b);
  return times.length ? relTime(new Date(times[0]).toISOString()) : null;
}

function relTime(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return '现在';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时后`;
  const d = Math.round(h / 24);
  return `${d} 天后`;
}

/* ---------------- 自测 ---------------- */

async function loadQuiz() {
  S.answered = false;
  try {
    const params = new URLSearchParams({ deck: S.deckId, type: S.quizType });
    if (S.quizSeen.size) params.set('exclude', [...S.quizSeen].join(','));
    if (S.quizOnly.length) params.set('only', S.quizOnly.join(','));
    const data = await api(`/api/quiz?${params.toString()}`);
    if (data.done) {
      S.quiz = null;
      renderQuizDone();
      return;
    }
    S.quiz = data;
    S.quizTotal = data.total || S.quizTotal;
    S.quizSeen.add(data.wordId);
    S.quizDone = false;
    renderQuizScore();
    renderQuiz();
  } catch (err) {
    console.error(err);
    toast('出题失败');
  }
}

function resetQuizState() {
  S.quiz = null;
  S.quizSeen = new Set();
  S.quizWrong = new Set();
  S.quizScore = { right: 0, total: 0 };
  S.quizTotal = 0;
  S.quizOnly = [];
  S.quizDone = false;
  const score = $('#quiz-score');
  if (score) score.textContent = '0 / 0';
}

function startQuizRound(only = []) {
  resetQuizState();
  S.quizOnly = only.slice();
  loadQuiz();
}

function renderQuizDone() {
  S.quizDone = true;
  const total = S.quizScore.total;
  const right = S.quizScore.right;
  const wrong = S.quizWrong.size;
  const rate = total ? Math.round((right / total) * 100) : 0;
  $('#quiz-score').textContent = `${total} / ${total}`;
  $('#quiz-body').innerHTML = `
    <div class="done">
      <h2>这一组测完了</h2>
      <p>${total} 个词都过了一遍，${wrong ? `有 ${wrong} 个没答对` : '全部答对'}。</p>
      <div class="done-stats">
        <div><b>${total}</b><span>题</span></div>
        <div><b>${right}</b><span>答对</span></div>
        <div><b>${rate}%</b><span>正确率</span></div>
      </div>
      <div class="done-actions">
        ${wrong ? `<button class="btn primary" id="quiz-wrong">只测错的 ${wrong} 个</button>` : ''}
        <button class="btn ${wrong ? 'ghost' : 'primary'}" id="quiz-again">再来一轮</button>
        <button class="btn ghost" id="quiz-back">去学习</button>
      </div>
    </div>`;
  $('#quiz-wrong')?.addEventListener('click', () => startQuizRound([...S.quizWrong]));
  $('#quiz-again').addEventListener('click', () => startQuizRound());
  $('#quiz-back').addEventListener('click', () => switchView('learn'));
}

function renderQuiz() {
  const q = S.quiz;
  if (!q) return;
  const body = $('#quiz-body');

  if (q.type === 'spell') {
    body.innerHTML = `
      <div class="q-card">
        <div class="q-kicker">听音写词 · 也可以看中文写</div>
        <h2 class="q-prompt">${esc(q.prompt)}</h2>
        <p class="q-sub">${esc(q.ipa)} · ${esc(q.syllables || '')}</p>
        <div class="spell-box">
          <input class="spell-input" id="spell-input" autocomplete="off" autocapitalize="off"
                 spellcheck="false" placeholder="在这里写英文" />
          <button class="btn small" id="play">🔊</button>
        </div>
        <button class="btn primary" id="check" style="width:100%">检查</button>
        <div id="q-fb"></div>
        <div class="next-row" id="q-next"></div>
      </div>`;
    const input = $('#spell-input');
    input.focus();
    $('#play').addEventListener('click', () => speak(q.answer || ''));
    $('#check').addEventListener('click', submitSpell);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitSpell();
    });
    return;
  }

  const isWord = q.promptType === 'word';
  body.innerHTML = `
    <div class="q-card">
      <div class="q-kicker">${isWord ? '看单词选中文' : '看解释选单词'}</div>
      <h2 class="q-prompt" style="${isWord ? '' : 'font-size:clamp(20px,4vw,26px)'}">${esc(q.prompt)}</h2>
      <p class="q-sub">${isWord ? esc(q.ipa) : '选出对应的英文单词'}</p>
      <div class="q-options">
        ${q.options
          .map(
            (o, idx) =>
              `<button class="option" data-key="${o.key}">
                 <span class="idx">${idx + 1}</span><span>${esc(o.text)}</span>
               </button>`
          )
          .join('')}
      </div>
      <div id="q-fb"></div>
      <div class="next-row" id="q-next"></div>
    </div>`;

  $$('.option').forEach((btn) => {
    btn.addEventListener('click', () => submitChoice(Number(btn.dataset.key), btn));
  });
}

async function submitChoice(key, btn) {
  if (S.answered) return;
  S.answered = true;
  $$('.option').forEach((b) => (b.disabled = true));
  try {
    const res = await api(`/api/quiz/answer?deck=${encodeURIComponent(S.deckId)}`, {
      method: 'POST',
      body: JSON.stringify({ wordId: S.quiz.wordId, type: 'choice', answer: key }),
    });
    S.stats = res.stats;
    syncProgress(S.quiz.wordId, res.progress);
    renderToday();
    S.quizScore.total++;
    if (res.correct) S.quizScore.right++;
    else S.quizWrong.add(S.quiz.wordId);
    renderQuizScore();

    if (res.correct) btn.classList.add('right');
    else {
      btn.classList.add('wrong');
      $$('.option').forEach((b) => {
        if (Number(b.dataset.key) === S.quiz.wordId) b.classList.add('right');
      });
    }
    showFeedback(res);
  } catch (err) {
    console.error(err);
    toast('判定失败');
  }
}

async function submitSpell() {
  if (S.answered) return;
  const input = $('#spell-input');
  const value = input.value.trim();
  if (!value) return;
  S.answered = true;
  $('#check').disabled = true;
  try {
    const res = await api(`/api/quiz/answer?deck=${encodeURIComponent(S.deckId)}`, {
      method: 'POST',
      body: JSON.stringify({ wordId: S.quiz.wordId, type: 'spell', answer: value }),
    });
    S.stats = res.stats;
    syncProgress(S.quiz.wordId, res.progress);
    renderToday();
    S.quizScore.total++;
    if (res.correct) S.quizScore.right++;
    else S.quizWrong.add(S.quiz.wordId);
    renderQuizScore();
    input.disabled = true;
    input.style.borderColor = res.correct ? 'var(--accent)' : 'var(--warn)';
    showFeedback(res);
  } catch (err) {
    console.error(err);
    toast('判定失败');
  }
}

function showFeedback(res) {
  const fb = $('#q-fb');
  fb.className = `feedback ${res.correct ? 'ok' : 'no'}`;
  fb.innerHTML = res.correct
    ? `✓ 对了 —— <b>${esc(res.answer)}</b> ${esc(res.cn)}<br>${esc(res.example)}`
    : `✗ 正确答案是 <b>${esc(res.answer)}</b>（${esc(res.cn)}）<br>${esc(res.hook)}`;
  const next = $('#q-next');
  next.innerHTML = `<button class="btn primary" id="next" style="flex:0 0 auto;padding:11px 22px">下一题 <kbd>↵</kbd></button>`;
  $('#next').addEventListener('click', loadQuiz);
}

function renderQuizScore() {
  const total = S.quizTotal || 0;
  const seen = Math.min(S.quizSeen.size, total || S.quizSeen.size);
  $('#quiz-score').textContent = total
    ? `${seen} / ${total} · 对 ${S.quizScore.right}`
    : `对 ${S.quizScore.right}`;
}

/* ---------------- 进度 ---------------- */

function renderStats() {
  const s = S.stats;
  if (!s) return;
  $('#stat-grid').innerHTML = `
    <div class="stat"><b>${s.mastered}</b><span>已掌握</span></div>
    <div class="stat"><b>${s.learning}</b><span>学习中</span></div>
    <div class="stat"><b>${s.fresh}</b><span>待开始</span></div>
    <div class="stat"><b>${s.accuracy == null ? '—' : s.accuracy + '%'}</b><span>今日正确率</span></div>`;

  const max = Math.max(...s.boxes, 1);
  const names = ['0 天', '1 天', '2 天', '4 天', '7 天', '15 天'];
  $('#boxes').innerHTML = s.boxes
    .map(
      (n, i) => `
      <div class="boxrow">
        <span class="label" title="第 ${i} 箱">${names[i]}</span>
        <div class="track"><i style="width:${(n / max) * 100}%"></i></div>
        <span class="n">${n}</span>
      </div>`
    )
    .join('');

  $('#word-table').innerHTML = `
    <div class="trow head"><span>单词</span><span>中文</span><span>箱</span><span>下次</span><span>状态</span></div>
    ${S.words
      .map((w) => {
        const p = w.progress;
        const status = p.total === 0 ? '新词' : p.box >= 4 ? '已掌握' : '学习中';
        const cls = p.total === 0 ? 'fresh' : p.box >= 4 ? 'mastered' : '';
        return `<div class="trow">
          <span class="w">${esc(w.word)}</span>
          <span class="muted">${esc(w.cn)}</span>
          <span>${p.box}</span>
          <span class="due">${esc(relTime(p.dueAt))}</span>
          <span class="pill ${cls}">${status}</span>
        </div>`;
      })
      .join('')}`;

  const deck = S.decks.find((d) => d.id === S.deckId);
  $('#story').innerHTML = (deck?.story || '').replace(
    /\b([a-zA-Z']+)\b/g,
    (m) => `<b>${m}</b>`
  );
  $('#scene').textContent = deck?.scene || '';
}

/* ---------------- 视图切换 ---------------- */

function switchView(view) {
  S.view = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'stats') {
    api(`/api/state?deck=${encodeURIComponent(S.deckId)}`)
      .then((r) => {
        S.words = r.words;
        S.stats = r.stats;
        renderToday();
        renderStats();
      })
      .catch(() => {});
  }
  if (view === 'quiz' && !S.quiz && !S.quizDone) loadQuiz();
  if (view === 'admin') renderAdmin();
  if (view === 'decks') renderDecksPage();
}

/* ---------------- 工具 ---------------- */

function speak(text) {
  if (!text || !('speechSynthesis' in window)) {
    toast('这个浏览器不支持发音');
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-GB';
  u.rate = 0.85;
  u.pitch = 1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------------- 事件绑定 ---------------- */

$('#decks').addEventListener('click', async (e) => {
  if (e.target.closest('[data-decks-page]')) {
    switchView('decks');
    return;
  }
  const btn = e.target.closest('[data-deck]');
  if (!btn || btn.dataset.deck === S.deckId) return;
  S.deckId = btn.dataset.deck;
  localStorage.setItem('wm.deck', S.deckId);
  resetQuizState();
  const state = await api(`/api/state?deck=${encodeURIComponent(S.deckId)}`);
  S.decks = state.decks;
  S.words = state.words;
  S.stats = state.stats;
  renderDecks();
  renderToday();
  renderStats();
  await startSession();
});

$('#tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) switchView(btn.dataset.view);
});

$('#btn-forgot').addEventListener('click', () => review(false));
$('#btn-got').addEventListener('click', () => review(true));

$('#quiz-type').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-type]');
  if (!btn) return;
  S.quizType = btn.dataset.type;
  $$('#quiz-type button').forEach((b) => b.classList.toggle('active', b === btn));
  startQuizRound();
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('清空本词库的复习记录？词不会删，但所有进度归零。')) return;
  await api('/api/reset', {
    method: 'POST',
    body: JSON.stringify({ deck: S.deckId }),
  });
  const state = await api(`/api/state?deck=${encodeURIComponent(S.deckId)}`);
  S.words = state.words;
  S.stats = state.stats;
  renderToday();
  renderStats();
  await startSession();
  toast('已重置');
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    if (e.key === 'Enter' && S.answered) loadQuiz();
    return;
  }
  if (S.view === 'learn') {
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      flip();
    } else if (e.key === 'ArrowLeft') {
      if (S.revealed) review(false);
    } else if (e.key === 'ArrowRight') {
      if (S.revealed) review(true);
    } else if (e.key.toLowerCase() === 's') {
      speak(S.queue[S.i]?.word);
    }
  } else if (S.view === 'quiz' && S.quiz?.type === 'choice' && !S.answered) {
    const n = Number(e.key);
    if (n >= 1 && n <= 4) {
      const btn = $$('.option')[n - 1];
      if (btn) btn.click();
    }
  } else if (S.view === 'quiz' && S.answered) {
    if (e.key === 'Enter') loadQuiz();
  }
});


/* ---------------- 全对闯关 ---------------- */

function wrongWords() {
  return S.wrongWords || [];
}

async function loadWrong() {
  try {
    const r = await api('/api/wrong');
    S.wrongWords = r.items || [];
  } catch {
    S.wrongWords = [];
  }
  updateWrongChip();
}

function updateWrongChip() {
  const n = wrongWords().length;
  const btn = $('#btn-wrong');
  if (!btn) return;
  btn.classList.toggle('hidden', n === 0);
  btn.textContent = `错词 ${n} 个 · 只练这些`;
}

function startMastery(words) {
  if (!words.length) return toast('这一组没有词');
  S.mastery = true;
  S.round = 1;
  S.roundsLog = [];
  S.roundWrong = [];
  S.queue = words.slice();
  S.i = 0;
  S.done = 0;
  S.wrong = [];
  switchView('learn');
  renderCard();
  updateSessionBar(S.queue.length, 0);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function endRound() {
  updateSessionBar(S.queue.length, S.queue.length);
  const total = S.queue.length;
  const wrong = S.roundWrong.length;
  S.roundsLog.push({ round: S.round, total, wrong });
  if (wrong === 0) renderVictory();
  else renderRoundEnd(wrong);
}

function renderRoundEnd(wrong) {
  $('#actions').style.display = 'none';
  $('.fineprint').style.display = 'none';
  $('#card-wrap').innerHTML = `
    <div class="done">
      <h2>第 ${S.round} 轮 · 还差 ${wrong} 个</h2>
      <p>把这一轮错的再背一遍，直到一轮全对为止。</p>
      <div class="done-stats">
        <div><b>${S.queue.length}</b><span>本轮</span></div>
        <div><b>${S.queue.length - wrong}</b><span>背对</span></div>
        <div><b>${wrong}</b><span>还错</span></div>
      </div>
      <div class="done-actions">
        <button class="btn primary" id="next-round">进入第 ${S.round + 1} 轮（${wrong} 个）</button>
        <button class="btn ghost" id="quit-mastery">退出闯关</button>
      </div>
    </div>`;
  $('#next-round').addEventListener('click', () => {
    S.round++;
    S.queue = S.roundWrong.slice();
    S.roundWrong = [];
    S.i = 0;
    S.done = 0;
    renderCard();
    updateSessionBar(S.queue.length, 0);
  });
  $('#quit-mastery').addEventListener('click', () => {
    S.mastery = false;
    startSession();
  });
}

function renderVictory() {
  $('#actions').style.display = 'none';
  $('.fineprint').style.display = 'none';
  $('#card-wrap').innerHTML = `
    <div class="done">
      <h2>全部背对了</h2>
      <p>${S.round} 轮闯关完成，这一组没有漏网的词。</p>
      <div class="done-stats">
        <div><b>${S.round}</b><span>轮数</span></div>
        <div><b>${S.roundsLog.reduce((a, r) => a + r.wrong, 0)}</b><span>累计错次</span></div>
      </div>
      <div class="done-actions">
        <button class="btn primary" id="again-mastery">再来一遍</button>
        <button class="btn ghost" id="back-learn">回到今日复习</button>
      </div>
    </div>`;
  $('#again-mastery').addEventListener('click', () => startMastery(S.words));
  $('#back-learn').addEventListener('click', () => startSession());
}

/* ---------------- 词库 ---------------- */

function deckCardHtml(d) {
  const st = d.stats || {};
  const words = d.words || [];
  return `<div class="deck-card ${d.id === S.deckId ? 'current' : ''}">
    <div class="deck-card-head">
      <div class="deck-title">
        <b>${esc(d.title)}</b>
        <span class="hint">${d.total} 词 · 已掌握 ${st.mastered ?? 0} · 待复习 ${st.due ?? 0}${
          st.wrong ? ` · 错词 ${st.wrong}` : ''
        }</span>
      </div>
      <div class="deck-ops">
        <button class="mini" data-open="${esc(d.id)}">学习</button>
        <button class="mini" data-manage="${esc(d.id)}">管理</button>
        <button class="mini" data-print="${esc(d.id)}">打印</button>
        <button class="mini" data-rename="${esc(d.id)}">重命名</button>
        <button class="mini danger" data-del="${esc(d.id)}">删除</button>
      </div>
    </div>
    <div class="deck-words">
      ${
        words.length
          ? words
              .map(
                (w) =>
                  `<span class="word-chip ${w.wrongCount ? 'bad' : ''}">${esc(w.word)}<i>${esc(
                    w.cn || '待补齐'
                  )}</i></span>`
              )
              .join('')
          : '<span class="hint">还没有单词</span>'
      }
    </div>
  </div>`;
}

async function renderDecksPage() {
  try {
    const { decks } = await api('/api/overview');
    S.overview = decks;
    $('#decks-count').textContent = `· ${decks.length} 个`;
    $('#deck-list').innerHTML = decks.length
      ? decks.map(deckCardHtml).join('')
      : '<div class="empty">还没有词库，点右上角新建一个。</div>';
  } catch (e) {
    toast(e.message);
  }
}

async function openDeck(id, view) {
  S.deckId = id;
  localStorage.setItem('wm.deck', id);
  resetQuizState();
  const state = await api(`/api/state?deck=${encodeURIComponent(id)}`);
  S.decks = state.decks;
  S.words = state.words;
  S.stats = state.stats;
  renderDecks();
  renderToday();
  await startSession();
  switchView(view);
}

async function renameDeckFlow(id) {
  const deck = S.decks.find((d) => d.id === id);
  const title = prompt('新的词库名', deck?.title || '');
  if (!title || title === deck?.title) return;
  const r = await api(`/api/decks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  S.decks = r.decks;
  renderDecks();
  renderDecksPage();
  toast('已改名');
}

async function deleteDeckFlow(id) {
  const deck = S.decks.find((d) => d.id === id);
  if (!confirm(`删除词库「${deck?.title || id}」？里面的单词和复习记录都会一起删除。`)) return;
  const r = await api(`/api/decks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  S.decks = r.decks;
  if (S.deckId === id) {
    const next = S.decks[0]?.id || null;
    S.deckId = next;
    if (next) {
      localStorage.setItem('wm.deck', next);
      const state = await api(`/api/state?deck=${encodeURIComponent(next)}`);
      S.words = state.words;
      S.stats = state.stats;
      await startSession();
    } else {
      S.words = [];
      S.stats = null;
    }
  }
  renderDecks();
  renderDecksPage();
  toast('已删除');
}

async function createDeckFlow() {
  const title = prompt('新词库名称，例如：五年级下册 Unit 2');
  if (!title) return;
  const r = await api('/api/decks', { method: 'POST', body: JSON.stringify({ title }) });
  S.decks = r.decks;
  renderDecks();
  await openDeck(r.id, 'admin');
  toast('词库已创建');
}

/* ---------------- 打印 ---------------- */

async function openPrint(kind, deckId, backView) {
  try {
    let data;
    if (kind === 'wrong') {
      const r = await api('/api/wrong');
      data = { kind: 'wrong', title: '错题本', words: r.items || [] };
    } else {
      const r = await api(`/api/decks/${encodeURIComponent(deckId)}/words`);
      data = { kind: 'deck', title: r.deck.title, words: r.words || [] };
    }
    S.print = data;
    S.printBack = backView || S.view;
    renderPrintSheet();
    $('#print-overlay').hidden = false;
    document.body.classList.add('printing');
    history.replaceState(null, '', kind === 'wrong' ? '#print/wrong' : `#print/deck/${deckId}`);
  } catch (e) {
    toast(e.message);
  }
}

function renderPrintSheet() {
  const p = S.print;
  if (!p) return;
  const opt = {
    def: $('#opt-def').checked,
    hook: $('#opt-hook').checked,
    example: $('#opt-example').checked,
    cn: $('#opt-cn').checked,
  };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const title = p.kind === 'wrong' ? '错题本' : p.title;

  $('#print-title').textContent = p.kind === 'wrong' ? '打印预览 · 错题本' : `打印预览 · ${p.title}`;
  $('#print-sub').textContent = `${p.words.length} 个词`;

  const items = p.words
    .map(
      (w) => `<article class="sheet-item">
        <div class="sheet-line">
          <span class="sheet-word">${esc(w.word)}</span>
          <span class="sheet-ipa">${esc(w.ipa || '')}</span>
          ${opt.cn ? `<span class="sheet-cn">${esc(w.cn || '')}</span>` : ''}
        </div>
        ${opt.def && w.enDef ? `<div class="sheet-meta"><b>英</b>${esc(w.enDef)}</div>` : ''}
        ${opt.hook && w.hook ? `<div class="sheet-meta"><b>钩</b>${esc(w.hook)}</div>` : ''}
        ${opt.example && w.example ? `<div class="sheet-meta"><b>例</b>${esc(w.example)}</div>` : ''}
        ${
          p.kind === 'wrong'
            ? `<div class="sheet-tag">错 ${w.progress?.wrongCount || 0} 次 · ${esc(w.deckTitle || '')}</div>`
            : ''
        }
      </article>`
    )
    .join('');

  $('#print-sheet').innerHTML = `
    <header class="sheet-head">
      <h1>${esc(title)}</h1>
      <span>${p.words.length} 个词 · ${date}</span>
    </header>
    ${p.words.length ? `<div class="sheet-grid">${items}</div>` : '<div class="sheet-empty">没有内容</div>'}`;
}

function closePrint() {
  $('#print-overlay').hidden = true;
  document.body.classList.remove('printing');
  S.print = null;
  history.replaceState(null, '', '#' + (S.printBack || 'learn'));
}

/* ---------------- 管理 ---------------- */

const FORM_FIELDS = [
  { key: 'word', label: '单词 *', type: 'text' },
  { key: 'ipa', label: '音标', type: 'text' },
  { key: 'cn', label: '中文 *', type: 'text' },
  { key: 'enDef', label: '英文解释', type: 'text' },
  { key: 'pos', label: '词性', type: 'text' },
  { key: 'syllables', label: '音节', type: 'text' },
  { key: 'chunks', label: '词块（逗号分隔）', type: 'text' },
  { key: 'family', label: '词族', type: 'text' },
  { key: 'synonyms', label: '近义', type: 'text' },
  { key: 'antonyms', label: '反义', type: 'text' },
  { key: 'example', label: '例句', type: 'text', full: true },
  { key: 'hook', label: '主钩', type: 'textarea', full: true },
  { key: 'altHook', label: '备钩', type: 'textarea', full: true },
  { key: 'extracts', label: '提取题（每行一个）', type: 'textarea', full: true },
];

async function loadAiStatus() {
  try {
    S.ai = await api('/api/ai/status');
  } catch {
    S.ai = { enabled: false, model: '' };
  }
  renderAiStatus();
}

function renderAiStatus() {
  const on = S.ai.enabled;
  const state = $('#ai-state');
  state.textContent = on ? `已启用 · ${S.ai.model}` : '未配置 · 仅手动录入';
  state.className = `hint ${on ? 'ok' : ''}`;
  $('#ai-test').disabled = !on;
  $('#ai-hint').textContent = on
    ? '添加单词后会自动补全空字段；已有内容不会被覆盖。也可以点每行的 AI 单独补齐。'
    : '没有检测到 API key。在 config.json 里填 deepseek.apiKey，或设置环境变量 DEEPSEEK_API_KEY，然后重启服务。';
}

async function enrichOne(id, quiet = false) {
  const res = await api(
    `/api/words/${id}/enrich?deck=${encodeURIComponent(S.deckId)}`,
    { method: 'POST' }
  );
  await reloadState();
  if (!quiet) toast(res.filled?.length ? `补齐了 ${res.filled.length} 个字段` : '字段已经齐了');
  return res;
}

async function enrichMany(ids, base = '') {
  const total = ids.length;
  const queue = ids.slice();
  let ok = 0;
  let failed = 0;
  let done = 0;
  let firstError = '';
  const prefix = base ? `${base} · ` : '';

  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        await enrichOne(id, true);
        ok++;
      } catch (e) {
        failed++;
        if (!firstError) firstError = e.message;
      }
      done++;
      $('#bulk-msg').textContent = `${prefix}AI 补齐中 ${done}/${total}…`;
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  await reloadState();
  $('#bulk-msg').textContent =
    `${prefix}AI 补齐 ${ok} 个` +
    (failed ? `，失败 ${failed} 个${firstError ? `（${firstError}）` : ''}` : '');
}

async function reloadState() {
  const state = await api(`/api/state?deck=${encodeURIComponent(S.deckId)}`);
  S.decks = state.decks;
  S.words = state.words;
  S.stats = state.stats;
  renderDecks();
  renderToday();
  renderAdmin();
  await loadWrong();
  if (S.view === 'stats') renderStats();
}

function renderAdmin() {
  updateWrongChip();
  $('#word-count').textContent = `· ${S.words.length} 个`;
  const rows = S.words
    .map(
      (w) => `<div class="atrow">
        <span class="w">${esc(w.word)}</span>
        <span class="hint">${esc(w.cn || '待补齐')}</span>
        <span class="${w.progress.wrongCount || w.progress.lastResult === 0 ? 'badge-wrong' : 'hint'}">${
          w.progress.wrongCount || (w.progress.lastResult === 0 ? '!' : '—')
        }</span>
        <span>${w.progress.box}</span>
        <span class="ops">
          <button class="mini" data-enrich="${w.id}" ${S.ai.enabled ? '' : 'disabled'}>AI</button>
          <button class="mini" data-edit="${w.id}">编辑</button>
          <button class="mini op-reset" data-reset="${w.id}">重置</button>
          <button class="mini danger" data-del="${w.id}">删除</button>
        </span>
      </div>`
    )
    .join('');
  $('#admin-table').innerHTML =
    `<div class="atrow head"><span>单词</span><span>中文</span><span>错</span><span>箱</span><span style="text-align:right">操作</span></div>` +
    (rows || '<div class="empty">这个词库还没有词，用上面的快速录入加几个。</div>');

  renderWrongList();
}

function renderWrongList() {
  const list = wrongWords();
  $('#wrong-count').textContent = `· ${list.length} 个`;
  $('#practice-wrong').disabled = list.length === 0;
  $('#clear-wrong').disabled = list.length === 0;

  $('#wrong-list').innerHTML = list.length
    ? list
        .map(
          (w) => `<div class="wrong-item">
            <span class="w">${esc(w.word)}</span>
            <span class="cn">${esc(w.cn || '待补齐')}${w.deckTitle ? `<span class="deck-tag">${esc(w.deckTitle)}</span>` : ''}</span>
            <span class="badge-wrong">${w.progress.wrongCount ? `错 ${w.progress.wrongCount} 次` : '上次没记住'} · 第 ${w.progress.box} 箱</span>
            <button class="mini" data-reset="${w.id}">重置</button>
          </div>`
        )
        .join('')
    : '<div class="empty">没有错词，继续保持。</div>';
}

function openWordModal(word) {
  S.modalWordId = word ? word.id : null;
  $('#modal-title').textContent = word ? `编辑 · ${word.word}` : '新增单词';
  $('#word-form').innerHTML = FORM_FIELDS.map((f) => {
    const value = word
      ? f.key === 'chunks'
        ? (word.chunks || []).join('，')
        : f.key === 'extracts'
          ? (word.extracts || []).join('\n')
          : (word[f.key] ?? '')
      : '';
    const input =
      f.type === 'textarea'
        ? `<textarea data-k="${f.key}" rows="2">${esc(value)}</textarea>`
        : `<input class="input" data-k="${f.key}" value="${esc(value)}" />`;
    return `<label class="${f.full ? 'full' : ''}"><span>${f.label}</span>${input}</label>`;
  }).join('');
  $('#modal').hidden = false;
  $('#modal-ai').classList.toggle('hidden', !S.ai.enabled);
  if (S.ai.enabled) {
    const label = $('#word-form [data-k="cn"]')?.closest('label')?.querySelector('span');
    if (label) label.textContent = '中文（可留空，AI 会补）';
  }
  $('#word-form [data-k="word"]')?.focus();
}

function closeModal() {
  $('#modal').hidden = true;
  S.modalWordId = null;
}

function collectForm() {
  const data = {};
  for (const f of FORM_FIELDS) {
    const el = $(`#word-form [data-k="${f.key}"]`);
    data[f.key] = el ? el.value.trim() : '';
  }
  data.chunks = data.chunks
    .split(/[,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  data.extracts = data.extracts
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return data;
}

async function saveWord() {
  const data = collectForm();
  if (!data.word) return toast('单词不能为空');
  if (!data.cn && !S.ai.enabled) return toast('中文不能为空（没配置 AI 时必填）');
  const isEdit = Boolean(S.modalWordId);
  try {
    let created = null;
    if (S.modalWordId) {
      await api(`/api/words/${S.modalWordId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...data, deck: S.deckId }),
      });
    } else {
      created = await api('/api/words', {
        method: 'POST',
        body: JSON.stringify({ ...data, deck: S.deckId }),
      });
    }
    closeModal();
    await reloadState();
    if (created && S.ai.enabled) {
      toast('已添加，AI 补齐中…');
      await enrichOne(created.word.id, true);
      toast('已添加并补齐');
    } else {
      toast(isEdit ? '已更新' : '已添加');
    }
  } catch (e) {
    toast(e.message.replace(/^\d+\s*/, ''));
  }
}

async function deleteWord(id) {
  const w = S.words.find((x) => x.id === id);
  if (!confirm(`删除「${w?.word || ''}」？它的复习记录也会一起删掉。`)) return;
  await api(`/api/words/${id}`, { method: 'DELETE' });
  await reloadState();
  toast('已删除');
}

async function resetOne(id) {
  await api(`/api/words/${id}/reset`, { method: 'POST' });
  await reloadState();
  toast('已重置');
}

async function bulkAdd() {
  const text = $('#bulk').value.trim();
  if (!text) return toast('先粘贴几行单词');
  const btn = $('#bulk-add');
  btn.disabled = true;
  try {
    const r = await api('/api/words/import', {
      method: 'POST',
      body: JSON.stringify({ deck: S.deckId, text }),
    });
    $('#bulk').value = '';
    await reloadState();

    const parts = [`新增 ${r.added}`];
    if (r.updated) parts.push(`更新 ${r.updated}`);
    if (r.skipped) parts.push(`跳过 ${r.skipped}`);
    const base = parts.join(' · ');
    $('#bulk-msg').textContent = base + (r.errors?.length ? `（${r.errors[0]}）` : '');
    if (r.errors?.length) toast(r.errors.slice(0, 2).join('；'));

    const ids = r.ids || [];
    if (S.ai.enabled && ids.length) await enrichMany(ids, base);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function createNewDeck() {
  const title = $('#new-deck').value.trim();
  if (!title) return toast('先写个词库名');
  const r = await api('/api/decks', { method: 'POST', body: JSON.stringify({ title }) });
  $('#new-deck').value = '';
  S.deckId = r.id;
  localStorage.setItem('wm.deck', r.id);
  await reloadState();
  await startSession();
  toast('词库已创建');
}

function exportDeck() {
  const payload = {
    title: S.decks.find((d) => d.id === S.deckId)?.title || S.deckId,
    words: S.words.map((w) => ({
      word: w.word,
      ipa: w.ipa,
      pos: w.pos,
      cn: w.cn,
      enDef: w.enDef,
      syllables: w.syllables,
      chunks: w.chunks,
      hook: w.hook,
      altHook: w.altHook,
      family: w.family,
      example: w.example,
      extracts: w.extracts,
      synonyms: w.synonyms,
      antonyms: w.antonyms,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `words-${S.deckId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importDeck(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const words = Array.isArray(data) ? data : data.words;
    const r = await api('/api/words/import', {
      method: 'POST',
      body: JSON.stringify({ deck: S.deckId, words }),
    });
    await reloadState();
    toast(`导入 ${r.added} 个，跳过 ${r.skipped} 个`);
  } catch (e) {
    toast('导入失败：文件不是合法 JSON');
  }
}

/* ---------------- 管理事件 ---------------- */

$('#btn-mastery').addEventListener('click', () => startMastery(S.words));
$('#btn-wrong').addEventListener('click', () => startMastery(wrongWords()));

$('#admin-table').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.enrich) {
    btn.disabled = true;
    btn.textContent = '…';
    enrichOne(Number(btn.dataset.enrich))
      .catch((e) => toast(e.message))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'AI';
      });
  } else if (btn.dataset.edit) openWordModal(S.words.find((w) => w.id === Number(btn.dataset.edit)));
  else if (btn.dataset.reset) resetOne(Number(btn.dataset.reset));
  else if (btn.dataset.del) deleteWord(Number(btn.dataset.del));
});

$('#wrong-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-reset]');
  if (btn) resetOne(Number(btn.dataset.reset));
});

$('#deck-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  if (d.open) openDeck(d.open, 'learn');
  else if (d.manage) openDeck(d.manage, 'admin');
  else if (d.print) openPrint('deck', d.print, 'decks');
  else if (d.rename) renameDeckFlow(d.rename);
  else if (d.del) deleteDeckFlow(d.del);
});

$('#decks-new').addEventListener('click', createDeckFlow);
$('#print-wrong').addEventListener('click', () => openPrint('wrong', null, 'admin'));
$('#print-close').addEventListener('click', closePrint);
$('#print-go').addEventListener('click', () => window.print());
['opt-def', 'opt-hook', 'opt-example', 'opt-cn'].forEach((id) => {
  $('#' + id).addEventListener('change', renderPrintSheet);
});

$('#add-word').addEventListener('click', () => openWordModal(null));

$('#ai-test').addEventListener('click', async () => {
  const btn = $('#ai-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    await api('/api/ai/test', { method: 'POST' });
    toast('连接正常');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
});

$('#bulk-add').addEventListener('click', bulkAdd);
$('#create-deck').addEventListener('click', createNewDeck);
$('#export-deck').addEventListener('click', exportDeck);
$('#import-deck').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importDeck(file);
  e.target.value = '';
});
$('#practice-wrong').addEventListener('click', () => startMastery(wrongWords()));
$('#clear-wrong').addEventListener('click', async () => {
  if (!confirm('清除所有词库的错误标记？复习进度不会变。')) return;
  await api('/api/wrong/clear', { method: 'POST', body: JSON.stringify({}) });
  await loadWrong();
  await reloadState();
  toast('错误标记已清除');
});

$('#modal-ai').addEventListener('click', async () => {
  const word = $('#word-form [data-k="word"]')?.value.trim();
  if (!word) return toast('先填单词');
  const btn = $('#modal-ai');
  btn.disabled = true;
  btn.textContent = '补齐中…';
  try {
    const { fields } = await api('/api/ai/fill', {
      method: 'POST',
      body: JSON.stringify({
        word,
        cn: $('#word-form [data-k="cn"]')?.value.trim() || '',
        pos: $('#word-form [data-k="pos"]')?.value.trim() || '',
      }),
    });
    for (const f of FORM_FIELDS) {
      const el = $(`#word-form [data-k="${f.key}"]`);
      if (!el) continue;
      const current = el.value.trim();
      if (current) continue; // 不覆盖已经写的
      const value = f.key === 'chunks' ? (fields.chunks || []).join('，') : f.key === 'extracts' ? (fields.extracts || []).join('\n') : fields[f.key] || '';
      if (value) el.value = value;
    }
    toast('已补齐，可以改完再保存');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 补齐';
  }
});

$('#modal-close').addEventListener('click', closeModal);
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-save').addEventListener('click', saveWord);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#print-overlay').hidden) closePrint();
  else if (!$('#modal').hidden) closeModal();
});

init();

