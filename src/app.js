/* 致知 前端：视图切换、导入、学习、考试、看板。 */

const tauriCore = window.__TAURI__ && window.__TAURI__.core;
const invoke = tauriCore
  ? tauriCore.invoke
  : async () => { throw new Error('Tauri 运行时未就绪，请通过桌面应用启动'); };

const state = {
  view: 'today',
  info: null,
  queue: { due: [], fresh: [], stats: {} },
  materials: [],
  preview: null,
  cards: [],
  learnIndex: 0,
  examCard: null,
  graph: 'stage',
  graphSvg: '',
  openMaterial: null,
  busy: false,
  importing: null,
  renaming: null,
  collapsed: [],
  learnQuery: '',
  learnMaterial: null,
  learnCardId: null,
  /// 已学单元：折叠区展开或切到「只看已学」时才去后端取
  learned: null,
  learnedLoading: null,
  learnedOpen: false,
  learnedOnly: false,
  /// 学习页当前清单（待学 + 已加载的已学），行号索引都对着它
  learnList: [],
  practice: null,
  reading: false,
  /// 划词浮标：当前选中的文字与选区位置（fixed 定位用）
  selectText: '',
  selectRect: null,
  learnCurrentId: null,
  /// 划词问答：一次对话对应一个选中段落，关掉就清空（第一版不落库）
  qa: {
    open: false, cardId: null, passage: '', history: [], followups: [],
    pending: '', failed: '', busy: false, error: '', deep: false,
  },
  /// 练习页：练习 / 错题 两个标签，练习里再分随机 / 指定单元
  examTab: 'practice',
  practiceMode: 'random',
  /// 指定单元练习的左侧清单（已学单元），按需加载
  reviewCards: null,
  /// 开始页一次取齐的数据：章节进度 + 两张图
  overview: null,
  /// 刚完成、还没播完粉碎动画的待办
  todoDone: [],
  /// 书架页：成书 / 导入材料 两个标签
  shelfTab: 'book',
  /// 成书：书架 / 当前这本 / 待确认的目录 / 生成中的进度
  book: {
    detail: null,
    outline: null,
    generating: null,
    form: { title: '', goal: '', materialIds: [] },
  },
};

const VIEW_TITLES = {
  today: '开始', shelf: '书架', learn: '学习', exam: '练习', quiz: '考试', insight: '看板', settings: '设置',
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(message, kind) {
  const node = el('toast');
  node.textContent = message;
  node.className = 'toast' + (kind === 'bad' ? ' is-bad' : kind === 'ok' ? ' is-ok' : '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'bad' ? 5200 : 2600);
}

async function call(command, args) {
  try {
    return await invoke(command, args || {});
  } catch (error) {
    toast(typeof error === 'string' ? error : (error && error.message) || '调用失败', 'bad');
    throw error;
  }
}

function withBusy(button, label, task) {
  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span>' + label; }
  return Promise.resolve()
    .then(task)
    .finally(() => { if (button) { button.disabled = false; button.textContent = original; } });
}

/* ── 视图切换 ─────────────────────────────── */

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.view === name);
  });
  document.querySelectorAll('.nav-item').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.view === name);
  });
  el('viewTitle').textContent = VIEW_TITLES[name] || name;
  if (name !== 'learn' && state.reading) setReading(false);
  if (name !== 'learn') { hideSelectActions(); closeTransPop(); closeQaDrawer(); }
  if (name !== 'settings') closeSettingsDrawer();
  if (name === 'insight') renderGraph();
  if (name === 'quiz') renderQuiz().catch((error) => toast('考试页加载失败：' + String(error), 'bad'));
  if (name === 'exam') {
    state.examTab = 'practice';
    state.practiceMode = 'random';
    showExamTab('practice');
    renderExam().catch((error) => toast('练习页加载失败：' + String(error), 'bad'));
  }
  if (name === 'shelf') loadShelf().catch((error) => toast('书架加载失败：' + String(error), 'bad'));
  if (name === 'learn') renderLearn();
  if (name === 'today') renderToday();
  if (name === 'settings') loadSettings().catch(() => {});
}

/* ── 数据加载 ─────────────────────────────── */

async function refresh() {
  const learnedBefore = state.queue.stats ? state.queue.stats.learned : null;
  const oldTodo = todoEntries();
  const results = await Promise.all([
    call('app_info'),
    call('today_queue'),
    call('list_materials'),
    call('list_exams'),
    call('start_overview').catch(() => null),
  ]);
  state.info = results[0];
  state.queue = results[1];
  state.materials = results[2];
  state.exams = results[3];
  state.overview = results[4];
  const freshIds = new Set(todoEntries().map((entry) => entry.card.id));
  const gone = oldTodo.filter((entry) => !freshIds.has(entry.card.id));
  if (gone.length) state.todoDone = gone.slice(0, 3);
  state.cards = state.queue.fresh.concat(state.queue.due);
  // 学完 / 复习让「已学」数量变了，已学清单与指定单元练习的缓存一起作废
  if (learnedBefore !== state.queue.stats.learned) {
    state.learned = null;
    state.reviewCards = null;
  }
  renderChrome();
  renderToday();
  renderShelf();
  renderPlans();
  renderLearn();
  if (state.view === 'quiz') renderQuiz().catch(() => {});
  if (state.view === 'exam') renderExam().catch(() => {});
}

/* 今日待办 = 计划今天该学还没学的 + 到期还没复习的 */
function todoCount() {
  return ((state.queue.scheduled || []).length) + ((state.queue.due || []).length);
}

function renderChrome() {
  const s = state.queue.stats || {};
  el('railDue').textContent = todoCount();
  el('railDue').className = 'rail-stat-value is-due';
  el('railStreak').textContent = s.streakDays || 0;
  el('railStreak').className = 'rail-stat-value is-streak';
  el('railModel').textContent = state.info
    ? (state.info.llmReady ? state.info.model : '未配置 API Key')
    : '连接中';
  el('topMetrics').innerHTML = [
    '已学 <b>' + (s.learned || 0) + '</b> / ' + (s.cards || 0),
    '待复习 <b>' + (s.dueToday || 0) + '</b>',
    '平均分 <b>' + (s.avgScore || 0) + '</b>',
    '连续 <b>' + (s.streakDays || 0) + '</b> 天',
  ].map((item) => '<span>' + item + '</span>').join('');
}

/* ── 今日 ─────────────────────────────────── */

function ring(pct, number, caption) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, pct)));
  return '<div class="ring"><svg width="128" height="128" viewBox="0 0 128 128">' +
    '<circle class="ring-track" cx="64" cy="64" r="' + r + '" fill="none" stroke-width="8"/>' +
    '<circle class="ring-value" cx="64" cy="64" r="' + r + '" fill="none" stroke-width="8" ' +
    'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '"/></svg>' +
    '<div class="ring-label"><span class="ring-num">' + number + '</span>' +
    '<span class="ring-cap">' + caption + '</span></div></div>';
}

/* 跳到学习页的某一节；计划排得很靠后时它不在前 60 条队列里，按需补进来 */
async function openLearnUnit(id) {
  let fresh = state.queue.fresh || [];
  let index = fresh.findIndex((card) => card.id === id);
  if (index < 0) {
    const all = await call('list_cards', {});
    const card = (all || []).find((item) => item.id === id);
    if (!card || card.learned) { toast('这一节已经标记学过了', 'bad'); return; }
    state.queue.fresh = fresh.concat([card]);
    fresh = state.queue.fresh;
    index = fresh.length - 1;
  }
  state.learnIndex = index;
  state.learnMaterial = null;
  state.learnQuery = '';
  state.learnedOnly = false;
  switchView('learn');
  renderLearn();
}


function today() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

let todoDoneTimer = null;

function todoEntries() {
  return (state.queue.scheduled || []).map((card) => ({ card: card, kind: 'scheduled' }))
    .concat((state.queue.due || []).map((card) => ({ card: card, kind: 'due' })));
}

function renderToday() {
  const s = state.queue.stats || {};
  const due = state.queue.due || [];
  const fresh = state.queue.fresh || [];
  const scheduledNow = state.queue.scheduled || [];
  const pct = s.cards ? s.learned / s.cards : 0;

  let title = '';
  let copy = '';
  let actions = '';

  if (due.length > 0) {
    title = '有 ' + due.length + ' 张卡该复习了';
    copy = '它们刚好落在记忆快要衰减的位置，先清掉这几张，再去学新内容。';
    actions = '<button class="btn btn-primary" data-action="review-due">开始复习</button>' +
      '<button class="btn" data-action="go-import">补新材料</button>';
  } else if (scheduledNow.length > 0) {
    title = '今天还有 ' + scheduledNow.length + ' 个单元要学';
    copy = '先按计划学完今天的量，学完当天就考一次，第一次答题决定后面几周的复习节奏。';
    actions = '<button class="btn btn-primary" data-action="learn-scheduled">学今天的单元</button>' +
      '<button class="btn" data-action="go-import">导入材料</button>';
  } else if (fresh.length > 0) {
    title = '还可以推进 ' + fresh.length + ' 个新知识点';
    copy = '排一份学习计划，每天自动分好量；不排也可以想学多少学多少。';
    actions = '<button class="btn btn-primary" data-action="learn-first">继续学习</button>' +
      '<button class="btn" data-action="go-import">导入材料</button>';
  } else {
    title = '先给 致知 一份材料';
    copy = '网页链接、PDF、Word 或直接粘贴文本，模型会拆成知识点卡片与考题。';
    actions = '<button class="btn btn-primary" data-action="go-import">去导入</button>';
  }

  el('todayFocus').innerHTML =
    '<div class="focus"><div>' +
    '<h3 class="focus-title">' + title + '</h3>' +
    '<p class="focus-copy">' + copy + '</p>' +
    '<div class="focus-actions">' + actions + '</div>' +
    '</div>' + ring(pct, (s.learned || 0) + '/' + (s.cards || 0), '已学知识点') + '</div>';

  el('dueHint').textContent = (due.length || scheduledNow.length)
    ? (scheduledNow.length ? '该学 ' + scheduledNow.length : '') +
      (scheduledNow.length && due.length ? ' · ' : '') +
      (due.length ? '到期复习 ' + due.length : '')
    : '今天没有安排';
  renderTodoList();
  renderChapters();
  renderStartCharts();
}

/* 今天要做：固定高度滚动；刚完成的卡片第一次回开始页时碎掉再移除 */
function todoRowHTML(entry, done) {
  const card = entry.card;
  const scheduled = entry.kind === 'scheduled';
  const attrs = done
    ? 'class="row todo-row is-done"'
    : scheduled
      ? 'class="row todo-row" data-learn-id="' + card.id + '"'
      : 'class="row todo-row" data-card="' + card.id + '" data-mode="exam"';
  return '<div ' + attrs + '>' +
    '<span class="dot ' + (scheduled ? 'dot-new' : 'dot-due') + '"></span>' +
    '<div class="row-main"><div class="row-title">' + escapeHtml(card.title) + '</div>' +
    '<div class="row-sub">' + escapeHtml(card.materialTitle || '材料') + ' · ' +
    escapeHtml(card.section || '未分类') + '</div></div>' +
    '<div class="row-side">' + (done ? '已完成' : scheduled ? '计划今天学' : '到期复习') + '</div></div>';
}

function renderTodoList() {
  const list = el('dueList');
  const entries = todoEntries();
  const animating = state.view === 'today' ? state.todoDone : [];
  if (!entries.length && !animating.length) {
    list.innerHTML = '<div class="empty">今天该做的都做完了。想加量就去「学习」页推进新知识点。</div>';
    return;
  }
  list.innerHTML = animating.map((entry) => todoRowHTML(entry, true)).join('') +
    entries.map((entry) => todoRowHTML(entry, false)).join('');
  if (animating.length) playTodoDone(list);
}

function playTodoDone(list) {
  list.querySelectorAll('.row.is-done').forEach((row) => {
    for (let i = 0; i < 6; i += 1) {
      const bit = document.createElement('span');
      bit.className = 'todo-bit';
      bit.style.setProperty('--dx', Math.round(Math.random() * 90 - 45) + 'px');
      bit.style.setProperty('--dy', Math.round(-Math.random() * 26 - 4) + 'px');
      bit.style.setProperty('--delay', Math.round(Math.random() * 90) + 'ms');
      row.appendChild(bit);
    }
  });
  clearTimeout(todoDoneTimer);
  todoDoneTimer = setTimeout(() => {
    state.todoDone = [];
    renderTodoList();
  }, 780);
}

/* 右侧章节进度：按材料 + 章节显示已学 / 总数 */
function renderChapters() {
  const chapters = (state.overview && state.overview.chapters) || [];
  if (!chapters.length) {
    el('chapterHint').textContent = '';
    el('chapterList').innerHTML = '<div class="empty">导入材料后，这里按章节显示进度</div>';
    return;
  }
  el('chapterHint').textContent = chapters.length + ' 章';
  el('chapterList').innerHTML = chapters.map((chapter) => {
    const pct = chapter.total ? Math.round((chapter.learned / chapter.total) * 100) : 0;
    return '<div class="chapter-row">' +
      '<div class="chapter-text"><span class="chapter-name">' + escapeHtml(chapter.section || '未分类') +
      '</span><span class="chapter-sub">' + escapeHtml(chapter.material) + '</span></div>' +
      '<span class="chapter-count">' + chapter.learned + '/' + chapter.total + '</span>' +
      '<div class="bar"><span style="width:' + pct + '%"></span></div></div>';
  }).join('');
}

/* 两张图来自后端 start_overview：到期量与记忆保持率 */
function renderStartCharts() {
  const overview = state.overview;
  el('dueChart').innerHTML = overview
    ? overview.dueChart
    : '<div class="empty">图表加载中…</div>';
  el('retentionChart').innerHTML = overview
    ? overview.retentionChart
    : '<div class="empty">图表加载中…</div>';
  renderRetentionStats();
}

/* 记忆保持率卡片顶部的四个指标：今天 / 30 天后 / 低于 90% / 参与卡片 */
function renderRetentionStats() {
  const box = el('retentionStats');
  const stats = state.overview && state.overview.retentionStats;
  if (!stats || !stats.cards) {
    box.innerHTML = '<span class="retention-stat">还没有可计算的复习记录</span>';
    return;
  }
  const items = [
    ['今天平均', Math.round(stats.today) + '%', ''],
    ['30 天后', Math.round(stats.day30) + '%', ''],
    ['低于 90%', stats.below90 + ' 张', 'is-warn'],
    ['参与卡片', stats.cards + ' 张', ''],
  ];
  box.innerHTML = items.map(([label, value, cls]) =>
    '<span class="retention-stat' + (cls ? ' ' + cls : '') + '">' + label +
    '<b>' + value + '</b></span>').join('');
}

function metric(value, label) {
  return '<div class="metric"><div class="metric-value">' + value + '</div>' +
    '<div class="metric-label">' + label + '</div></div>';
}

function ratingLabel(rating) {
  return { 1: '忘记', 2: '有点难', 3: '记得', 4: '太简单' }[rating] || '已复习';
}

/* ── 材料 ─────────────────────────────────── */


/* 内容到手之后：切分单元 → 补考点，全过程进度都写在材料库那一行上。 */
async function importItem(item) {
  state.importing = { label: '正在切分学习单元…', source: item.title };
  renderShelf();
  const out = await call('create_material', { item: item });
  state.importing = { label: '已切分 ' + out.units + ' 个单元 · 正在补考点…', source: item.title };
  renderShelf();
  const result = await polishUnits(out.materialId);
  state.importing = null;
  if (result.error) {
    toast('已导入 ' + out.units + ' 个单元，但考点没生成：' + result.error, 'bad');
  } else {
    toast('导入完成：' + out.units + ' 个学习单元 · ' + result.polished + ' 份考点', 'ok');
  }
  await refresh();
  switchView('learn');
}

/* 给还没有考点的单元补考点；返回补了几份、以及第一处失败原因。 */
async function polishUnits(materialId) {
  let polished = 0;
  let error = '';
  for (;;) {
    const step = await call('polish_units_step', { materialId: materialId, limit: 6 });
    polished += step.polished;
    if (step.error && !error) error = step.error;
    if (state.importing) {
      state.importing.label = '正在补考点 ' + polished + '/' + (polished + step.remaining) + '…';
      renderShelf();
    }
    if (step.done || step.polished === 0) break;
  }
  return { polished: polished, error: error };
}


async function commitRename(input) {
  const id = Number(input.dataset.rename);
  const title = input.value.trim();
  if (state.renaming === null) return;
  state.renaming = null;
  if (!title) { renderShelf(); return; }
  input.disabled = true;
  await call('rename_material', { materialId: id, title: title });
  toast('已重命名', 'ok');
  await refresh();
}

/* 正文开头自带的一级标题常与卡片标题一字不差，去掉以免同一句显示两遍 */
function stripLeadTitle(markdown, title) {
  const norm = (text) => String(text || '')
    .replace(/[#*_>\u0060\s《》「」【】]/g, '')
    .toLowerCase();
  const want = norm(title);
  const lines = String(markdown || '').split('\n');
  let head = 0;
  while (head < lines.length && !lines[head].trim()) head += 1;
  if (!want || head >= lines.length) return markdown;
  const first = lines[head].trim().replace(/^#{1,6}\s*/, '');
  if (norm(first) !== want) return markdown;
  lines.splice(head, 1);
  return lines.join('\n');
}

/* ── 轻量 Markdown 渲染（学习页用，无第三方依赖）───────── */

function renderMarkdown(source) {
  const FENCE = '\u0060\u0060\u0060';
  const CODE = '\u0060([^\u0060]+)\u0060';
  const inline = (text) => escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(new RegExp(CODE, 'g'), '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = String(source || '').split('\n');
  const html = [];
  let inCode = false;
  let codeLang = '';
  let code = [];
  let list = null;
  let table = [];

  const closeList = () => { if (list) { html.push('</' + list + '>'); list = null; } };
  const closeTable = () => {
    if (!table.length) return;
    const rows = table.filter((row) => !/^\|[\s:|-]+\|$/.test(row));
    html.push('<table>');
    rows.forEach((row, index) => {
      const cells = row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const tag = index === 0 ? 'th' : 'td';
      html.push('<tr>' + cells.map((cell) => '<' + tag + '>' + inline(cell) + '</' + tag + '>').join('') + '</tr>');
    });
    html.push('</table>');
    table = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith(FENCE)) {
      if (inCode) {
        const source = code.join('\n');
        // 流程图交给 mermaid 画；其它语言照旧当代码块显示
        html.push(codeLang === 'mermaid'
          ? '<div class="mermaid">' + escapeHtml(source) + '</div>'
          : '<pre><code>' + escapeHtml(source) + '</code></pre>');
        code = [];
        codeLang = '';
        inCode = false;
      } else {
        closeList();
        closeTable();
        codeLang = line.trim().slice(FENCE.length).trim().toLowerCase();
        inCode = true;
      }
      continue;
    }
    if (inCode) { code.push(raw); continue; }

    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed)) { closeList(); table.push(trimmed); continue; }
    closeTable();

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      closeList();
      html.push('<blockquote>' + inline(trimmed.replace(/^>\s?/, '')) + '</blockquote>');
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push('<li>' + inline(bullet[1]) + '</li>');
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push('<li>' + inline(numbered[1]) + '</li>');
      continue;
    }
    if (!trimmed) { closeList(); continue; }
    closeList();
    html.push('<p>' + inline(trimmed) + '</p>');
  }
  if (inCode && code.length) {
    html.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
  }
  closeList();
  closeTable();
  return html.join('\n');
}

/* ── 学习计划 ─────────────────────────────── */

async function renderPlans() {
  const box = el('planBlock');
  let plans = [];
  try {
    plans = await call('list_plans');
  } catch (error) {
    box.innerHTML = '<div class="empty">读取学习计划失败</div>';
    return;
  }

  if (!plans.length) {
    const options = (state.materials || [])
      .map((m) => '<option value="' + m.id + '">' + escapeHtml(m.title) + '（' + m.cardCount + ' 单元）</option>')
      .join('');
    box.innerHTML =
      '<div class="block-head"><h2>安排学习计划</h2></div>' +
      '<div class="plan-sub">选一份素材库、定个期限，系统会把单元按天排好，每天照着学就行。</div>' +
      '<div class="plan-form">' +
      '<label>素材库<select id="planMaterial">' + (options || '<option value="">还没有材料</option>') + '</select></label>' +
      '<label>计划天数<input id="planDays" type="number" min="1" max="365" value="14" /></label>' +
      '<button class="btn btn-primary" id="createPlanBtn">生成计划</button>' +
      '</div>';
    const button = el('createPlanBtn');
    if (button) button.addEventListener('click', createPlan);
    return;
  }

  const current = await call('plan_today', { planId: plans[0].id });
  const plan = current ? current.plan : plans[0];
  const percent = plan.unitsTotal ? Math.round((plan.learned / plan.unitsTotal) * 100) : 0;
  const units = current ? current.dayUnits : [];
  const pending = units.filter((card) => !card.learned);
  const listBody = units.length
    ? '<div class="list list-compact" style="margin-top:14px">' + pending.slice(0, 6).map((card) =>
        '<div class="row is-static"><div class="row-main"><div class="row-title">' + escapeHtml(card.title) +
        '</div><div class="row-sub">' + escapeHtml(card.section || '') + '</div></div></div>').join('') +
      (pending.length > 6 ? '<div class="empty">还有 ' + (pending.length - 6) + ' 个</div>' : '') + '</div>'
    : '<div class="empty" style="margin-top:12px">今天这一段已经学完了</div>';

  box.innerHTML =
    '<div class="plan-head"><div>' +
    '<div class="plan-title">' + escapeHtml(plan.materialTitle) + '</div>' +
    '<div class="plan-sub">进度第 ' + current.dayIndex + ' / ' + plan.days + ' 天 · 每天 ' +
    plan.perDay + ' 个单元 · 今天还剩 ' + pending.length + ' 个 · 全库还剩 ' +
    current.remainingUnits + ' 个未学</div></div>' +
    '<div class="row-side">' + percent + '%</div></div>' +
    '<div class="bar" style="margin-top:12px"><span style="width:' + percent + '%"></span></div>' +
    listBody +
    '<div class="plan-actions">' +
    '<button class="btn btn-primary" data-action="plan-study" data-id="' + plan.id + '">开始今天的学习</button>' +
    '<button class="btn" data-action="plan-delete" data-id="' + plan.id + '">删除计划</button>' +
    '</div>';
}

async function createPlan() {
  const materialId = Number((el('planMaterial') || {}).value || 0);
  const days = Number((el('planDays') || {}).value || 0);
  if (!materialId) { toast('先去材料页导入一份材料', 'bad'); return; }
  if (!days || days < 1) { toast('填一个计划天数', 'bad'); return; }
  await call('create_plan', { materialId: materialId, days: days });
  toast('计划已生成：' + days + ' 天', 'ok');
  await refresh();
}

/* ── 流程图 ───────────────────────────────── */

let mermaidLoading = null;

/* mermaid 有 2.5 MB，第一次遇到流程图才加载；离线可用，走本地文件。 */
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'mermaid.min.js';
      script.onload = () => {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: '"Microsoft YaHei", "Segoe UI", sans-serif',
          themeVariables: {
            primaryColor: '#f4fbf8',
            primaryBorderColor: '#047857',
            primaryTextColor: '#1a1d21',
            lineColor: '#5b6472',
            secondaryColor: '#f7f8fa',
            tertiaryColor: '#ffffff',
          },
        });
        resolve(window.mermaid);
      };
      script.onerror = () => reject(new Error('流程图组件加载失败'));
      document.head.appendChild(script);
    });
  }
  return mermaidLoading;
}

/* 把 .mermaid 占位块画成图；画不出来就保留源码，不影响继续阅读。 */
async function renderFlowcharts(root) {
  const nodes = Array.from(root.querySelectorAll('.mermaid'));
  if (!nodes.length) return;
  try {
    const mermaid = await loadMermaid();
    await mermaid.run({ nodes: nodes });
  } catch (error) {
    nodes.forEach((node) => node.classList.add('is-plain'));
  }
}

/* ── 学习 ─────────────────────────────────── */

/* 全屏阅读：收起导航与侧栏，正文独占窗口；再点一次或按 Esc 退出 */
function setReading(on) {
  state.reading = on;
  document.body.classList.toggle('is-reading', on);
  if (state.view === 'learn') renderLearn();
}

/* 已学单元：折叠区展开或切到「只看已学」时才去后端取正文，待学队列不背这份重量 */
function loadLearned() {
  if (state.learned) return Promise.resolve(state.learned);
  if (state.learnedLoading) return state.learnedLoading;
  state.learnedLoading = call('learned_cards', {})
    .then((cards) => {
      state.learned = cards || [];
      state.learnedLoading = null;
      if (state.view === 'learn') renderLearn();
      return state.learned;
    })
    .catch(() => {
      // 取失败也落个空清单，否则每次重画都会再打一遍接口
      state.learned = [];
      state.learnedLoading = null;
      if (state.view === 'learn') renderLearn();
      return state.learned;
    });
  return state.learnedLoading;
}

function groupBySection(cards) {
  const groups = [];
  const index = {};
  cards.forEach((card) => {
    const key = card.section || '未分类';
    if (!index[key]) { index[key] = { name: key, items: [] }; groups.push(index[key]); }
    index[key].items.push(card);
  });
  return groups;
}

function unitRowHtml(card, activeId) {
  return '<div class="row' + (card.id === activeId ? ' is-active' : '') +
    '" data-learn="' + card.id + '">' +
    '<div class="row-main"><div class="row-title">' + escapeHtml(card.title) +
    '</div></div></div>';
}

function unitGroupHtml(group, activeId) {
  const folded = state.collapsed.indexOf(group.name) >= 0;
  return '<div class="unit-group">' +
    '<div class="unit-group-title" data-section="' + escapeHtml(group.name) + '">' +
    '<span><span class="chev">' + (folded ? '▶' : '▼') + '</span>' +
    escapeHtml(group.name) + '</span><span>' + group.items.length + '</span></div>' +
    (folded ? '' : group.items.map((card) => unitRowHtml(card, activeId)).join('')) +
    '</div>';
}

/* 已学单元折叠区：默认收起，展开后按章节列在待学清单最底下 */
function learnedFoldHtml(learned, activeId) {
  const folded = !state.learnedOpen;
  const filtered = state.learnMaterial || (state.learnQuery || '').trim();
  // 没取回来之前先借统计里的总数（按素材库/搜索筛过就先不显示数字，免得对不上）
  const total = learned ? learned.length
    : filtered ? '' : ((state.queue.stats || {}).learned || 0);
  let body = '';
  if (!folded) {
    if (!learned) body = '<div class="empty">正在读取已学单元…</div>';
    else if (!learned.length) body = '<div class="empty">没有匹配的已学单元</div>';
    else body = groupBySection(learned).map((group) =>
      '<div class="unit-group-sub">' + escapeHtml(group.name) + '</div>' +
      group.items.map((card) => unitRowHtml(card, activeId)).join('')).join('');
  }
  return '<div class="unit-group unit-group-learned">' +
    '<div class="unit-group-title is-learned" data-learned-fold>' +
    '<span><span class="chev">' + (folded ? '▶' : '▼') + '</span>已学过的单元</span>' +
    '<span>' + total + '</span></div>' + body + '</div>';
}

function renderLearn() {
  // 换单元、换筛选都会重画正文，浮标、译文卡片和问答抽屉一起收掉
  hideSelectActions();
  closeTransPop();
  if (state.qa.open) closeQaDrawer();

  // 素材库切换器
  const select = el('learnMaterial');
  if (select) {
    const html = ['<option value="">全部素材库</option>'].concat(
      (state.materials || []).filter((m) => m.cardCount > 0).map((m) =>
        '<option value="' + m.id + '">' + escapeHtml(m.title) + '</option>')).join('');
    if (select.dataset.rendered !== html) {
      select.innerHTML = html;
      select.dataset.rendered = html;
    }
    select.value = state.learnMaterial ? String(state.learnMaterial) : '';
  }

  const filter = el('learnFilter');
  if (filter) {
    filter.classList.toggle('is-active', !!state.learnedOnly);
    filter.setAttribute('aria-pressed', state.learnedOnly ? 'true' : 'false');
  }

  const query = (state.learnQuery || '').trim().toLowerCase();
  const matches = (card) =>
    (!state.learnMaterial || card.materialId === state.learnMaterial) &&
    (!query ||
      (card.title || '').toLowerCase().includes(query) ||
      (card.section || '').toLowerCase().includes(query));

  const fresh = (state.queue.fresh || []).filter(matches);
  const learned = state.learned ? state.learned.filter(matches) : null;

  // 「只看已学」第一次点进来时正文还在后端，取回来再画
  if (state.learnedOnly && !state.learned) loadLearned();

  const list = state.learnedOnly ? (learned || []) : fresh.concat(learned || []);
  state.learnList = list;
  const current = list[state.learnIndex] || list[0];
  const activeId = current ? current.id : null;
  state.learnCurrentId = activeId;

  if (state.learnedOnly) {
    el('learnQueue').innerHTML = learned
      ? (list.length
          ? groupBySection(list).map((group) => unitGroupHtml(group, activeId)).join('')
          : '<div class="empty">' +
            (query ? '没有匹配「' + escapeHtml(state.learnQuery) + '」的已学单元' : '还没有学过的单元') + '</div>')
      : '<div class="empty">正在读取已学单元…</div>';
  } else {
    el('learnQueue').innerHTML =
      (fresh.length
        ? groupBySection(fresh).map((group) => unitGroupHtml(group, activeId)).join('')
        : '<div class="empty">' +
          (query ? '没有匹配「' + escapeHtml(state.learnQuery) + '」的待学单元' : '待学单元已经学完了') + '</div>') +
      learnedFoldHtml(learned, activeId);
  }

  if (!current) {
    el('learnCard').innerHTML = '<div class="empty">' +
      (state.learnedOnly ? '还没有可读的已学单元' : '导入材料后，这里会按章节列出全部学习单元') + '</div>';
    state.learnCardId = null;
    return;
  }

  const points = (current.keyPoints || []).length
    ? '<div class="unit-points"><div class="grade-sub">读完检查这几条</div><ul class="grade-list">' +
      current.keyPoints.map((point) => '<li>' + escapeHtml(point) + '</li>').join('') + '</ul></div>'
    : '';
  const quiz = current.question
    ? '<div class="unit-question"><div class="grade-sub">读完自测</div><p>' +
      escapeHtml(current.question) + '</p></div>'
    : '<div class="unit-question"><div class="grade-sub">读完自测</div><p class="block-note">' +
      '这一节的考点还在生成中，稍后刷新即可。</p></div>';
  // 测验答错/答漏的要点，交卷时写回卡上
  const quizNotes = (current.examNotes || []).length
    ? '<div class="unit-points unit-notes"><div class="grade-sub">考试里错过的点</div>' +
      '<ul class="grade-list">' +
      current.examNotes.map((note) => '<li>' + escapeHtml(note) + '</li>').join('') +
      '</ul></div>'
    : '';

  el('learnCard').innerHTML =
    '<div class="card-head">' +
      '<div class="card-head-text">' +
        '<div class="card-meta">' + escapeHtml(current.section || '') + ' · ' +
        escapeHtml(current.materialTitle) + ' · 第 ' + current.seq + ' 单元' +
        (current.learned ? ' · 已学' : '') + '</div>' +
        '<h3 class="card-title">' + escapeHtml(current.title) + '</h3>' +
      '</div>' +
      '<button class="btn btn-slim card-full" data-action="learn-full" title="' +
        (state.reading ? '退出全屏阅读' : '全屏阅读') + '">' +
        (state.reading ? '关闭' : '全屏') + '</button>' +
    '</div>' +
    '<div class="unit-body">' +
      renderMarkdown(stripLeadTitle(current.content || current.summary, current.title)) + '</div>' +
    points + quizNotes + quiz +
    '<div class="card-actions">' +
    '<button class="btn btn-primary" data-action="learn-to-exam" data-id="' + current.id + '">' +
    (current.learned ? '去练习' : '学完去练习') + '</button>' +
    '<button class="btn" data-action="learn-next">下一个单元</button></div>';

  // 换单元就把内容区滚回顶部：每个章节各看各的，不沿用上一个单元的滚动位置
  if (state.learnCardId !== current.id) {
    state.learnCardId = current.id;
    el('learnCard').scrollTop = 0;
  }
  renderFlowcharts(el('learnCard'));
}

/* ── 划词翻译 ─────────────────────────────── */

function translateOn() {
  return !!(state.info && state.info.translate);
}

function qaOn() {
  return !!(state.info && state.info.qa);
}

function hideSelectActions() {
  const box = el('selectActions');
  if (box) box.hidden = true;
  state.selectText = '';
  state.selectRect = null;
}

function closeTransPop() {
  const pop = el('transPop');
  if (pop) pop.hidden = true;
  const body = el('transBody');
  if (body) { body.textContent = ''; body.className = 'trans-body'; }
}

/* 浮动元素定位：水平跟着选区并收在视口内，垂直优先放在选区上方 */
function placeAbove(node, rect, gap) {
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const width = box.width || 80;
  const height = box.height || 30;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2,
    window.innerWidth - width - 8));
  let top = rect.top - height - gap;
  if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + gap);
  node.style.left = Math.round(left) + 'px';
  node.style.top = Math.round(Math.max(8, top)) + 'px';
}

function placeTransPop(rect) {
  const pop = el('transPop');
  pop.hidden = false;
  const box = pop.getBoundingClientRect();
  const width = box.width || 360;
  const height = box.height || 120;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 8;
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(Math.max(8, top)) + 'px';
}

/* 只认学习正文里的选区：标题、侧栏、按钮区都不弹浮标 */
function selectionInLearnCard() {
  const card = el('learnCard');
  const body = card && card.querySelector('.unit-body');
  const selection = window.getSelection();
  if (!body || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  return { text: text, rect: rect };
}

/* 浮标按设置决定显示哪几个动作：翻译 / 提问 */
function showSelectActions() {
  const picked = selectionInLearnCard();
  if (!picked || picked.text.length > 1200) { hideSelectActions(); return; }
  const trans = translateOn();
  const ask = qaOn();
  if (!trans && !ask) { hideSelectActions(); return; }
  el('transTrigger').hidden = !trans;
  el('askTrigger').hidden = !ask;
  state.selectText = picked.text;
  state.selectRect = picked.rect;
  placeAbove(el('selectActions'), picked.rect, 8);
}

async function requestTranslation() {
  const text = state.selectText;
  if (!text) return;
  const rect = state.selectRect || { left: 0, top: 0, right: 0, bottom: 0, width: 0 };
  hideSelectActions();
  const body = el('transBody');
  body.textContent = '翻译中…';
  body.className = 'trans-body is-busy';
  placeTransPop(rect);
  try {
    const result = await invoke('translate_text', { text: text });
    body.className = 'trans-body';
    body.textContent = result || '（模型没有返回译文）';
  } catch (error) {
    body.className = 'trans-body is-bad';
    body.textContent = '翻译失败：' +
      (typeof error === 'string' ? error : (error && error.message) || String(error));
  }
  placeTransPop(rect);
}

/* ── 划词问答 ─────────────────────────────── */

const QA_QUICK = ['讲再浅一点', '举个例子', '只给结论'];

function openQaDrawer() {
  const text = state.selectText;
  if (!text) return;
  state.qa = {
    open: true, cardId: state.learnCurrentId, passage: text,
    history: [], followups: [], pending: '', failed: '', busy: false, error: '',
    deep: state.qa.deep,
  };
  el('qaPassage').textContent = text;
  el('qaPassage').title = text;
  el('qaInput').value = '';
  el('qaDrawer').hidden = false;
  hideSelectActions();
  closeTransPop();
  renderQaThread();
  renderQaFollowups();
  setTimeout(() => el('qaInput').focus(), 60);
}

function closeQaDrawer() {
  const drawer = el('qaDrawer');
  if (drawer) drawer.hidden = true;
  if (state.qa) state.qa.open = false;
}

function renderQaThread() {
  const qa = state.qa;
  const thread = el('qaThread');
  if (!thread) return;
  let html = qa.history.map((turn) =>
    '<div class="qa-msg is-user">' + escapeHtml(turn.question) + '</div>' +
    '<div class="qa-msg is-bot">' + escapeHtml(turn.answer) + '</div>').join('');
  if (qa.busy) {
    html += '<div class="qa-msg is-user">' + escapeHtml(qa.pending) + '</div>' +
      '<div class="qa-msg is-bot is-busy"><span class="spinner"></span>正在想…</div>';
  }
  if (qa.error) {
    html += '<div class="qa-msg is-error"><span>' + escapeHtml(qa.error) + '</span>' +
      (qa.failed ? '<button class="btn btn-slim" type="button" data-qa-retry>重试</button>' : '') + '</div>';
  }
  if (!html) {
    html = '<div class="empty">就问这段：不懂的词、为什么这样写、换个条件还成不成立。</div>';
  }
  thread.innerHTML = html;
  thread.scrollTop = thread.scrollHeight;
}

function renderQaFollowups() {
  const qa = state.qa;
  const box = el('qaFollowups');
  if (!box) return;
  const items = (qa.followups || []).concat(QA_QUICK).slice(0, 6);
  box.innerHTML = items.map((text) =>
    '<button class="qa-chip" type="button" data-qa-ask="' + escapeHtml(text) + '">' +
    escapeHtml(text) + '</button>').join('');
  box.hidden = !qa.history.length || qa.busy;
  const deep = el('qaDeepBtn');
  if (deep) {
    deep.classList.toggle('is-active', !!qa.deep);
    deep.setAttribute('aria-pressed', qa.deep ? 'true' : 'false');
  }
}

async function askQa(question) {
  const qa = state.qa;
  const text = (question || '').trim();
  if (!qa.passage || qa.busy || !text) return;
  if (state.info && !state.info.llmReady) {
    qa.error = '还没有配置模型接口：去「设置」页填 API Key 和模型名';
    qa.failed = '';
    renderQaThread();
    return;
  }
  qa.busy = true;
  qa.error = '';
  qa.failed = '';
  qa.pending = text;
  renderQaThread();
  renderQaFollowups();
  try {
    const out = await invoke('ask_passage', {
      cardId: qa.cardId,
      passage: qa.passage,
      question: text,
      history: qa.history,
      deep: !!qa.deep,
    });
    // 等结果期间又开了新一段问答的话，旧结果丢掉
    if (state.qa !== qa) return;
    qa.history.push({ question: text, answer: out.answer || '（模型没有返回内容）' });
    qa.followups = (out.followups || []).slice(0, 3);
    qa.busy = false;
    qa.pending = '';
  } catch (error) {
    if (state.qa !== qa) return;
    qa.busy = false;
    qa.pending = '';
    qa.failed = text;
    qa.error = '回答失败：' +
      (typeof error === 'string' ? error : (error && error.message) || String(error));
  }
  renderQaThread();
  renderQaFollowups();
}

/* ── 考试 ─────────────────────────────────── */

/* 填单卡复习面板；列表里点选时只换卡，不重进页面 */
function showExamCard(card, mode) {
  state.examCard = card;
  state.examMode = mode || 'exam';
  el('examHeading').textContent = card.title;
  el('examSource').textContent = card.materialTitle + ' · 到期 ' + card.due + ' · 已复习 ' + card.reps + ' 次';
  el('examQuestion').textContent = card.question || '（这张卡没有题目，可先学一遍再自评）';
  el('examNotesPanel').innerHTML = (card.examNotes || []).length
    ? '<div class="unit-notes"><div class="grade-sub">考试里错过的点</div><ul class="grade-list">' +
      card.examNotes.map((note) => '<li>' + escapeHtml(note) + '</li>').join('') + '</ul></div>'
    : '';
  el('examAnswer').value = '';
  el('gradeBlock').hidden = true;
}

async function loadExamCard(cardId, mode) {
  let card = state.cards.find((c) => c.id === cardId)
    || (state.reviewCards || []).find((c) => c.id === cardId);
  if (!card) {
    const all = await call('list_cards', {});
    state.cards = all;
    card = all.find((c) => c.id === cardId);
  }
  if (!card) { toast('找不到这张卡', 'bad'); return; }
  switchView('exam');
  state.examTab = 'practice';
  state.practiceMode = 'unit';
  showExamCard(card, mode);
  showExamTab('practice');
}

async function submitGrade() {
  const card = state.examCard;
  if (!card) { toast('先选一道题', 'bad'); return; }
  const answer = el('examAnswer').value.trim();
  if (!answer) { toast('先写下你的回答', 'bad'); return; }
  await withBusy(el('gradeBtn'), '评判中', async () => {
    const result = await call('grade_answer', { cardId: card.id, answer: answer });
    const updated = await call('submit_review', {
      cardId: card.id, rating: result.rating, score: result.score, answer: answer, mode: 'exam',
    });
    el('gradeBlock').hidden = false;
    el('scorePill').textContent = result.score + ' / 10 · ' + ratingLabel(result.rating);
    const missed = (result.missed || []).map((m) => '<li>' + escapeHtml(m) + '</li>').join('');
    el('gradeBody').innerHTML =
      '<p class="grade-text">' + escapeHtml(result.feedback).replace(/\n/g, '<br>') + '</p>' +
      (missed ? '<div class="grade-sub">遗漏要点</div><ul class="grade-list">' + missed + '</ul>' : '') +
      (result.suggestion ? '<div class="grade-sub">参考回答</div><p class="grade-text">' +
        escapeHtml(result.suggestion) + '</p>' : '') +
      '<div class="grade-sub">下次复习 ' + updated.due + '（' + Math.max(1, Math.round(
        (new Date(updated.due) - new Date(today())) / 86400000)) + ' 天后）</div>';
    toast('已排到 ' + updated.due, 'ok');
    await refresh();
  });
}

async function submitSelfRating(rating) {
  const card = state.examCard;
  if (!card) { toast('先选一道题', 'bad'); return; }
  const updated = await call('submit_review', { cardId: card.id, rating: rating, mode: 'self' });
  toast('自评已记录，下次复习 ' + updated.due, 'ok');
  el('selfNote').textContent = '下次复习：' + updated.due;
  await refresh();
}


/* ── 练习：按已学章节随机出卷 ─────────────── */

function practiceState() {
  if (!state.practice) {
    state.practice = {
      exam: null, items: [], index: 0, answers: {},
      view: 'setup', progress: '', located: false,
    };
  }
  return state.practice;
}

/* 练习页顶部标签：练习 / 错题；练习里再分随机与指定单元 */
function showExamTab(name) {
  state.examTab = name === 'wrong' ? 'wrong' : 'practice';
  document.querySelectorAll('#examTabs .tab').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.examTab === state.examTab);
  });
  renderExamMode();
  if (state.examTab === 'wrong') renderWrongPane();
}

function renderExamMode() {
  const practice = state.examTab === 'practice';
  const unit = state.practiceMode === 'unit';
  el('practiceWrap').hidden = !(practice && !unit);
  el('unitWrap').hidden = !(practice && unit);
  el('wrongWrap').hidden = state.examTab !== 'wrong';
  el('practiceMode').hidden = !practice;
  document.querySelectorAll('#practiceMode .seg-item').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.mode === state.practiceMode);
  });
  if (practice && unit) renderUnitList();
}

async function ensureReviewCards() {
  if (state.reviewCards) return state.reviewCards;
  state.reviewCards = await call('learned_cards', {});
  return state.reviewCards;
}

async function renderUnitList() {
  const list = el('unitList');
  list.innerHTML = '<div class="empty">正在读取单元…</div>';
  let cards = [];
  try {
    cards = await ensureReviewCards();
  } catch (error) {
    list.innerHTML = '<div class="empty">读取单元失败，稍后再试</div>';
    return;
  }
  if (!cards.length) {
    list.innerHTML = '<div class="empty">还没有学过的单元，学完再来练。</div>';
    return;
  }
  const groups = [];
  const index = {};
  cards.forEach((card) => {
    const key = card.section || '未分类';
    if (!index[key]) { index[key] = { name: key, items: [] }; groups.push(index[key]); }
    index[key].items.push(card);
  });
  list.innerHTML = groups.map((group) =>
    '<div class="unit-group">' +
    '<div class="unit-group-title"><span>' + escapeHtml(group.name) + '</span><span>' +
    group.items.length + '</span></div>' +
    group.items.map((card) =>
      '<div class="row' + (state.examCard && state.examCard.id === card.id ? ' is-active' : '') +
      '" data-review-card="' + card.id + '">' +
      '<div class="row-main"><div class="row-title">' + escapeHtml(card.title) +
      '</div></div></div>').join('') +
    '</div>').join('');
}

function selectReviewCard(id) {
  const card = (state.reviewCards || []).find((c) => c.id === id);
  if (!card) return;
  showExamCard(card, 'exam');
  renderUnitList();
}

function renderWrongPane() {
  const list = el('wrongList');
  list.innerHTML = '<div class="empty">正在读取错题…</div>';
  call('list_wrong_items', { limit: 50 })
    .then((items) => {
      if (!items.length) {
        el('wrongHint').textContent = '';
        list.innerHTML = '<div class="empty">还没有错题。练习或考试里没拿满分的题会收在这里。</div>';
        return;
      }
      el('wrongHint').textContent = items.length + ' 道';
      list.innerHTML = items.map(wrongItemHTML).join('');
    })
    .catch(() => {
      list.innerHTML = '<div class="empty">读取错题失败，稍后再试</div>';
    });
}

function wrongItemHTML(entry) {
  const item = entry.item;
  const score = item.score == null ? 0 : item.score;
  const missed = (item.missed || []).map((m) => '<li>' + escapeHtml(m) + '</li>').join('');
  return '<div class="wrong-item">' +
    '<div class="wrong-head">' +
    '<span class="quiz-kind">' + escapeHtml(kindLabel(item.kind)) + '</span>' +
    '<span class="wrong-title">' + escapeHtml(item.stem || '（题干缺失）') + '</span>' +
    '<span class="wrong-score">' + score + ' / ' + item.points + '</span></div>' +
    '<div class="wrong-meta">' + escapeHtml(entry.examTitle) + ' · ' +
    (entry.examKind === 'practice' ? '练习' : '考试') + ' · ' +
    escapeHtml((entry.createdAt || '').slice(0, 10)) + '</div>' +
    (item.userAnswer ? '<div class="wrong-line"><b>你的答案</b>' + escapeHtml(item.userAnswer) + '</div>' : '') +
    '<div class="wrong-line"><b>参考答案</b>' + escapeHtml(item.answer || '（暂无）') + '</div>' +
    (item.explain ? '<div class="wrong-line"><b>解析</b>' + escapeHtml(item.explain) + '</div>' : '') +
    (missed ? '<div class="wrong-line"><b>遗漏</b><ul class="grade-list">' + missed + '</ul></div>' : '') +
    '</div>';
}

/* 打开练习页：有没交卷的练习就接着做，否则给一个「开始练习」的入口 */
async function renderExam() {
  const practice = practiceState();
  if (!practice.exam) {
    const open = (state.exams || []).find((exam) => exam.kind === 'practice' && exam.status !== 'done');
    if (open) practice.exam = { id: open.id };
  }
  if (practice.exam) {
    const paper = await call('get_exam', { examId: practice.exam.id });
    practice.exam = paper.exam;
    practice.items = paper.items;
    practice.items.forEach((item) => {
      if (item.userAnswer) practice.answers[item.id] = item.userAnswer;
    });
    if (practice.view === 'setup') {
      practice.view = practice.exam.status === 'done' ? 'result' : 'paper';
    }
    if (!practice.located) {
      practice.located = true;
      practice.index = firstOpenIndex(practice.items, practice.answers);
    }
  }
  renderExamMain();
  renderExamSide();
}

/* 接着上次做：落到第一道还没答的题 */
function firstOpenIndex(items, answers) {
  const index = items.findIndex((item) => (answers[item.id] || item.userAnswer || '').trim() === '');
  if (index >= 0) return index;
  return Math.max(0, items.length - 1);
}

function renderExamMain() {
  const practice = practiceState();
  const box = el('practiceMain');
  if (practice.view === 'paper') {
    box.innerHTML = paperHTML(practice);
    bindPaper(practice, 'practiceMain', submitPractice, () => { renderExamMain(); renderExamSide(); });
    return;
  }
  if (practice.view === 'result') { box.innerHTML = resultHTML(practice); return; }
  box.innerHTML = practiceSetupHTML();
  const start = el('practiceStartBtn');
  if (start) start.addEventListener('click', (event) => withBusy(event.currentTarget, '出题中', () => startPractice()));
}

function practiceSetupHTML() {
  const practice = practiceState();
  return '<div class="block">' +
    '<div class="block-head"><h2>随机练习</h2>' +
    '<span class="block-hint">只考学过的单元 · 每章 1–3 题 · 题型随机 · 必有一道简答</span></div>' +
    '<p class="block-note">题目从你已经学过的单元里随机抽：逐题作答，答不上来可以跳过，' +
    '随时交卷。没做完的练习会留着，下次打开接着做。</p>' +
    '<div class="field-row field-row-end" style="margin-top:16px">' +
    '<span class="kbd-hint">Ctrl + Enter 交卷</span>' +
    '<button class="btn btn-primary" id="practiceStartBtn">开始一份练习</button>' +
    '</div>' +
    (practice.progress ? '<div class="result" style="margin-top:14px">' + escapeHtml(practice.progress) + '</div>' : '') +
    '</div>';
}

function renderExamSide() {
  const practice = practiceState();
  const side = el('practiceSide');
  if (practice.view !== 'paper' || !practice.items.length) {
    side.innerHTML = '<div class="block"><div class="block-head"><h2>怎么练</h2></div>' +
      '<div class="block-note">题量按章节随机：每章 1–3 道；题型也随机，其中至少一道简答题。</div>' +
      '<div class="block-note">客观题（单选 / 多选 / 判断 / 填空）本地判分，简答题交模型按点给分。</div>' +
      '<div class="block-note">跳过不答的题不计分，卷子留着——下次打开练习页继续。</div></div>';
    return;
  }
  side.innerHTML = paperNavHTML(practice);
  bindPaperNav(practice, side, () => { renderExamMain(); renderExamSide(); });
}

async function startPractice() {
  const practice = practiceState();
  practice.progress = '正在按已学章节随机抽题…';
  renderExamMain();
  const out = await call('create_practice', { materialId: null });
  practice.exam = { id: out.examId };
  practice.items = [];
  practice.answers = {};
  practice.index = 0;
  practice.located = false;
  practice.view = 'setup';
  renderExamMain();
  await paperSteps(out.examId, (step) => {
    practice.progress = '正在出题 ' + step.made + '/' + (step.made + step.remaining) + '…';
    renderExamMain();
  });
  practice.located = false;
  practice.progress = '';
  await renderExam();
  toast('练习出好了：' + out.total + ' 题', 'ok');
}

async function submitPractice() {
  const practice = practiceState();
  if (!practice.exam) return;
  const paper = await call('submit_exam', { examId: practice.exam.id });
  practice.exam = paper.exam;
  practice.items = paper.items;
  practice.view = 'result';
  toast('已判分：' + (paper.exam.score || 0) + ' / ' + paper.exam.fullScore + ' 分', 'ok');
  renderExamMain();
  renderExamSide();
  await refresh();
}

/* 逐批出题；一次出不完就接着来，连着出不来就停手，别死循环 */
async function paperSteps(examId, onStep) {
  let last = -1;
  for (;;) {
    const step = await call('exam_step', { examId: examId, batch: 4 });
    onStep(step);
    if (step.error) toast('出题中断：' + step.error, 'bad');
    if (step.done || step.remaining === 0) break;
    if (step.made <= last) break;
    last = step.made;
  }
}

/* ── 测验：出卷 / 答题 / 判分 / 复习要点 ───── */

const QUIZ_KINDS = [
  ['single', '单选题', 2],
  ['judge', '判断题', 1],
  ['blank', '填空题', 2],
  ['multi', '多选题', 3],
  ['short', '简答题', 5],
  ['case', '案例题', 8],
];

const QUIZ_PRESETS = {
  10: { single: 3, judge: 1, blank: 2, multi: 2, short: 1, case: 1 },
  20: { single: 6, judge: 3, blank: 4, multi: 3, short: 3, case: 1 },
  30: { single: 9, judge: 4, blank: 6, multi: 5, short: 4, case: 2 },
  50: { single: 15, judge: 7, blank: 10, multi: 8, short: 7, case: 3 },
};

function quizState() {
  if (!state.quiz) {
    state.quiz = {
      exam: null,
      items: [],
      index: 0,
      answers: {},
      view: 'setup',
      strategy: 'all',
      materialId: null,
      total: 20,
      counts: Object.assign({}, QUIZ_PRESETS[20]),
      progress: '',
      busy: false,
    };
  }
  return state.quiz;
}

function quizTotal() {
  const quiz = quizState();
  return QUIZ_KINDS.reduce((sum, item) => sum + (quiz.counts[item[0]] || 0), 0);
}

async function renderQuiz() {
  const quiz = quizState();
  if (quiz.exam) {
    const paper = await call('get_exam', { examId: quiz.exam.id });
    quiz.exam = paper.exam;
    quiz.items = paper.items;
  }
  renderQuizMain();
  renderQuizSide();
  renderQuizHistory();
}

function renderQuizMain() {
  const quiz = quizState();
  const box = el('quizMain');
  if (quiz.view === 'paper') {
    box.innerHTML = paperHTML(quiz);
    bindPaper(quiz, 'quizMain', submitExam, () => { renderQuizMain(); renderQuizSide(); });
    return;
  }
  if (quiz.view === 'result') { box.innerHTML = resultHTML(quiz); return; }
  box.innerHTML = quizSetupHTML();
  bindQuizSetup();
}

function quizSetupHTML() {
  const quiz = quizState();
  const options = (state.materials || []).map((material) =>
    '<option value="' + material.id + '"' +
    (quiz.materialId === material.id ? ' selected' : '') + '>' +
    escapeHtml(material.title) + '（' + material.cardCount + ' 单元）</option>').join('');
  const strategies = [['all', '全部单元'], ['learned', '只考学过的'], ['weak', '薄弱优先']]
    .map(([value, label]) => '<button class="seg-item' + (quiz.strategy === value ? ' is-active' : '') +
      '" data-strategy="' + value + '">' + label + '</button>').join('');
  const kinds = QUIZ_KINDS.map(([key, label]) => {
    const count = quiz.counts[key] || 0;
    return '<div class="kind-row' + (count ? ' is-on' : '') + '">' +
      '<span class="kind-name">' + label + '</span>' +
      '<span class="kind-step">' +
      '<button data-kind-step="' + key + '" data-delta="-1">−</button>' +
      '<span class="kind-count">' + count + '</span>' +
      '<button data-kind-step="' + key + '" data-delta="1">+</button>' +
      '</span></div>';
  }).join('');

  return '<div class="block">' +
    '<div class="block-head"><h2>出一份卷子</h2>' +
    '<span class="block-hint">按知识点出题，客观题本地判分，简答与案例交模型按点给分</span></div>' +
    '<label class="field"><span class="field-label">素材库</span>' +
    '<select id="quizMaterial"><option value="">全部素材库</option>' + options + '</select></label>' +
    '<div class="field"><span class="field-label">抽题范围</span>' +
    '<div class="seg" id="quizStrategy">' + strategies + '</div></div>' +
    '<div class="field"><span class="field-label">题量</span>' +
    '<div class="seg" id="quizTotal">' + [10, 20, 30, 50].map((n) =>
      '<button class="seg-item' + (quiz.total === n ? ' is-active' : '') + '" data-total="' + n + '">' + n + ' 题</button>').join('') +
    '</div></div>' +
    '<div class="field"><span class="field-label">题型（每种题的分值固定：单选 2 / 判断 1 / 填空 2 / 多选 3 / 简答 5 / 案例 8）</span>' +
    '<div class="kind-grid" id="quizKinds">' + kinds + '</div></div>' +
    '<div class="field-row field-row-end">' +
    '<span class="kbd-hint">当前 ' + quizTotal() + ' 题 · 满分 ' + quizFullScore() + ' 分</span>' +
    '<button class="btn btn-primary" id="quizCreateBtn">开始出卷</button></div>' +
    (quiz.progress ? '<div class="result">' + escapeHtml(quiz.progress) + '</div>' : '') +
    '</div>';
}

function quizFullScore() {
  const quiz = quizState();
  return QUIZ_KINDS.reduce((sum, [key, , points]) => sum + (quiz.counts[key] || 0) * points, 0);
}

function bindQuizSetup() {
  const quiz = quizState();
  el('quizMaterial').addEventListener('change', (event) => {
    quiz.materialId = Number(event.target.value) || null;
  });
  el('quizStrategy').addEventListener('click', (event) => {
    const button = event.target.closest('[data-strategy]');
    if (!button) return;
    quiz.strategy = button.dataset.strategy;
    renderQuizMain();
  });
  el('quizTotal').addEventListener('click', (event) => {
    const button = event.target.closest('[data-total]');
    if (!button) return;
    quiz.total = Number(button.dataset.total);
    quiz.counts = Object.assign({}, QUIZ_PRESETS[quiz.total]);
    renderQuizMain();
  });
  el('quizKinds').addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind-step]');
    if (!button) return;
    const key = button.dataset.kindStep;
    const delta = Number(button.dataset.delta);
    quiz.counts[key] = Math.max(0, Math.min(60, (quiz.counts[key] || 0) + delta));
    renderQuizMain();
  });
  el('quizCreateBtn').addEventListener('click', (event) => withBusy(event.currentTarget, '出卷中', () => createExam()));
}

async function createExam() {
  const quiz = quizState();
  const plan = QUIZ_KINDS
    .filter(([key]) => (quiz.counts[key] || 0) > 0)
    .map(([key]) => ({ kind: key, count: quiz.counts[key] }));
  if (!plan.length) { toast('至少选一种题型', 'bad'); return; }
  quiz.busy = true;
  try {
    const out = await call('create_exam', {
      materialId: quiz.materialId,
      strategy: quiz.strategy,
      plan: plan,
    });
    quiz.exam = { id: out.examId, title: '', total: out.total, fullScore: out.fullScore, status: 'draft' };
    quiz.progress = '已排好 ' + out.total + ' 道题（覆盖 ' + out.cards + ' 个知识点），正在出题…';
    renderQuizMain();
    await examSteps(out.examId);
    quiz.view = 'paper';
    quiz.index = 0;
    toast('卷子出好了，开始答题', 'ok');
    await renderQuiz();
  } catch (error) {
    toast('出卷失败：' + String(error), 'bad');
    quiz.progress = '出卷失败：' + String(error);
    renderQuizMain();
  } finally {
    quiz.busy = false;
  }
}

async function examSteps(examId) {
  const quiz = quizState();
  await paperSteps(examId, (step) => {
    quiz.progress = '正在出题 ' + step.made + '/' + (step.made + step.remaining) + '…';
    renderQuizMain();
  });
}

/// 答题界面：测验页和练习页共用，machine 是各自那份卷子状态。
function paperHTML(machine) {
  const item = machine.items[machine.index];
  if (!item) return '<div class="block"><div class="empty">这张卷子还没有题目。</div></div>';
  const answer = machine.answers[item.id] || item.userAnswer || '';
  const label = kindLabel(item.kind);

  let body = '';
  if (item.kind === 'single' || item.kind === 'judge' || item.kind === 'multi') {
    const multiple = item.kind === 'multi';
    const byText = item.kind === 'judge';
    body = '<div class="quiz-options">' + item.options.map((text, index) => {
      const key = String.fromCharCode(65 + index);
      const value = byText ? text : key;
      const picked = multiple ? answer.includes(key) : (byText ? answer === text : answer === key);
      return '<label class="quiz-option' + (picked ? ' is-picked' : '') + '">' +
        '<input type="' + (multiple ? 'checkbox' : 'radio') + '" name="q' + item.id + '" value="' + escapeHtml(value) + '"' +
        (picked ? ' checked' : '') + ' data-answer="' + item.id + '" />' +
        '<span>' + (byText ? '' : '<span class="quiz-option-key">' + key + '.</span> ') + escapeHtml(text) + '</span></label>';
    }).join('') + '</div>';
  } else if (item.kind === 'blank') {
    body = '<label class="field"><span class="field-label">你的答案</span>' +
      '<input type="text" data-answer="' + item.id + '" value="' + escapeHtml(answer) + '" placeholder="填入答案" /></label>';
  } else {
    body = '<label class="field"><span class="field-label">你的作答</span>' +
      '<textarea rows="8" data-answer="' + item.id + '" placeholder="写出关键机制、取舍与结论">' +
      escapeHtml(answer) + '</textarea></label>';
  }

  return '<div class="block">' +
    '<div class="quiz-head">' +
    '<div><span class="quiz-kind">' + label + '</span>' +
    '<span class="quiz-seq">' + item.seq + ' / ' + machine.items.length + ' · ' + item.points + ' 分</span></div>' +
    '<span class="block-hint">' + escapeHtml(item.cardTitle || '') + '</span></div>' +
    '<p class="quiz-stem">' + escapeHtml(item.stem) + '</p>' +
    body +
    '<div class="quiz-actions">' +
    '<button class="btn" data-quiz-nav="prev">上一题</button>' +
    '<button class="btn" data-quiz-nav="next">下一题</button>' +
    '<span class="spacer"></span>' +
    '<button class="btn btn-primary" data-paper-submit="1">交卷并判分</button>' +
    '</div></div>';
}

function bindPaper(machine, rootId, submit, rerender) {
  const root = el(rootId);
  const item = machine.items[machine.index];
  if (!item) return;
  root.querySelectorAll('[data-answer]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = Number(input.dataset.answer);
      const current = machine.items.find((entry) => entry.id === id);
      if (current && current.kind === 'multi') {
        const picked = Array.from(root.querySelectorAll('[data-answer="' + id + '"]:checked'))
          .map((node) => node.value).sort().join('');
        machine.answers[id] = picked;
      } else {
        machine.answers[id] = input.value;
      }
      call('save_exam_answer', { itemId: id, answer: machine.answers[id] }).catch(() => {});
      rerender();
    });
  });
  root.querySelectorAll('[data-quiz-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      const delta = button.dataset.quizNav === 'next' ? 1 : -1;
      machine.index = Math.min(machine.items.length - 1, Math.max(0, machine.index + delta));
      rerender();
    });
  });
  const submitBtn = root.querySelector('[data-paper-submit]');
  if (submitBtn) submitBtn.addEventListener('click', (event) =>
    withBusy(event.currentTarget, '判分中', () => submit()));
}

async function submitExam() {
  const quiz = quizState();
  const paper = await call('submit_exam', { examId: quiz.exam.id });
  quiz.exam = paper.exam;
  quiz.items = paper.items;
  quiz.view = 'result';
  toast('已判分：' + (paper.exam.score || 0) + ' / ' + paper.exam.fullScore + ' 分', 'ok');
  await renderQuiz();
  await refresh();
}

function renderQuizSide() {
  const quiz = quizState();
  const side = el('quizSide');
  if (quiz.view === 'setup' || !quiz.items.length) {
    side.innerHTML = '<div class="block"><div class="block-head"><h2>怎么用</h2></div>' +
      '<div class="block-note">选好范围与题型后出卷：客观题（单选 / 多选 / 判断 / 填空）本地判分，' +
      '简答和案例交模型按点给分。交卷后会生成复习要点，并把要点写回对应知识点。</div></div>';
    return;
  }
  side.innerHTML = paperNavHTML(quiz);
  bindPaperNav(quiz, side, () => { renderQuizMain(); renderQuizSide(); });
}

/// 题号导航：测验与练习共用。
function paperNavHTML(machine) {
  const answers = machine.answers;
  const nav = machine.items.map((item, index) => {
    const answered = (answers[item.id] || item.userAnswer || '').trim() !== '';
    const done = machine.view === 'result';
    const cls = ['quiz-nav-item'];
    if (done) cls.push(item.verdict === 'correct' ? 'is-right' : 'is-wrong');
    else if (index === machine.index) cls.push('is-current');
    else if (answered) cls.push('is-answered');
    return '<button class="' + cls.join(' ') + '" data-quiz-jump="' + index + '">' + item.seq + '</button>';
  }).join('');
  const answeredCount = machine.items.filter((item) => (answers[item.id] || item.userAnswer || '').trim() !== '').length;
  return '<div class="block">' +
    '<div class="block-head"><h2>题号</h2><span class="block-hint">已答 ' + answeredCount + '/' + machine.items.length + '</span></div>' +
    '<div class="quiz-nav">' + nav + '</div>' +
    '<div class="quiz-legend"><span>· 实心 = 当前题</span><span>· 描边 = 已作答</span>' +
    (machine.view === 'result' ? '<span>· 绿 = 答对，红 = 答错</span>' : '') + '</div>' +
    '</div>';
}

function bindPaperNav(machine, side, rerender) {
  side.querySelectorAll('[data-quiz-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      machine.index = Number(button.dataset.quizJump);
      rerender();
    });
  });
}

function renderQuizHistory() {
  const list = el('quizHistoryList');
  if (!list) return;
  const exams = (state.exams || []).filter((exam) => exam.kind !== 'practice');
  el('quizHistoryHint').textContent = exams.length ? exams.length + ' 次' : '';
  list.innerHTML = exams.length
    ? exams.map((exam) => '<div class="row" data-quiz-open="' + exam.id + '">' +
        '<div class="row-main"><div class="row-title">' + escapeHtml(exam.title) + '</div>' +
        '<div class="row-sub">' + escapeHtml(exam.createdAt.slice(0, 16).replace('T', ' ')) +
        ' · ' + exam.made + '/' + exam.total + ' 题' +
        (exam.status === 'done' ? '' : ' · 未交卷') + '</div></div>' +
        '<div class="row-side">' + (exam.score == null ? '—' : exam.score + ' / ' + exam.fullScore) + '</div>' +
        '<button class="btn btn-slim" data-quiz-del="' + exam.id + '">删除</button></div>').join('')
    : '<div class="empty">还没有考试记录。出第一份卷子试试。</div>';
}

function kindLabel(kind) {
  const hit = QUIZ_KINDS.find(([key]) => key === kind);
  return hit ? hit[1] : '题目';
}

/// 交卷后的成绩页：测验与练习共用。
function resultHTML(machine) {
  const exam = machine.exam || {};
  const items = machine.items;
  const right = items.filter((item) => item.verdict === 'correct').length;
  const rows = items.map((item) => {
    const okClass = item.verdict === 'correct' ? '' : (item.verdict === 'partial' ? ' is-partial' : '');
    const mine = (item.userAnswer || '').trim();
    return '<div class="quiz-review-item' + okClass + '">' +
      '<h4>' + item.seq + '. ' + kindLabel(item.kind) + ' · 得分 ' +
      (item.score == null ? 0 : item.score) + '/' + item.points +
      (item.verdict === 'correct' ? ' · 正确' : item.verdict === 'partial' ? ' · 部分正确' : ' · 错误') + '</h4>' +
      '<div class="line">' + escapeHtml(item.stem) + '</div>' +
      '<div class="line">正确答案：' + escapeHtml(item.answer || '—') + '</div>' +
      '<div class="line">你的作答：' + escapeHtml(mine || '（没答）') + '</div>' +
      (item.explain ? '<div class="line">解析：' + escapeHtml(item.explain) + '</div>' : '') +
      (item.feedback ? '<div class="line">评语：' + escapeHtml(item.feedback) + '</div>' : '') +
      (item.suggestion ? '<div class="line">要点：' + escapeHtml(item.suggestion) + '</div>' : '') +
      '</div>';
  }).join('');

  return '<div class="block">' +
    '<div class="block-head"><h2>成绩</h2><span class="block-hint">' + escapeHtml(exam.title || '') + '</span></div>' +
    '<div class="score-big"><span class="num">' + (exam.score == null ? 0 : exam.score) + '</span>' +
    '<span class="of">/ ' + (exam.fullScore || 0) + ' 分 · 全对 ' + right + '/' + items.length + ' 题</span></div>' +
    '<div class="field-row" style="margin-top:16px">' +
    '<button class="btn btn-primary" data-quiz-again="1">再出一份</button>' +
    '<button class="btn" data-quiz-review="1">回看题目</button>' +
    '</div></div>' +
    '<div class="block quiz-report"><div class="block-head"><h2>复习要点</h2>' +
    '<span class="block-hint">已写回对应知识点，学习时能看到</span></div>' +
    (exam.report ? renderMarkdown(exam.report) : '<div class="empty">没有需要重点复习的题。</div>') +
    '</div>' +
    '<div class="block"><div class="block-head"><h2>逐题回顾</h2></div>' + rows + '</div>';
}

/* ── 看板（阶段指导 / 知识地图 / 复习计划）─── */

async function renderGraph() {
  const canvas = el('graphCanvas');
  canvas.innerHTML = '<div class="empty"><span class="spinner"></span>正在生成图表</div>';
  try {
    const command = {
      knowledge: 'render_knowledge_map',
      plan: 'render_review_plan',
      stage: 'render_stage_guide',
    }[state.graph];
    const svg = await call(command, state.graph === 'knowledge' ? { materialId: null } : {});
    state.graphSvg = svg;
    canvas.innerHTML = svg;
  } catch (error) {
    canvas.innerHTML = '<div class="empty">图表生成失败：' + escapeHtml(String(error)) + '</div>';
  }
}

async function exportGraph() {
  if (!state.graphSvg) { toast('先生成一张图', 'bad'); return; }
  const path = await call('export_svg', { name: state.graph, svg: state.graphSvg });
  toast('已导出：' + path, 'ok');
  await call('reveal_path', { path: path });
}

/* ── 设置 ─────────────────────────────────── */

async function loadSettings() {
  const s = await call('get_settings');
  state.settings = s;
  el('sApiBase').value = s.apiBase || '';
  el('sApiKey').value = s.apiKey || '';
  el('sModel').value = s.model || '';
  el('sProxyUrl').value = s.proxyUrl || '';
  el('sNoProxy').value = s.noProxy || '';
  setProxyMode(s.proxyMode || 'auto');
  el('dataDir').textContent = (state.info && state.info.dataDir) || '';
  setSeg('#notifySeg', 'notify', s.notify !== false);
  setSeg('#translateSeg', 'translate', s.translate === true);
  setSeg('#qaSeg', 'qa', s.qa !== false);
  refreshSettingValues();
  await loadAutostart();
}

/* 两行入口的右侧摘要：抽屉里一改，行上的字跟着变 */
function refreshSettingValues() {
  const value = (id) => {
    const input = el(id);
    return input ? input.value.trim() : '';
  };
  const model = value('sModel') || 'deepseek-chat';
  el('valueLlm').textContent = model + (value('sApiKey') ? ' · 已填 Key' : ' · 未填 Key');
  const mode = { auto: '自动', manual: '手动', off: '不用代理' }[currentProxyMode()] || '自动';
  const url = value('sProxyUrl');
  el('valueProxy').textContent = url ? mode + ' · ' + url : mode;
}

/* 右侧抽屉：要填写的项从这里进，改完点「完成」收起 */
function openSettingsDrawer(name, focusId) {
  el('drawerLlm').hidden = name !== 'llm';
  el('drawerProxy').hidden = name !== 'proxy';
  el('drawerTitle').textContent = name === 'proxy' ? '网络代理' : '模型接口';
  el('settingsDrawer').hidden = false;
  if (focusId) {
    const input = el(focusId);
    if (input) setTimeout(() => input.focus(), 50);
  }
}

function closeSettingsDrawer() {
  const drawer = el('settingsDrawer');
  if (drawer) drawer.hidden = true;
}

/* 二选一的开关：把 data-* 值和当前状态对上 */
function setSeg(selector, key, on) {
  document.querySelectorAll(selector + ' .seg-item').forEach((button) => {
    button.classList.toggle('is-active', (button.dataset[key] === 'on') === !!on);
  });
}

/* 开机自启：状态以注册表为准，切换后立刻落盘。 */
async function loadAutostart() {
  try {
    setAutostartSeg(await call('autostart_on'));
  } catch (error) {
    setAutostartSeg(false);
  }
}

function setAutostartSeg(on) {
  document.querySelectorAll('#autostartSeg .seg-item').forEach((button) => {
    button.classList.toggle('is-active', (button.dataset.auto === 'on') === !!on);
  });
}

function setProxyMode(mode) {
  document.querySelectorAll('#proxyMode .seg-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === mode);
  });
  refreshSettingValues();
}

function currentProxyMode() {
  const active = document.querySelector('#proxyMode .seg-item.is-active');
  return active ? active.dataset.mode : 'auto';
}

function collectSettings() {
  return {
    apiBase: el('sApiBase').value.trim(),
    apiKey: el('sApiKey').value.trim(),
    model: el('sModel').value.trim(),
    // notify / translate 是即时开关，不跟着表单提交；这里带上当前值，免得保存接口时被重置
    notify: !(state.settings && state.settings.notify === false),
    translate: !!(state.settings && state.settings.translate),
    qa: !(state.settings && state.settings.qa === false),
    proxyMode: currentProxyMode(),
    proxyUrl: el('sProxyUrl').value.trim(),
    noProxy: el('sNoProxy').value.trim(),
  };
}

async function saveSettings(silent) {
  const info = await call('save_settings', { settings: collectSettings() });
  state.info = info;
  renderChrome();
  refreshSettingValues();
  if (!silent) {
    el('saveHint').textContent = '已保存 · ' + new Date().toLocaleTimeString();
    toast('设置已保存，接口已重建', 'ok');
  }
  return info;
}

function showResult(id, result) {
  const node = el(id);
  node.hidden = false;
  node.className = 'result' + (result.ok ? ' is-ok' : ' is-bad');
  node.textContent = result.message + (result.detail ? '\n' + result.detail : '');
}

async function detectProxy() {
  const info = await call('detect_proxy');
  const node = el('proxyResult');
  node.hidden = false;
  node.className = 'result' + (info.effective ? ' is-ok' : '');
  node.textContent = [
    '环境变量代理：' + (info.envProxy || '无'),
    'Windows 系统代理：' + (info.systemProxy || '未启用'),
    '本地代理端口：' + (info.openPorts.length
      ? info.openPorts.map((port) => '127.0.0.1:' + port).join('、')
      : '未发现'),
    '当前实际使用：' + (info.effective || '直连'),
  ].join('\n');
  if (!el('sProxyUrl').value.trim() && info.suggested) {
    el('sProxyUrl').value = info.suggested;
    toast('已填入检测到的代理地址，点保存生效', 'ok');
  }
}

async function loadShelf() {
  state.materials = await call('list_materials');
  renderShelf();
  paintBook();
}

function showShelfTab(name) {
  state.shelfTab = name;
  document.querySelectorAll('[data-shelf-tab]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.shelfTab === name);
  });
  const searching = name === 'search';
  el('bookPane').hidden = !searching;
  el('importPane').hidden = searching;
  renderShelf();
}

function paintBook() {
  el('bookPane').innerHTML = bookMainHTML();
}

function bookMainHTML() {
  if (state.book.detail) return bookReaderHTML();
  if (state.book.outline) return bookOutlineHTML();
  return bookFormHTML();
}

function bookFormHTML() {
  const form = state.book.form;
  const picked = (state.materials || []).filter((item) => form.materialIds.includes(item.id));
  const scope = picked.length
    ? '已选 ' + picked.length + ' 份：' + picked.map((item) => item.title).join('、')
    : '全部材料' + (state.materials && state.materials.length ? '（' + state.materials.length + ' 份）' : '');
  return `
    <div class="book-form">
      <label class="field">
        <span class="field-label">书名或主题</span>
        <input id="bookTitle" type="text" placeholder="例如：RAG 从入门到落地" value="${escapeHtml(form.title)}" />
      </label>
      <label class="field">
        <span class="field-label">学习目标（可不填）</span>
        <input id="bookGoal" type="text" placeholder="例如：三个月内能自己搭一套检索问答" value="${escapeHtml(form.goal)}" />
      </label>
      <div class="field">
        <span class="field-label">素材</span>
        <p class="book-scope">${escapeHtml(scope)}</p>
      </div>
      <div class="field-row field-row-end">
        <button class="btn btn-primary" data-book="outline">生成目录</button>
      </div>
    </div>`;
}

function bookOutlineHTML() {
  const outline = state.book.outline;
  const rows = outline.chapters.map((chapter) => `
    <li>
      <div class="book-outline-head">
        <b>${escapeHtml(chapter.title)}</b>
        <span class="book-outline-n">${chapter.keys.length} 条素材</span>
      </div>
      <p class="book-outline-intro">${escapeHtml(chapter.intro)}</p>
    </li>`).join('');
  return `
    <div class="book-outline">
      <p class="book-origin">${escapeHtml(outline.origin)}</p>
      <ol class="book-outline-list">${rows}</ol>
      <div class="field-row field-row-end">
        <button class="btn btn-slim" data-book="back">返回改一下</button>
        <button class="btn btn-primary" data-book="create">开始写</button>
      </div>
    </div>`;
}

function bookReaderHTML() {
  const detail = state.book.detail;
  const book = detail.book;
  const gen = state.book.generating;
  const done = book.chapters > 0 && book.written >= book.chapters;
  const progress = gen
    ? `正在写正文：已写 ${gen.written} 章，剩 ${gen.remaining == null ? '…' : gen.remaining} 章${gen.error ? '（' + escapeHtml(gen.error) + '）' : ''}`
    : '';
  const head = `
    <div class="book-head">
      <h3 class="book-title">${escapeHtml(book.title)}</h3>
      <div class="book-head-row">
        <span class="book-meta">${book.chapters} 章 · 已写 ${book.written}</span>
        <span class="book-tag${done ? ' is-done' : ''}">${done ? '已完稿' : '未完稿'}</span>
      </div>
      ${book.goal ? `<p class="book-goal">${escapeHtml(book.goal)}</p>` : ''}
      <p class="book-origin">${escapeHtml(book.origin)}</p>
      ${progress ? `<div class="result is-ok">${progress}</div>` : ''}
      <div class="field-row">
        <button class="btn btn-slim" data-book="export" data-id="${book.id}">导出 Markdown</button>
        <button class="btn btn-slim" data-book="new">再写一本</button>
      </div>
    </div>`;
  const chapters = detail.chapters.map((chapter) => {
    const body = chapter.body.trim();
    return `
      <article class="book-chapter" id="bookCh${chapter.seq}">
        <h3><span class="book-chapter-no">第 ${chapter.seq} 章</span>${escapeHtml(chapter.title)}</h3>
        ${chapter.intro ? `<p class="book-chapter-intro">${escapeHtml(chapter.intro)}</p>` : ''}
        ${body
          ? `<div class="book-prose">${renderMarkdown(body)}</div>`
          : `<div class="book-pending">这一章还没写。<button class="btn btn-slim" data-book="continue" data-id="${book.id}">继续生成</button></div>`}
      </article>`;
  }).join('');
  return head + chapters;
}

function renderShelf() {
  const items = state.materials || [];
  const detail = state.book.detail;
  const picking = state.shelfTab === 'search' && !detail;
  const openMaterial = detail ? detail.book.materialId : null;

  const busy = state.importing
    ? '<div class="row is-busy"><span class="spinner"></span>' +
      '<div class="row-main"><div class="row-title">' + escapeHtml(state.importing.label) + '</div>' +
      '<div class="row-sub">' + escapeHtml(state.importing.source) + '</div></div></div>'
    : '';

  const rows = items.map((m) => {
    const picked = state.book.form.materialIds.includes(m.id);
    const active = openMaterial != null && openMaterial === m.id;
    const parts = [];
    if (m.chapters) parts.push(m.chapters + ' 章');
    if (m.cardCount) parts.push(m.cardCount + ' 个单元');
    if (m.pendingCount) parts.push('待补 ' + m.pendingCount);
    parts.push(escapeHtml(String(m.createdAt).slice(0, 10)));
    return `<div class="row${picked || active ? ' is-picked' : ''}" data-item="${m.id}"` +
      (picking && !m.chapters ? ` data-scope="${m.id}"` : '') +
      (m.bookId ? ` data-open-book="${m.bookId}"` : '') + '>' +
      '<div class="row-main">' +
      (state.renaming === m.id
        ? `<input class="inline-input" data-rename="${m.id}" value="${escapeHtml(m.title)}" />`
        : `<div class="row-title">${escapeHtml(m.title)}</div>`) +
      `<div class="row-sub">${parts.join(' · ')}</div></div>` +
      (m.pendingCount ? `<button class="btn btn-slim" data-act="polish" data-id="${m.id}">补考点</button>` : '') +
      `<button class="btn btn-slim" data-act="rename" data-id="${m.id}">重命名</button>` +
      (m.bookId
        ? `<button class="btn btn-slim" data-book="export" data-id="${m.bookId}">导出</button>`
        : `<button class="btn btn-slim" data-act="export" data-id="${m.id}">导出</button>`) +
      `<button class="btn btn-slim" data-act="del" data-id="${m.id}">删除</button>` +
      '</div>';
  }).join('');

  el('shelfList').innerHTML = busy + rows +
    (items.length ? '' : '<div class="empty">书架还是空的：切到「本地导入」加材料，或在上边填个书名上网搜。</div>');

  if (state.renaming) {
    const input = document.querySelector('[data-rename]');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commitRename(input);
        if (event.key === 'Escape') { state.renaming = null; renderShelf(); }
      });
      input.addEventListener('blur', () => commitRename(input));
    }
  }

  el('tocHead').hidden = !detail;
  el('bookToc').innerHTML = detail
    ? detail.chapters.map((chapter) => `
      <button class="book-toc-row" data-book="jump" data-seq="${chapter.seq}">
        <span class="book-toc-no">${chapter.seq}</span>${escapeHtml(chapter.title)}
      </button>`).join('')
    : '';
}

async function runOutline(button) {
  const form = state.book.form;
  const title = form.title.trim();
  if (!title) { toast('先给这本书起个名字', 'bad'); return; }
  await withBusy(button, '排目录…', async () => {
    const outline = await call('book_outline', {
      title,
      goal: form.goal.trim(),
      materialIds: form.materialIds.slice(),
    });
    state.book.outline = outline;
    state.book.detail = null;
    paintBook();
    toast('目录排好了：' + outline.chapters.length + ' 章', 'ok');
  }).catch(() => {});
}

async function createAndWrite(button) {
  const outline = state.book.outline;
  if (!outline) return;
  const form = state.book.form;
  const bookId = await withBusy(button, '建书中…', () => call('book_create', {
    materialId: outline.materialId == null ? null : outline.materialId,
    title: form.title.trim(),
    goal: form.goal.trim(),
    origin: outline.origin,
    chapters: outline.chapters,
  })).catch(() => null);
  if (!bookId) return;
  state.book.outline = null;
  await openBook(bookId);
  await runGenerate(bookId).catch(() => {});
  await loadShelf().catch(() => {});
}

async function openBook(bookId) {
  state.book.detail = await call('book_get', { bookId });
  state.book.outline = null;
  paintBook();
  renderShelf();
}

async function exportBook(bookId) {
  const path = await call('book_export', { bookId });
  toast('已导出：' + path, 'ok');
  await call('reveal_path', { path }).catch(() => {});
}

async function runGenerate(bookId) {
  state.book.generating = { written: 0, remaining: null, error: '' };
  paintBook();
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const step = await call('book_generate_step', { bookId, limit: 2 });
    state.book.generating = {
      written: state.book.generating.written + step.written,
      remaining: step.remaining,
      error: step.error || '',
    };
    paintBook();
    if (step.done || step.remaining === 0) break;
    if (step.written === 0 && step.error) break;
  }
  state.book.generating = null;
  await openBook(bookId);
  const missing = state.book.detail ? state.book.detail.chapters.some((chapter) => !chapter.body.trim()) : false;
  toast(missing ? '有章节没写出来，点「继续生成」重试' : '这本书写完了', missing ? 'bad' : 'ok');
}

/* ── 事件绑定 ─────────────────────────────── */

function bind() {
  el('nav').addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item');
    if (button) switchView(button.dataset.view);
  });

  el('shelfTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-shelf-tab]');
    if (tab) showShelfTab(tab.dataset.shelfTab);
  });

  const bookView = document.querySelector('.view[data-view="shelf"]');
  bookView.addEventListener('input', (event) => {
    if (event.target.id === 'bookTitle') state.book.form.title = event.target.value;
    if (event.target.id === 'bookGoal') state.book.form.goal = event.target.value;
  });
  bookView.addEventListener('click', (event) => {
    const rowBook = event.target.closest('[data-open-book]');
    if (rowBook) { openBook(Number(rowBook.dataset.openBook)).catch(() => {}); return; }

    const scopeRow = event.target.closest('[data-scope]');
    if (scopeRow && !event.target.closest('[data-act]') && !event.target.closest('input')) {
      const id = Number(scopeRow.dataset.scope);
      const kept = state.book.form.materialIds.filter((item) => item !== id);
      if (!state.book.form.materialIds.includes(id)) kept.push(id);
      state.book.form.materialIds = kept;
      renderShelf();
      paintBook();
      return;
    }

    const trigger = event.target.closest('[data-book]');
    if (!trigger) return;
    const action = trigger.dataset.book;
    const id = Number(trigger.dataset.id || 0);
    if (action === 'outline') runOutline(trigger);
    else if (action === 'create') createAndWrite(trigger);
    else if (action === 'back') { state.book.outline = null; paintBook(); }
    else if (action === 'new') {
      state.book.detail = null;
      state.book.outline = null;
      state.book.form = { title: '', goal: '', materialIds: [] };
      paintBook();
      renderShelf();
    } else if (action === 'export') exportBook(id).catch(() => {});
    else if (action === 'continue') runGenerate(id).catch(() => {});
    else if (action === 'jump') {
      const node = el('bookCh' + trigger.dataset.seq);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  el('examTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-exam-tab]');
    if (tab) showExamTab(tab.dataset.examTab);
  });
  el('practiceMode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    state.practiceMode = button.dataset.mode;
    renderExamMode();
  });
  el('unitList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-review-card]');
    if (row) selectReviewCard(Number(row.dataset.reviewCard));
  });

  document.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-card]');
    const learnRow = event.target.closest('[data-learn]');
    const materialAct = event.target.closest('[data-act]');
    const action = event.target.closest('[data-action]');
    const graphTab = event.target.closest('[data-graph]');

    const quizDel = event.target.closest('[data-quiz-del]');
    if (quizDel) {
      event.stopPropagation();
      if (!confirm('删除这次考试记录？')) return;
      await call('delete_exam', { examId: Number(quizDel.dataset.quizDel) });
      toast('已删除', 'ok');
      await refresh();
      return;
    }
    const quizOpen = event.target.closest('[data-quiz-open]');
    if (quizOpen) {
      const quiz = quizState();
      quiz.exam = { id: Number(quizOpen.dataset.quizOpen) };
      quiz.view = 'result';
      await renderQuiz();
      return;
    }
    const paperRerender = () => {
      if (state.view === 'exam') { renderExamMain(); renderExamSide(); }
      else { renderQuizMain(); renderQuizSide(); }
    };
    if (event.target.closest('[data-quiz-again]')) {
      const machine = state.view === 'exam' ? practiceState() : quizState();
      machine.exam = null;
      machine.items = [];
      machine.answers = {};
      machine.view = 'setup';
      machine.progress = '';
      machine.located = false;
      paperRerender();
      return;
    }
    if (event.target.closest('[data-quiz-review]')) {
      const machine = state.view === 'exam' ? practiceState() : quizState();
      machine.view = 'paper';
      paperRerender();
      return;
    }
    const learnTodo = event.target.closest('[data-learn-id]');
    if (learnTodo) {
      await openLearnUnit(Number(learnTodo.dataset.learnId));
      return;
    }
    if (row && !event.target.closest('button')) { loadExamCard(Number(row.dataset.card), row.dataset.mode); return; }
    if (learnRow) {
      const idx = (state.learnList || []).findIndex((c) => c.id === Number(learnRow.dataset.learn));
      if (idx >= 0) { state.learnIndex = idx; renderLearn(); }
      return;
    }
    if (materialAct) {
      const id = Number(materialAct.dataset.id);
      const act = materialAct.dataset.act;
      if (act === 'del') {
        if (!confirm('删除这份材料及其全部学习单元？')) return;
        await call('delete_material', { materialId: id });
        toast('已删除', 'ok');
        await refresh();
      } else if (act === 'rename') {
        state.renaming = id;
        renderShelf();
      } else if (act === 'polish') {
        state.importing = { label: '正在补考点…', source: '单元已切分，只差考点' };
        renderShelf();
        const result = await polishUnits(id);
        state.importing = null;
        toast(result.error
          ? '补考点失败：' + result.error
          : '已补 ' + result.polished + ' 份考点', result.error ? 'bad' : 'ok');
        await refresh();
      } else if (act === 'export') {
        await withBusy(materialAct, '导出中', async () => {
          const path = await call('export_material', { materialId: id });
          toast('已导出：' + path, 'ok');
          await call('reveal_path', { path: path });
        });
      }
      return;
    }
    if (graphTab) {
      state.graph = graphTab.dataset.graph;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === graphTab));
      renderGraph();
      return;
    }
    if (action) {
      const name = action.dataset.action;
      if (name === 'review-due' || name === 'learn-first') {
        const first = name === 'review-due' ? (state.queue.due || [])[0] : (state.queue.fresh || [])[0];
        if (first) loadExamCard(first.id, 'exam');
      } else if (name === 'learn-scheduled') {
        const first = (state.queue.scheduled || [])[0];
        if (first) await openLearnUnit(first.id);
      } else if (name === 'go-import') {
        switchView('shelf');
        showShelfTab('import');
      } else if (name === 'go-insight') {
        switchView('insight');
      } else if (name === 'go-learn') {
        switchView('learn');
      } else if (name === 'go-review') {
        const first = (state.queue.due || [])[0];
        if (first) {
          loadExamCard(first.id, 'exam');
          return;
        }
        switchView('exam');
        state.examTab = 'practice';
        state.practiceMode = 'unit';
        showExamTab('practice');
      } else if (name === 'go-exam') {
        switchView('quiz');
      } else if (name === 'learn-next') {
        // 「只看已学」就在已学清单里翻页，平时跳过折叠区的已学单元
        const list = state.learnList || [];
        const after = list.slice(Math.max(0, state.learnIndex) + 1);
        const next = state.learnedOnly ? after[0] : after.find((card) => !card.learned);
        if (next) { state.learnIndex = list.indexOf(next); renderLearn(); }
      } else if (name === 'learn-full') {
        setReading(!state.reading);
      } else if (name === 'plan-study') {
        const planId = Number(action.dataset.id);
        const current = await call('plan_today', { planId: planId });
        const first = current && current.dayUnits.find((card) => !card.learned);
        state.learnedOnly = false;
        switchView('learn');
        if (first) {
          const at = (state.queue.fresh || []).findIndex((card) => card.id === first.id);
          if (at >= 0) state.learnIndex = at;
          renderLearn();
        }
      } else if (name === 'plan-delete') {
        await call('delete_plan', { planId: Number(action.dataset.id) });
        toast('计划已删除', 'ok');
        await refresh();
      } else if (name === 'learn-to-exam') {
        const id = Number(action.dataset.id);
        await call('mark_learned', { cardId: id, learned: true });
        await refresh();
        loadExamCard(id, 'exam');
      }
    }
  });

  const runSmartImport = (button) => withBusy(button, '导入中', async () => {
    const query = el('urlInput').value.trim();
    if (!query) { toast('先粘贴链接，或者写一个想学的主题', 'bad'); return; }
    state.importing = {
      label: query.startsWith('http') ? '正在抓取网页…' : '正在搜索资料…',
      source: query,
    };
    renderShelf();
    try {
      const item = await call('ingest_query', { text: query });
      el('urlInput').value = '';
      await importItem(item);
    } catch (error) {
      state.importing = null;
      renderShelf();
      toast('导入失败。如果这个站点需要代理，去「设置」页配置代理后重试。', 'bad');
    }
  });

  el('urlBtn').addEventListener('click', (event) => runSmartImport(event.currentTarget));
  el('urlInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runSmartImport(el('urlBtn')); }
  });

  el('textBtn').addEventListener('click', (event) => withBusy(event.currentTarget, '处理中', async () => {
    const body = el('textInput').value;
    const title = el('textTitle').value.trim() || '粘贴文本 ' + today();
    state.importing = { label: '正在切分学习单元…', source: title };
    renderShelf();
    try {
      const item = await call('ingest_text', { title: title, text: body });
      el('textInput').value = '';
      await importItem(item);
    } catch (error) {
      state.importing = null;
      renderShelf();
      toast('导入失败：' + String(error), 'bad');
    }
  }));

  const dropzone = el('dropzone');
  const fileInput = el('fileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    if (event.dataTransfer.files.length) handleFiles(event.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
  });

  el('learnQueue').addEventListener('click', (event) => {
    if (event.target.closest('[data-learned-fold]')) {
      state.learnedOpen = !state.learnedOpen;
      if (state.learnedOpen && !state.learned) loadLearned();
      renderLearn();
      return;
    }
    const header = event.target.closest('.unit-group-title');
    if (!header || !header.dataset.section) return;
    const name = header.dataset.section;
    const at = state.collapsed.indexOf(name);
    if (at >= 0) state.collapsed.splice(at, 1); else state.collapsed.push(name);
    renderLearn();
  });

  el('learnFilter').addEventListener('click', () => {
    state.learnedOnly = !state.learnedOnly;
    state.learnIndex = 0;
    if (state.learnedOnly && !state.learned) loadLearned();
    renderLearn();
  });

  el('learnMaterial').addEventListener('change', (event) => {
    state.learnMaterial = Number(event.target.value) || null;
    state.learnIndex = 0;
    renderLearn();
  });

  el('learnSearch').addEventListener('input', (event) => {
    state.learnQuery = event.target.value;
    state.learnIndex = 0;
    renderLearn();
  });

  // 划词翻译：正文里松开鼠标或键盘扩选后浮出「翻译」按钮
  el('learnCard').addEventListener('mouseup', showSelectActions);
  el('learnCard').addEventListener('keyup', (event) => {
    if (event.shiftKey || event.key === 'Shift') showSelectActions();
  });
  el('learnCard').addEventListener('mousedown', hideSelectActions);
  el('learnCard').addEventListener('scroll', () => { hideSelectActions(); closeTransPop(); });

  el('selectActions').addEventListener('mousedown', (event) => event.preventDefault());
  el('transTrigger').addEventListener('click', requestTranslation);
  el('askTrigger').addEventListener('click', openQaDrawer);
  el('transClose').addEventListener('click', closeTransPop);

  document.querySelectorAll('[data-qa-close]').forEach((node) => {
    node.addEventListener('click', closeQaDrawer);
  });
  el('qaSendBtn').addEventListener('click', () => {
    const input = el('qaInput');
    askQa(input.value);
    input.value = '';
  });
  el('qaInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const input = el('qaInput');
    askQa(input.value);
    input.value = '';
  });
  el('qaDeepBtn').addEventListener('click', () => {
    state.qa.deep = !state.qa.deep;
    renderQaFollowups();
    toast(state.qa.deep ? '已切到「认真想想」：会慢一些' : '已切回快速回答', 'ok');
  });
  el('qaFollowups').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-qa-ask]');
    if (chip) askQa(chip.dataset.qaAsk);
  });
  el('qaThread').addEventListener('click', (event) => {
    if (event.target.closest('[data-qa-retry]')) askQa(state.qa.failed);
  });
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#selectActions') || event.target.closest('#transPop')) return;
    hideSelectActions();
    closeTransPop();
  });

  el('gradeBtn').addEventListener('click', submitGrade);
  el('rateGrid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-rating]');
    if (button) submitSelfRating(Number(button.dataset.rating));
  });
  el('exportBtn').addEventListener('click', exportGraph);

  el('saveSettingsBtn').addEventListener('click', (event) =>
    withBusy(event.currentTarget, '保存中', () => saveSettings(false)));

  document.querySelectorAll('[data-drawer]').forEach((row) => {
    row.addEventListener('click', () => openSettingsDrawer(row.dataset.drawer, row.dataset.focus));
  });
  document.querySelectorAll('[data-drawer-close]').forEach((node) => {
    node.addEventListener('click', closeSettingsDrawer);
  });
  ['sApiBase', 'sApiKey', 'sModel', 'sProxyUrl', 'sNoProxy'].forEach((id) => {
    el(id).addEventListener('input', refreshSettingValues);
  });

  el('detectBtn').addEventListener('click', (event) =>
    withBusy(event.currentTarget, '检测中', detectProxy));

  document.querySelectorAll('[data-reveal]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = el(button.dataset.reveal);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      button.textContent = hidden ? '隐藏' : '显示';
    });
  });

  el('proxyMode').addEventListener('click', (event) => {
    const button = event.target.closest('.seg-item');
    if (button) setProxyMode(button.dataset.mode);
  });

  el('translateSeg').addEventListener('click', async (event) => {
    const button = event.target.closest('.seg-item');
    if (!button) return;
    const want = button.dataset.translate === 'on';
    try {
      const on = await call('set_translate', { enabled: want });
      state.info = Object.assign({}, state.info, { translate: on });
      if (state.settings) state.settings.translate = on;
      setSeg('#translateSeg', 'translate', on);
      if (!on) { hideSelectActions(); closeTransPop(); }
      toast(on ? '划词翻译已开启（每次翻译会消耗 token）' : '划词翻译已关闭', 'ok');
    } catch (error) {
      toast('设置失败：' + String(error), 'bad');
    }
  });

  el('qaSeg').addEventListener('click', async (event) => {
    const button = event.target.closest('.seg-item');
    if (!button) return;
    const want = button.dataset.qa === 'on';
    try {
      const on = await call('set_qa', { enabled: want });
      state.info = Object.assign({}, state.info, { qa: on });
      if (state.settings) state.settings.qa = on;
      setSeg('#qaSeg', 'qa', on);
      if (!on) closeQaDrawer();
      toast(on ? '划词问答已开启（每次提问会消耗 token）' : '划词问答已关闭', 'ok');
    } catch (error) {
      toast('设置失败：' + String(error), 'bad');
    }
  });

  el('notifySeg').addEventListener('click', async (event) => {
    const button = event.target.closest('.seg-item');
    if (!button) return;
    const want = button.dataset.notify === 'on';
    try {
      const on = await call('set_notify', { enabled: want });
      setSeg('#notifySeg', 'notify', on);
      toast(on ? '已开启学习提醒（每天一条）' : '已关闭学习提醒', 'ok');
    } catch (error) {
      toast('设置失败：' + String(error), 'bad');
    }
  });

  el('autostartSeg').addEventListener('click', async (event) => {
    const button = event.target.closest('.seg-item');
    if (!button) return;
    const want = button.dataset.auto === 'on';
    try {
      const on = await call('set_autostart', { enabled: want });
      setAutostartSeg(on);
      toast(on ? '已设为开机自启' : '已关闭开机自启', 'ok');
    } catch (error) {
      toast('设置失败：' + String(error), 'bad');
      await loadAutostart();
    }
  });

  el('testLlmBtn').addEventListener('click', (event) =>
    withBusy(event.currentTarget, '测试中', async () => {
      await saveSettings(true);
      showResult('llmResult', await call('test_llm'));
    }));

  el('testProxyBtn').addEventListener('click', (event) =>
    withBusy(event.currentTarget, '测试中', async () => {
      await saveSettings(true);
      showResult('proxyTestResult', await call('test_fetch', { url: 'https://www.google.com/' }));
    }));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const qaDrawer = el('qaDrawer');
      if (qaDrawer && !qaDrawer.hidden) { closeQaDrawer(); return; }
      const drawer = el('settingsDrawer');
      if (drawer && !drawer.hidden) { closeSettingsDrawer(); return; }
      hideSelectActions();
      closeTransPop();
      if (state.reading) { setReading(false); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (state.view === 'exam') {
        if (!el('unitWrap').hidden) submitGrade();
        else if (practiceState().view === 'paper') submitPractice();
      }
    }
  });
}

bind();

refresh().catch((error) => {
  el('todayFocus').innerHTML =
    '<div class="empty">初始化失败：' + escapeHtml(String(error)) + '</div>';
});

async function handleFiles(files) {
  const file = files[0];
  if (!file) return;
  state.importing = { label: '正在解析文件…', source: file.name };
  renderShelf();
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const item = await call('ingest_bytes', {
      name: file.name, bytes: Array.from(buffer),
    });
    await importItem(item);
  } catch (error) {
    state.importing = null;
    renderShelf();
    toast('导入失败：' + String(error), 'bad');
  }
}