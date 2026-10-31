/* ==========================================================================
   data.js · 伴元本地数据层（BANYUAN local store）
   --------------------------------------------------------------------------
   作用：把「领养资料 / 记忆 / 目标 / 计划 / 任务 / 复盘 / 成长 / 技能卡」
        落到浏览器 localStorage，刷新与重开都还在（对应 R01/R03/R04/R05 的持久化要求）。
   原则：
     1. 只有用户点「保存到我的记忆」才会写 memories（默认拒绝，不偷偷记）。
     2. 每条记录带 version / updatedAt，修改走 version 递增，方便日后接后端做 409 冲突。
     3. 本轮是本地演示：所有数据只在这台设备，不冒充云端。
   ========================================================================== */
window.STORE = (function () {
  'use strict';

  var KEY = 'banyuan.v1';
  var db = null;

  function now() { return new Date().toISOString(); }
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function blank() {
    return {
      v: 1,
      profile: null,
      habits: [],
      memories: [],
      goals: [],
      plans: [],
      tasks: [],
      reviews: [],
      growth: [],
      skills: [],
      events: [],
    };
  }

  /* ------------------------------ 读写 ------------------------------ */

  function load() {
    if (db) return db;
    try {
      var raw = window.localStorage.getItem(KEY);
      db = raw ? JSON.parse(raw) : blank();
      if (!db || typeof db !== 'object') db = blank();
      ['habits', 'memories', 'goals', 'plans', 'tasks', 'reviews', 'growth', 'skills', 'events'].forEach(function (k) {
        if (!Array.isArray(db[k])) db[k] = [];
      });
    } catch (e) {
      db = blank();
    }
    return db;
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      return false;
    }
  }

  function list(name) { return load()[name] || []; }

  function find(name, id) {
    var arr = list(name);
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function add(name, obj) {
    var d = load();
    var item = Object.assign({ id: uid(name.slice(0, 2)), createdAt: now(), updatedAt: now(), version: 1 }, obj);
    d[name].unshift(item);
    save();
    return item;
  }

  function patch(name, id, changes) {
    var d = load();
    var it = find(name, id);
    if (!it) return null;
    Object.assign(it, changes, {
      updatedAt: now(),
      version: (it.version || 1) + (changes && changes.silent ? 0 : 1),
    });
    if (changes && changes.silent) delete it.silent;
    save();
    return it;
  }

  function remove(name, id) {
    var d = load();
    var idx = d[name].findIndex(function (x) { return x.id === id; });
    if (idx < -1) return false;
    if (idx === -1) return false;
    d[name].splice(idx, 1);
    save();
    return true;
  }

  function logEvent(type, payload) {
    var d = load();
    d.events.unshift({ id: uid('ev'), type: type, payload: payload || {}, at: now() });
    if (d.events.length > 200) d.events.length = 200;
    save();
  }

  /* ------------------------------ 话题模板 ------------------------------ */
  /* 用户可新建 / 删除 / 调序；未改动过时读 MOCK.topics 内置的 12 条 */

  var TOPIC_KEY = 'banyuan.topics.v1';

  function defaultTopics() {
    var base = (window.MOCK && window.MOCK.topics) || [];
    return clone(base);
  }

  function topics() {
    try {
      var raw = window.localStorage.getItem(TOPIC_KEY);
      if (!raw) return defaultTopics();
      var v = JSON.parse(raw);
      /* 允许用户把分组全删光，所以只要结构合法就照用，不再回退默认 */
      if (v && Array.isArray(v.groups)) return v.groups;
      return defaultTopics();
    } catch (e) {
      return defaultTopics();
    }
  }

  function saveTopics(groups) {
    try {
      window.localStorage.setItem(TOPIC_KEY, JSON.stringify({ v: 1, groups: groups }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function resetTopics() {
    try { window.localStorage.removeItem(TOPIC_KEY); } catch (e) {}
    return defaultTopics();
  }

  /* ------------------------------ 领养 ------------------------------ */

  var LOOKS = {
    classic: { name: '经典蓝', color: '#4C86E8', file: 'assets/dingdang.svg' },
    moon: { name: '月光银', color: '#8FA6BC', file: 'assets/dingdang.svg' },
    ember: { name: '暖橘', color: '#E09A55', file: 'assets/dingdang.svg' },
  };

  function profile() { return load().profile; }
  function isAdopted() { return !!load().profile; }

  function adopt(data) {
    var d = load();
    var p = {
      ownerName: String(data.ownerName || '').trim().slice(0, 12) || '主人',
      petName: String(data.petName || '').trim().slice(0, 8) || '叮当',
      look: LOOKS[data.look] ? data.look : 'classic',
      adoptedAt: now(),
      sloganAccepted: true,
    };
    d.profile = p;
    save();
    logEvent('adopt', { petName: p.petName, look: p.look });
    if (!d.goals.length && !d.memories.length) seedContent();
    return p;
  }

  function reset() {
    db = blank();
    try { window.localStorage.removeItem(KEY); } catch (e) {}
    save();
  }

  /* ------------------------------ 记忆 ------------------------------ */

  var CATEGORIES = ['全部', '方向', '偏好', '生活', '健康', '工作'];

  function memories(filter, q) {
    var kw = String(q || '').trim();
    return list('memories').filter(function (m) {
      if (m.status === 'deleted') return false;
      if (filter && filter !== '全部' && m.category !== filter) return false;
      if (kw && (m.title + m.content).indexOf(kw) === -1) return false;
      return true;
    });
  }

  /* 中文按 2 字切片 + 英文按词，做最朴素的相关性召回（无向量服务也能用） */
  function tokens(text) {
    var s = String(text || '');
    var out = [];
    var latin = s.match(/[A-Za-z][A-Za-z0-9+\-]{1,}/g) || [];
    latin.forEach(function (w) { out.push(w.toLowerCase()); });
    var cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
    cjk.split(' ').forEach(function (seg) {
      for (var i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    });
    return out;
  }

  function recall(text, limit) {
    var toks = tokens(text);
    if (!toks.length) return [];
    var scored = list('memories').filter(function (m) {
      return m.status === 'active' || m.status === 'confirmed';
    }).map(function (m) {
      var hay = tokens(m.title + ' ' + m.content + ' ' + (m.category || ''));
      var hit = 0;
      toks.forEach(function (t) {
        if (hay.indexOf(t) > -1) hit += 1;
      });
      return { m: m, score: hit };
    }).filter(function (x) { return x.score >= 2; });

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3).map(function (x) { return x.m; });
  }

  /* 从一句话里提炼「是否值得提议保存」以及标题/分类 */
  function propose(text) {
    var s = String(text || '').trim();
    if (s.length < 8) return null;
    if (/\b(密码|身份证|银行卡|验证码|护照号)\b/.test(s)) return null;

    var rules = [
      { re: /(我想|我要|我打算|计划|目标|想提升|想改善)/, cat: '方向' },
      { re: /(住|搬到|家在|通勤|城市)/, cat: '生活' },
      { re: /(睡|作息|健康|运动|跑步|焦虑|情绪|压力)/, cat: '健康' },
      { re: /(工作|项目|客户|销售|团队|老板|同事)/, cat: '工作' },
      { re: /(喜欢|不喜欢|习惯|偏好|讨厌|希望你)/, cat: '偏好' },
    ];
    var cat = '';
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].re.test(s)) { cat = rules[i].cat; break; }
    }
    if (!cat) return null;

    var title = s.replace(/^我(想|要|打算)/, '').replace(/[。！？!?].*$/, '').slice(0, 18);
    if (!title) title = s.slice(0, 18);
    return {
      title: title,
      content: s.slice(0, 120),
      category: cat,
      sourceType: 'chat',
      sourceId: null,
    };
  }

  /* ------------------------------ 习惯（记忆智能体） ------------------------------ */
  /* 记忆智能体只做两件事：从对话里认出习惯、允许你手动加一条。
     识别结果默认只是候选，你点了「存进习惯」才写 habits。 */

  var HABIT_CUES = /(每天|每周|每次|每晚|每早|睡前|早上|晚上|早起|起床|下班|通勤|周末|工作日|总是|经常|通常|习惯|喜欢|一到|都会|就会)/;
  var HABIT_TIME_WORDS = /(每天|每周|每晚|每早|每次|睡前|早起|起床|下班|通勤|周末|工作日|早上|晚上|午后|中午)/g;
  var HABIT_SCENES = [
    { re: /(睡前|晚上|夜里|深夜|入睡|晚安)/, scene: '睡前' },
    { re: /(早起|早上|起床|晨|早饭|一早)/, scene: '早起' },
    { re: /(通勤|上班路上|下班|地铁|公交|骑车)/, scene: '通勤' },
    { re: /(午后|中午|午饭|午休)/, scene: '午后' },
    { re: /(周末|周六|周日|休息日)/, scene: '周末' },
    { re: /(工作日|上班|开会|工位|办公)/, scene: '工作日' },
  ];

  function sceneOf(s) {
    /* 「地铁 / 公交 / 通勤」比「早上」更能说明这个习惯挂在哪 */
    if (/(通勤|地铁|公交|班车|上下班)/.test(s)) return '通勤';
    for (var i = 0; i < HABIT_SCENES.length; i++) {
      if (HABIT_SCENES[i].re.test(s)) return HABIT_SCENES[i].scene;
    }
    return '';
  }

  function freqOf(s) {
    if (/(每天|每日|每晚|每早)/.test(s)) return '每天';
    var m = s.match(/每周[一二三四五六日天]?\s*([0-9一二两三四五六七]+)\s*次/);
    if (m) return '每周' + m[1] + '次';
    if (/每周/.test(s)) return '每周几次';
    if (/(偶尔|有时候|有时|间或)/.test(s)) return '偶尔';
    if (/(每次|一到|总是|经常|通常|习惯)/.test(s)) return '经常';
    return '';
  }

  function nameOf(s) {
    var n = String(s)
      .replace(/^我\s*/, '')
      .replace(/([一二两三四五六七]|[0-9]+)\s*次/g, '')
      .replace(HABIT_TIME_WORDS, '')
      .replace(/(都要|都|要|就|总是|经常|通常|习惯|喜欢|一到|就会|都会)/g, '')
      .replace(/[，,、\s]/g, '');
    n = n.slice(0, 18);
    return n.length >= 2 ? n : '';
  }

  function confidenceOf(s, freq, scene) {
    var c = 0.5;
    if (/每天|每周|偶尔/.test(freq)) c += 0.2;
    if (scene) c += 0.1;
    if (/(习惯|总是|经常|通常|一到)/.test(s)) c += 0.1;
    return Math.min(0.9, Math.max(0.4, Math.round(c * 10) / 10));
  }

  /* 从一段话里认出可能的习惯，返回候选数组（不去重也写库） */
  function extractHabits(text) {
    var s = String(text || '').trim();
    if (s.length < 6) return [];
    if (/(密码|身份证|银行卡|验证码|护照号)/.test(s)) return [];

    var out = [];
    var sentences = s.split(/[。！？!?；;\n]/);
    sentences.forEach(function (sent) {
      if (!HABIT_CUES.test(sent)) return;
      var scene = sceneOf(sent);
      var freq = freqOf(sent);
      var name = nameOf(sent);
      if (!name) return;
      for (var i = 0; i < out.length; i++) if (out[i].name === name) return;
      out.push({
        name: name,
        scene: scene || '随时',
        frequency: freq || '经常',
        confidence: confidenceOf(sent, freq, scene),
        sourceText: sent.trim().slice(0, 60),
      });
    });
    return out.slice(0, 3);
  }

  function habits() { return list('habits'); }

  function addHabit(h) {
    var item = add('habits', {
      name: String(h.name || '').trim().slice(0, 18) || '一个习惯',
      scene: String(h.scene || '').trim().slice(0, 8) || '随时',
      frequency: String(h.frequency || '').trim().slice(0, 10) || '经常',
      source: h.source === 'manual' ? 'manual' : 'chat',
      confidence: typeof h.confidence === 'number' ? h.confidence : 0.6,
    });
    logEvent('habit_add', { name: item.name, source: item.source });
    return item;
  }

  function patchHabit(id, changes) {
    return patch('habits', id, changes);
  }

  function removeHabit(id) {
    return remove('habits', id);
  }

  /* ------------------------------ 目标 / 任务 ------------------------------ */

  function openGoals() {
    return list('goals').filter(function (g) { return g.status === 'active' || g.status === 'draft' || g.status === 'paused'; });
  }

  function goalProgress(goalId) {
    var ts = tasksOf(goalId);
    var done = ts.filter(function (t) { return t.status === 'done'; }).length;
    return { total: ts.length, done: done, pct: ts.length ? Math.round((done / ts.length) * 100) : 0 };
  }

  function tasksOf(goalId) {
    return list('tasks').filter(function (t) { return t.goalId === goalId; });
  }

  function todayTasks() {
    return list('tasks').filter(function (t) {
      return t.status === 'todo' || t.status === 'doing';
    });
  }

  function setTaskStatus(id, status) {
    var t = find('tasks', id);
    if (!t) return null;
    var from = t.status;
    var allowed = {
      todo: ['doing', 'done', 'canceled'],
      doing: ['done', 'todo', 'canceled'],
      done: ['todo', 'archived'],
      canceled: ['todo', 'archived'],
      archived: ['todo'],
    }[from] || [];
    if (allowed.indexOf(status) === -1) return null;
    patch('tasks', id, { status: status });
    logEvent('task_status', { taskId: id, from: from, to: status });
    return find('tasks', id);
  }

  /* ------------------------------ 成长 ------------------------------ */

  function growthStats() {
    var g = list('growth');
    var userCount = list('tasks').filter(function (t) { return t.status === 'done'; }).length;
    var petSkills = list('skills').length;
    var confirmed = list('reviews').filter(function (r) { return r.status === 'confirmed'; }).length;
    return {
      userTasks: userCount,
      reviews: confirmed,
      petSkills: petSkills,
      userPoints: userCount + confirmed,
      petPoints: petSkills + g.filter(function (x) { return x.subject === 'pet'; }).length,
    };
  }

  function confirmReview(id) {
    var r = find('reviews', id);
    if (!r || r.status === 'confirmed') return null;
    patch('reviews', id, { status: 'confirmed' });
    add('growth', {
      subject: 'user',
      type: 'review',
      summary: r.period + ' · ' + (r.factual || '').slice(0, 40),
      sourceRef: id,
    });
    logEvent('review_confirm', { reviewId: id });
    return find('reviews', id);
  }

  /* ------------------------------ 演示种子 ------------------------------ */

  function seedContent() {
    var d = load();
    var t = now();

    d.memories = [
      { id: 'm_1', title: '三个月内提升销售能力', content: '我想在三个月内提升销售能力，能独立谈下 3 单。', category: '方向', sourceType: 'chat', status: 'active', version: 2, confirmedAt: t, createdAt: t, updatedAt: t },
      { id: 'm_2', title: '喜欢直接给建议', content: '喜欢被直接给建议，不要绕圈子，也不用先安慰我很久。', category: '偏好', sourceType: 'chat', status: 'active', version: 1, confirmedAt: t, createdAt: t, updatedAt: t },
      { id: 'm_3', title: '工作日骑车通勤', content: '住在杭州滨江，工作日骑车通勤，单程 25 分钟。', category: '生活', sourceType: 'chat', status: 'active', version: 1, confirmedAt: t, createdAt: t, updatedAt: t },
      { id: 'm_4', title: '睡不好容易焦虑', content: '晚上 11 点前尽量睡；睡不好第二天容易焦虑，那时候先别安排太多事。', category: '健康', sourceType: 'chat', status: 'active', version: 1, confirmedAt: t, createdAt: t, updatedAt: t },
      { id: 'm_5', title: '负责新产品的用户增长', content: '在做一个新产品，负责用户增长，向产品负责人汇报。', category: '工作', sourceType: 'chat', status: 'active', version: 1, confirmedAt: t, createdAt: t, updatedAt: t },
    ];

    d.habits = [
      { id: 'h_1', name: '刷会儿手机', scene: '睡前', frequency: '每天', source: 'chat', confidence: 0.8, version: 1, createdAt: t, updatedAt: t },
      { id: 'h_2', name: '骑车通勤', scene: '通勤', frequency: '每天', source: 'chat', confidence: 0.8, version: 1, createdAt: t, updatedAt: t },
      { id: 'h_3', name: '先喝一杯温水', scene: '早起', frequency: '每天', source: 'manual', confidence: 0.7, version: 1, createdAt: t, updatedAt: t },
    ];

    d.goals = [
      { id: 'g_1', title: '三个月提升销售能力', description: '从会讲产品到能独立谈单', metric: '独立成单 3 单', dueDate: '2026-12-31', priority: 'high', status: 'active', version: 1, createdAt: t, updatedAt: t },
      { id: 'g_2', title: '30 天改善工作效率', description: '每天先做完 3 件关键事', metric: '连续 20 天做到 3 件关键任务', dueDate: '2026-11-20', priority: 'medium', status: 'active', version: 1, createdAt: t, updatedAt: t },
      { id: 'g_3', title: '每周跑满 15 公里', description: '先把频率稳住，再谈配速', metric: '连续 4 周达标', dueDate: '2026-12-01', priority: 'low', status: 'paused', version: 1, createdAt: t, updatedAt: t },
    ];

    d.plans = [
      { id: 'p_1', goalId: 'g_1', version: 1, status: 'active', steps: [
        { id: 's1', text: '拆出 3 个典型客户场景，每个写一段 90 秒讲法', done: true },
        { id: 's2', text: '每周和同事做 1 次角色扮演，录像回看', done: false },
        { id: 's3', text: '把成单复盘写进成长日记，提炼可复用话术', done: false },
      ] },
      { id: 'p_2', goalId: 'g_2', version: 1, status: 'active', steps: [
        { id: 's1', text: '每天开工前写下 3 件关键任务', done: true },
        { id: 's2', text: '晚上用 5 分钟记录实际完成情况', done: false },
      ] },
    ];

    d.tasks = [
      { id: 't_1', goalId: 'g_1', title: '写第 1 个客户场景讲法', note: '针对第一次见面的中小客户', dueAt: '2026-10-31', priority: 'high', status: 'doing', version: 1, createdAt: t, updatedAt: t },
      { id: 't_2', goalId: 'g_1', title: '约同事做一次角色扮演', note: '30 分钟，录下来回看', dueAt: '2026-11-02', priority: 'medium', status: 'todo', version: 1, createdAt: t, updatedAt: t },
      { id: 't_3', goalId: 'g_2', title: '今天先写 3 件关键任务', note: '', dueAt: '2026-10-31', priority: 'high', status: 'todo', version: 1, createdAt: t, updatedAt: t },
      { id: 't_4', goalId: 'g_2', title: '关掉 2 个不必要的通知群', note: '减少打断', dueAt: '2026-10-31', priority: 'low', status: 'done', evidence: '已经退出 2 个群', version: 1, createdAt: t, updatedAt: t },
      { id: 't_5', goalId: 'g_3', title: '周三晚慢跑 5 公里', note: '不追配速', dueAt: '2026-10-29', priority: 'low', status: 'done', evidence: '5.2 公里，34 分钟', version: 1, createdAt: t, updatedAt: t },
      { id: 't_6', goalId: 'g_3', title: '周六早上跑 6 公里', note: '', dueAt: '2026-11-01', priority: 'low', status: 'canceled', version: 1, createdAt: t, updatedAt: t },
      { id: 't_7', goalId: 'g_1', title: '整理 3 条客户常见异议', note: '价格、效果、售后', dueAt: '2026-11-05', priority: 'medium', status: 'todo', version: 1, createdAt: t, updatedAt: t },
    ];

    d.reviews = [
      { id: 'r_1', taskId: 't_4', goalId: 'g_2', period: '2026-10-30', factual: '关掉了 2 个通知群，上午专注时间从 40 分钟变到 70 分钟。', reflection: '打断少了，但下午还是会被临时会议切碎。', aiSuggestions: '可以把下午 14:00-15:00 设成不可预约时段。', status: 'draft', version: 1, createdAt: t, updatedAt: t },
      { id: 'r_2', taskId: 't_5', goalId: 'g_3', period: '2026-10-29', factual: '慢跑 5.2 公里，用时 34 分钟，中途没有停。', reflection: '不追配速反而更容易出门。', aiSuggestions: '保持周中一次、周末一次的节奏。', status: 'confirmed', version: 1, createdAt: t, updatedAt: t },
      { id: 'r_3', taskId: null, goalId: 'g_1', period: '2026-10-28', factual: '这周和 2 位客户聊过，但还没谈到报价。', reflection: '我总想等准备得更好再开口。', aiSuggestions: '下一步先练「报价前的 3 个铺垫句」。', status: 'confirmed', version: 1, createdAt: t, updatedAt: t },
    ];

    d.growth = [
      { id: 'gr_1', subject: 'user', type: 'review', summary: '10-29 · 慢跑 5.2 公里，找到不追配速的节奏', sourceRef: 'r_2', createdAt: t },
      { id: 'gr_2', subject: 'user', type: 'review', summary: '10-28 · 承认自己「等准备好」的惯性', sourceRef: 'r_3', createdAt: t },
      { id: 'gr_3', subject: 'pet', type: 'skill', summary: '沉淀方法卡：专注时段保护法', sourceRef: 'sk_1', createdAt: t },
    ];

    d.skills = [
      { id: 'sk_1', title: '专注时段保护法', context: '容易被消息和临时会议打断的日子', preconditions: '有权限调整日历；愿意提前告知同事', steps: '1) 每天只设 1 段 60 分钟不可预约\n2) 关掉非必要通知群\n3) 结束后再统一回消息', risks: '对外岗位需要保留紧急通道，不要一刀切', validationStatus: 'verified', version: 2, shareScope: 'private', sourceRef: 'r_1', createdAt: t, updatedAt: t },
      { id: 'sk_2', title: '报价前的 3 个铺垫句', context: '第一次谈报价前', preconditions: '已确认客户的核心诉求', steps: '1) 先复述对方目标\n2) 说明判断依据\n3) 给出两个档位再报价', risks: '客户预算极紧时容易显得套路，需要放慢', validationStatus: 'candidate', version: 1, shareScope: 'private', sourceRef: 'r_3', createdAt: t, updatedAt: t },
    ];

    d.events = [
      { id: 'ev_1', type: 'seed', payload: { note: '演示数据' }, at: t },
    ];

    save();
  }

  return {
    KEY: KEY,
    LOOKS: LOOKS,
    CATEGORIES: CATEGORIES,
    load: load,
    save: save,
    list: list,
    find: find,
    add: add,
    patch: patch,
    remove: remove,
    logEvent: logEvent,
    topics: topics,
    saveTopics: saveTopics,
    resetTopics: resetTopics,
    profile: profile,
    isAdopted: isAdopted,
    adopt: adopt,
    reset: reset,
    memories: memories,
    recall: recall,
    propose: propose,
    habits: habits,
    addHabit: addHabit,
    patchHabit: patchHabit,
    removeHabit: removeHabit,
    extractHabits: extractHabits,
    openGoals: openGoals,
    goalProgress: goalProgress,
    tasksOf: tasksOf,
    todayTasks: todayTasks,
    setTaskStatus: setTaskStatus,
    growthStats: growthStats,
    confirmReview: confirmReview,
    seedContent: seedContent,
    clone: clone,
  };
})();
