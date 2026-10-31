/* ==========================================================================
   app.js · 「叮当 · 温暖陪伴」视图与交互层
   --------------------------------------------------------------------------
   结构：state（状态）/ render（渲染）/ stream（流式与打字机）/ 事件绑定
   数据来源只有 MOCK（会话、话题、话术）与 API（模型接入），不散落硬编码
   ========================================================================== */
(function () {
  'use strict';

  /* ============================ 0. 基础工具 ============================ */

  const $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function nowTime() {
    try {
      return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
      return '--:--';
    }
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /* 显示用的伴元名字（领养时填的，默认叮当） */
  function petName() {
    const p = (window.STORE && STORE.profile) ? STORE.profile() : null;
    return (p && p.petName) || '叮当';
  }

  const STORE_KEY = 'dingdang.config.v1';

  function defaultConfig() {
    const p = API.provider('deepseek');
    return {
      provider: 'deepseek',
      base: p.base,
      model: p.models[0],
      key: '',
      temp: 0.7,
      enabled: false,
      verified: false,
    };
  }

  function loadConfig() {
    const def = defaultConfig();
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return def;
      const saved = JSON.parse(raw);
      const temp = Number(saved.temp);
      return {
        provider: saved.provider || def.provider,
        base: typeof saved.base === 'string' ? saved.base : def.base,
        model: saved.model || def.model,
        key: saved.key || '',
        temp: (saved.temp === undefined || saved.temp === null || isNaN(temp)) ? def.temp : Math.min(1, Math.max(0, temp)),
        enabled: !!saved.enabled,
        verified: !!saved.verified,
      };
    } catch (e) {
      return def;
    }
  }

  /* ============================ 1. 状态 ============================ */

  const state = {
    sessions: [],
    activeId: null,
    sending: false,
    config: defaultConfig(),
    drawer: { left: false, right: false },
    sheet: false,
    memSheet: false,
    search: '',
    pendingVerified: false,
    /* 伴元新增 */
    view: 'chat',
    pet: 'listening',
    memFilter: '全部',
    memQuery: '',
    goalPane: 'direction',
    openTasks: {},
    modal: null,
    topicEdit: false,
    /* 记忆智能体 */
    habitChat: [],
    habitCand: [],
    habitOthers: false,
  };

  const PET_LABELS = {
    listening: '在线倾听中',
    thinking: '正在想…',
    responding: '正在回你',
    celebrating: '替你高兴',
    error: '刚刚走神了',
    offline: '离线演示',
    idle: '在的',
  };

  const LOOK_FILTERS = {
    classic: 'none',
    moon: 'saturate(0.28) brightness(1.06)',
    ember: 'hue-rotate(-18deg) saturate(1.3) brightness(1.03)',
  };

  function petLabel() {
    const base = PET_LABELS[state.pet] || PET_LABELS.listening;
    return base + (liveConfig() ? '' : ' · 演示');
  }

  function setPet(next) {
    state.pet = next;
    const dot = $('statusDot');
    const text = $('statusText');
    if (dot) dot.className = 'status-dot' + (next === 'listening' ? '' : ' is-' + next);
    if (text) text.textContent = petLabel();
  }

  function celebrate() {
    setPet('celebrating');
    window.setTimeout(function () {
      if (state.pet === 'celebrating') setPet('listening');
    }, 1800);
  }

  function currentSession() {
    for (let i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.activeId) return state.sessions[i];
    }
    return state.sessions[0];
  }

  function liveConfig() {
    const c = state.config;
    if (!c.enabled || !c.key || !c.base || !c.model) return null;
    return c;
  }

  /* ============================ 2. 富文本 / 代码高亮 ============================ */

  function highlight(code) {
    const re = /('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(\b(const|let|var|function|return|if|else|for|while|of|in|new|class|async|await|try|catch|finally|import|from|export|default|true|false|null|undefined|this|def|print|True|False|None)\b)|(\b\d+(?:\.\d+)?\b)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      const cls = m[1] ? 's' : m[2] ? 'c' : m[3] ? 'k' : 'n';
      out += '<span class="t-' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  function inline(text) {
    let s = esc(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+?)`/g, '<code class="md-code">$1</code>');
    return s;
  }

  function renderBlocks(blocks, withCaret) {
    if (!blocks || !blocks.length) return withCaret ? '<span class="caret"></span>' : '';
    const lastIndex = blocks.length - 1;
    return blocks.map(function (b, i) {
      const caret = (withCaret && i === lastIndex) ? '<span class="caret"></span>' : '';
      if (b.t === 'ul') {
        return '<ul>' + (b.items || []).map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</ul>' + caret;
      }
      if (b.t === 'code') {
        return '<div class="code-block">' +
          '<div class="code-head"><span>' + esc(b.lang || 'code') + '</span>' +
          '<button class="copy-btn" type="button">复制</button></div>' +
          '<pre><code>' + (highlight(b.code || '') || '&nbsp;') + caret + '</code></pre>' +
          '</div>';
      }
      if (b.t === 'quote') return '<div class="md-quote">' + inline(b.text || '') + caret + '</div>';
      return '<p>' + inline(b.text || '') + caret + '</p>';
    }).join('');
  }

  /* 真实模型的 markdown 输出 → blocks（与 mock 结构统一，便于同样的渲染器） */
  function parseMarkdown(raw) {
    const blocks = [];
    function pushText(seg) {
      if (!seg) return;
      const parts = seg.split(/\n{2,}/);
      parts.forEach(function (part) {
        const lines = part.split('\n').filter(function (l) { return l.trim() !== ''; });
        if (!lines.length) return;
        const isList = lines.every(function (l) { return /^\s*([-*]|\d+\.)\s+/.test(l); });
        if (isList) {
          blocks.push({
            t: 'ul',
            items: lines.map(function (l) { return l.replace(/^\s*([-*]|\d+\.)\s+/, ''); }),
          });
        } else if (/^>\s/.test(lines[0])) {
          blocks.push({ t: 'quote', text: lines.map(function (l) { return l.replace(/^\s*>\s?/, ''); }).join(' ') });
        } else {
          blocks.push({ t: 'p', text: lines.join(' ') });
        }
      });
    }
    const re = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      pushText(raw.slice(last, m.index));
      blocks.push({ t: 'code', lang: m[1] || 'text', code: m[2].replace(/\n$/, '') });
      last = re.lastIndex;
    }
    pushText(raw.slice(last));
    if (!blocks.length) blocks.push({ t: 'p', text: raw });
    return blocks;
  }

  /* ============================ 3. 渲染：聊天区 ============================ */

  const chatList = function () { return $('chatList'); };

  function scrollBottom(smooth) {
    const box = $('chatScroll');
    if (!box) return;
    const apply = function () { box.scrollTop = box.scrollHeight; };
    if (smooth) apply();
    else window.requestAnimationFrame(apply);
  }

  function msgHTML(m, index) {
    const delay = 'style="animation-delay:' + Math.min(index, 8) * 40 + 'ms"';
    if (m.role === 'proposal') return proposalHTML(m, delay);
    if (m.role === 'user') {
      return '<div class="msg msg-user" ' + delay + '>' +
        '<div class="bubble-wrap"><div class="bubble bubble-user"><div class="md">' + renderBlocks(m.blocks) + '</div></div>' +
        '<span class="msg-time">' + esc(m.time) + '</span></div></div>';
    }
    return '<div class="msg msg-bot" ' + delay + '>' +
      '<div class="msg-avatar"><img src="assets/dingdang.svg" alt="' + esc(petName()) + '"></div>' +
      '<div class="msg-body"><div class="bubble bubble-bot"><div class="md">' + renderBlocks(m.blocks) + '</div></div>' +
      '<span class="msg-time">' + esc(petName()) + ' · ' + esc(m.time) + '</span></div></div>';
  }

  /* 聊天里的「这句话要不要记住」提议卡（默认拒绝，点了才写） */
  function proposalHTML(m, delay) {
    const p = m.proposal || {};
    const isHabit = m.kind === 'habit';
    let actions;
    if (m.status === 'saved') {
      actions = '<span class="proposal-state">' + icon('checkCircle', 13) + ' ' + (isHabit ? '已存进习惯' : '已存进记忆') + '</span>';
    } else if (m.status === 'skipped') {
      actions = '<span class="proposal-state">这次不保存</span>';
    } else {
      actions = '<div class="proposal-actions">' +
        '<button class="btn btn-xs is-primary" type="button" data-save-' + (isHabit ? 'habit' : 'memory') + '="' + esc(m.id) + '">' +
          (isHabit ? '存进习惯' : '保存到我的记忆') + '</button>' +
        '<button class="btn btn-xs is-quiet" type="button" data-skip-' + (isHabit ? 'habit' : 'memory') + '="' + esc(m.id) + '">这次不保存</button>' +
        '</div>';
    }
    const body = isHabit
      ? '<p class="proposal-text">场景 ' + esc(p.scene || '随时') + ' · 频率 ' + esc(p.frequency || '经常') +
        ' · 可信度 ' + Math.round(Number(p.confidence || 0) * 100) + '%</p>' +
        (p.sourceText ? '<p class="proposal-src">「' + esc(p.sourceText) + '」</p>' : '')
      : '<p class="proposal-text">' + esc(p.content || '') + '</p>';
    return '<div class="proposal" id="proposal_' + esc(m.id) + '" ' + delay + '>' +
      '<div class="proposal-card">' +
      '<p class="proposal-eyebrow">' + (isHabit ? 'BANYUAN · 习惯提议' : 'BANYUAN · 记忆提议') + '</p>' +
      '<p class="proposal-title">' + esc(p.title || p.name || '') + '</p>' +
      body +
      actions +
      '</div></div>';
  }

  function emptyStateHTML() {
    const chips = MOCK.quickTopics.map(function (t, i) {
      return '<button class="empty-chip" type="button" data-quick="' + i + '">' + esc(t.label) + '</button>';
    }).join('');
    return '<div class="empty-state">' +
      '<div class="empty-avatar"><img src="assets/dingdang.svg" alt="' + esc(petName()) + '"></div>' +
      '<h3 class="empty-title">我在，慢慢说</h3>' +
      '<p class="empty-sub">不用组织好语言。想聊什么都可以，也可以从下面挑一句开始。</p>' +
      '<div class="empty-chips">' + chips + '</div>' +
      '</div>';
  }

  function renderChat() {
    const sess = currentSession();
    const box = chatList();
    if (!sess) return;
    if (!sess.messages.length) {
      box.innerHTML = emptyStateHTML();
      return;
    }
    let html = '<div class="day-divider"><span>' + esc(sess.dateLabel || '今天') + '</span></div>';
    sess.messages.forEach(function (m, i) { html += msgHTML(m, i); });
    box.innerHTML = html;
    scrollBottom();
  }

  /* ============================ 4. 渲染：会话列表 / 话题 / 快捷 chip ============================ */

  function renderSessions() {
    const wrap = $('sessList');
    const kw = state.search.trim();
    const list = state.sessions.filter(function (s) {
      if (!kw) return true;
      return (s.title + s.summary).indexOf(kw) > -1;
    });

    if (!list.length) {
      wrap.innerHTML = '<div class="sess-empty">没有找到匹配的会话<br>换一个词，或者直接开一个新的</div>';
      return;
    }

    wrap.innerHTML = list.map(function (s) {
      const active = s.id === state.activeId ? ' is-active' : '';
      return '<button class="sess' + active + '" type="button" data-session="' + esc(s.id) + '">' +
        '<span class="sess-avatar"><img src="assets/dingdang.svg" alt=""></span>' +
        '<span class="sess-main">' +
        '<span class="sess-row"><span class="sess-title">' + esc(s.title) + '</span>' +
        '<span class="sess-time">' + esc(s.time) + '</span></span>' +
        '<span class="sess-sub"><span class="sess-dot"></span>' + esc(s.summary) + '</span>' +
        '</span></button>';
    }).join('');
  }

  /* 可选图标：新建开场白时从这里挑，保证不出现 emoji */
  const TOPIC_ICONS = ['heart', 'cloudRain', 'sun', 'moon', 'messageCircle', 'sparkles', 'home', 'droplet', 'briefcase', 'listChecks', 'alert', 'clock', 'book', 'flag'];

  function renderTopics() {
    const wrap = $('topicGroups');
    const groups = STORE.topics();
    const editing = state.topicEdit;

    if (!groups.length) {
      wrap.innerHTML = '<p class="topic-empty">还没有任何分组。' +
        (editing ? '点下面的「新建分组」加一个。' : '点右上角的笔，就能新建和调序。') +
        '</p>';
      return;
    }

    wrap.innerHTML = groups.map(function (group, gi) {
      const head = editing
        ? '<div class="topic-group-bar">' +
            '<p class="topic-group-label">' + esc(group.group) + '</p>' +
            '<span class="topic-acts">' +
              '<button class="topic-mini" type="button" data-move-group="' + gi + ':up" aria-label="这组上移">' + icon('arrowUp', 12) + '</button>' +
              '<button class="topic-mini" type="button" data-move-group="' + gi + ':down" aria-label="这组下移">' + icon('arrowDown', 12) + '</button>' +
              '<button class="topic-mini" type="button" data-add-item="' + gi + '" aria-label="往这组加一条">' + icon('plus', 12) + '</button>' +
              '<button class="topic-mini is-danger" type="button" data-del-group="' + gi + '" aria-label="删除这组">' + icon('trash', 12) + '</button>' +
            '</span>' +
          '</div>'
        : '<p class="topic-group-label">' + esc(group.group) + '</p>';

      const items = group.items.map(function (item, ii) {
        if (editing) {
          return '<div class="topic is-editing">' +
            '<span class="topic-icon">' + icon(item.icon, 15) + '</span>' +
            '<span class="topic-body"><span class="topic-title">' + esc(item.title) + '</span>' +
            '<span class="topic-sub">' + esc(item.sub) + '</span></span>' +
            '<span class="topic-acts">' +
              '<button class="topic-mini" type="button" data-move-item="' + gi + ':' + ii + ':up" aria-label="上移">' + icon('arrowUp', 12) + '</button>' +
              '<button class="topic-mini" type="button" data-move-item="' + gi + ':' + ii + ':down" aria-label="下移">' + icon('arrowDown', 12) + '</button>' +
              '<button class="topic-mini is-danger" type="button" data-del-item="' + gi + ':' + ii + '" aria-label="删除">' + icon('trash', 12) + '</button>' +
            '</span></div>';
        }
        return '<button class="topic" type="button" data-topic="' + gi + ':' + ii + '">' +
          '<span class="topic-icon">' + icon(item.icon, 15) + '</span>' +
          '<span class="topic-body"><span class="topic-title">' + esc(item.title) + '</span>' +
          '<span class="topic-sub">' + esc(item.sub) + '</span></span>' +
          '<span class="topic-go">' + icon('chevronRight', 14) + '</span>' +
          '</button>';
      }).join('');

      const empty = group.items.length ? '' : '<p class="topic-empty is-inline">这一组还空着，点 ＋ 加一条。</p>';
      return '<div class="topic-group">' + head + items + empty + '</div>';
    }).join('');
  }

  function topicByKey(key) {
    const parts = String(key).split(':');
    const groups = STORE.topics();
    const group = groups[Number(parts[0])];
    if (!group) return null;
    return group.items[Number(parts[1])] || null;
  }

  /* ---------------- 话题模板：编辑模式（新建 / 删除 / 上下调序） ---------------- */

  function syncTopicEditUI() {
    const on = state.topicEdit;
    const btn = $('btnEditTopics');
    btn.innerHTML = icon(on ? 'check' : 'edit', 16);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-label', on ? '退出编辑' : '编辑话题模板');
    $('topicTools').hidden = !on;
  }

  function toggleTopicEdit() {
    state.topicEdit = !state.topicEdit;
    syncTopicEditUI();
    renderTopics();
  }

  function moveTopicGroup(gi, dir) {
    const groups = STORE.topics();
    const to = gi + (dir === 'up' ? -1 : 1);
    if (to < 0 || to >= groups.length) return;
    const tmp = groups[gi];
    groups[gi] = groups[to];
    groups[to] = tmp;
    STORE.saveTopics(groups);
    renderTopics();
  }

  function moveTopicItem(gi, ii, dir) {
    const groups = STORE.topics();
    const items = groups[gi] && groups[gi].items;
    if (!items) return;
    const to = ii + (dir === 'up' ? -1 : 1);
    if (to < 0 || to >= items.length) return;
    const tmp = items[ii];
    items[ii] = items[to];
    items[to] = tmp;
    STORE.saveTopics(groups);
    renderTopics();
  }

  function deleteTopicItem(gi, ii) {
    const groups = STORE.topics();
    if (!groups[gi] || !groups[gi].items[ii]) return;
    groups[gi].items.splice(ii, 1);
    STORE.saveTopics(groups);
    renderTopics();
    toast('已删除这条开场白');
  }

  function deleteTopicGroup(gi) {
    const groups = STORE.topics();
    const g = groups[gi];
    if (!g) return;
    openModal({
      title: '删除分组「' + g.group + '」？',
      ok: '删除整组',
      danger: true,
      body: '<p class="page-note">组内 ' + g.items.length + ' 条开场白会一起删掉；不会影响你的记忆和目标。</p>' +
        '<p class="page-note">删错了可以点「恢复默认模板」找回来。</p>',
      onSubmit: function () {
        const cur = STORE.topics();
        cur.splice(gi, 1);
        STORE.saveTopics(cur);
        renderTopics();
        toast('分组已删除');
      },
    });
  }

  function addTopicGroup() {
    openModal({
      title: '新建分组',
      ok: '建好',
      body:
        '<div class="field"><label for="tpGroupName">分组名</label>' +
        '<input id="tpGroupName" class="input" maxlength="12" placeholder="例如：自我关怀"></div>' +
        '<p class="page-note">建好后用组头的 ＋ 往里加开场白，↑↓ 可以调整个分组的位置。</p>',
      onSubmit: function () {
        const name = $('tpGroupName').value.trim();
        if (!name) { toast('给分组起个名字'); return false; }
        const groups = STORE.topics();
        groups.push({ group: name, items: [] });
        STORE.saveTopics(groups);
        state.topicEdit = true;
        syncTopicEditUI();
        renderTopics();
        toast('分组已添加');
      },
    });
  }

  function addTopicItem(gi) {
    const groups = STORE.topics();
    const g = groups[gi];
    if (!g) return;
    openModal({
      title: '新建开场白 · ' + g.group,
      ok: '加进去',
      body:
        '<div class="field"><label for="tpTitle">标题</label>' +
        '<input id="tpTitle" class="input" maxlength="14" placeholder="例如：今天有点撑不住"></div>' +
        '<div class="field"><label for="tpSub">一句说明</label>' +
        '<input id="tpSub" class="input" maxlength="18" placeholder="例如：不用解释，先被听见"></div>' +
        '<div class="field"><label for="tpText">点下去会发出去的话</label>' +
        '<textarea id="tpText" class="input input-area" maxlength="90" placeholder="写一句你愿意开口说的话"></textarea></div>' +
        '<div class="field"><label for="tpIcon">图标</label>' +
        '<select id="tpIcon" class="input input-select">' +
        TOPIC_ICONS.map(function (n) { return '<option value="' + n + '">' + n + '</option>'; }).join('') +
        '</select></div>' +
        '<p class="page-note">模板只是一句开场，点了才会发送，不会自动存成记忆。</p>',
      onSubmit: function () {
        const title = $('tpTitle').value.trim();
        const sub = $('tpSub').value.trim();
        const text = $('tpText').value.trim();
        if (!title || !text) { toast('标题和那句话都要填'); return false; }
        const iconName = $('tpIcon').value;
        const cur = STORE.topics();
        if (!cur[gi]) return false;
        cur[gi].items.push({ icon: iconName, title: title, sub: sub || '点一下，就聊聊', text: text });
        STORE.saveTopics(cur);
        state.topicEdit = true;
        syncTopicEditUI();
        renderTopics();
        toast('已加进「' + cur[gi].group + '」');
      },
    });
  }

  function confirmResetTopics() {
    openModal({
      title: '恢复默认模板？',
      ok: '恢复默认',
      danger: true,
      body: '<p class="page-note">你自己新建的分组和开场白会被清掉，换回内置的 3 组 12 条。</p>',
      onSubmit: function () {
        STORE.resetTopics();
        state.topicEdit = false;
        syncTopicEditUI();
        renderTopics();
        toast('已恢复默认模板');
      },
    });
  }

  function renderQuickbar() {
    const bar = $('quickbar');
    bar.innerHTML = MOCK.quickTopics.map(function (t, i) {
      return '<button class="chip" type="button" data-quick="' + i + '">' +
        icon('sparkles', 12) + esc(t.label) + '</button>';
    }).join('') +
      '<button class="chip chip-all" type="button" id="chipAll">' + icon('panelRight', 12) + '话题模板</button>';
  }

  /* ============================ 5. 图标（内联 Lucide，离线可用） ============================ */

  const ICONS = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panelRight: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3.5v17"/>',
    settings: '<path d="M4 20v-6M4 10V4M12 20v-9M12 7V4M20 20v-5M20 11V4"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="20" cy="13" r="2"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-4.7"/>',
    alert: '<path d="M12 3.4l8.8 15.2H3.2z"/><path d="M12 9.4v4.2M12 16.4v.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.7 1.1-1a5.5 5.5 0 0 0 0-7.7z"/>',
    cloudRain: '<path d="M6 15.5a4 4 0 0 1 .6-7.96A6 6 0 0 1 18 9.5a3.7 3.7 0 0 1 .4 7.36"/><path d="M8 17.5v3M12 16.5v3M16 17.5v3"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    briefcase: '<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7M2.5 12.5h19"/>',
    listChecks: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M3 6l1.5 1.5L7 5"/><path d="M3 12l1.5 1.5L7 11"/><path d="M3 18l1.5 1.5L7 17"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    home: '<path d="M3.5 10.5L12 3.5l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-5.5h5V20"/>',
    droplet: '<path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
    messageCircle: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-1L3 21l1.9-5.6a8.4 8.4 0 0 1-1-4A8.4 8.4 0 0 1 12.4 3 8.4 8.4 0 0 1 21 11.5z"/>',
    sparkles: '<path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="M2 12s3.6-6.5 10-6.5c1.3 0 2.5.3 3.5.7M22 12s-3.6 6.5-10 6.5c-1.3 0-2.5-.3-3.5-.7"/><path d="M3.5 3.5l17 17"/>',
    zap: '<path d="M13 2L4 15h7l-1 7 9-13h-7l1-7z"/>',
    refresh: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.1"/>',
    trending: '<path d="M4 17l5-5 3.4 3L18 8"/><path d="M14.6 7.6H19v4.4"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V5.4a1.7 1.7 0 0 1 1.7-1.7h1.6a1.7 1.7 0 0 1 1.7 1.7V7"/><path d="M6.6 7l.8 12.1a1.8 1.8 0 0 0 1.8 1.7h5.6a1.8 1.8 0 0 0 1.8-1.7L17.4 7"/><path d="M10.6 11v5.4M13.4 11v5.4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L7.2 18.8 3 20l1.2-4.2z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.6"/><path d="M8 3.2v3.4M16 3.2v3.4M3.5 10h17"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4.6h10.4l-1.6 3.5 1.6 3.5H5"/>',
    book: '<path d="M4 5.2A2.2 2.2 0 0 1 6.2 3H20v15.6H6.2A2.2 2.2 0 0 0 4 20.8z"/><path d="M4 18.6V5.2"/>',
    layers: '<path d="M12 3.5l8.5 4.6L12 12.7 3.5 8.1z"/><path d="M3.5 12.4L12 17l8.5-4.6"/><path d="M3.5 16.6L12 21.2l8.5-4.6"/>',
  };

  function icon(name, size) {
    const s = size || 18;
    return '<svg class="ico" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  /* ============================ 6. 气泡流式 / 打字机 ============================ */

  function showTyping() {
    hideTyping();
    setPet('thinking');
    const el = document.createElement('div');
    el.className = 'msg msg-bot';
    el.id = 'typingMsg';
    el.innerHTML = '<div class="msg-avatar"><img src="assets/dingdang.svg" alt="' + esc(petName()) + '"></div>' +
      '<div class="msg-body"><div class="bubble bubble-bot bubble-typing">' +
      '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>' +
      '</div></div>';
    chatList().appendChild(el);
    scrollBottom();
  }

  function hideTyping() {
    const el = $('typingMsg');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function createStreamBubble() {
    setPet('responding');
    const el = document.createElement('div');
    el.className = 'msg msg-bot';
    el.id = 'streamMsg';
    el.innerHTML = '<div class="msg-avatar"><img src="assets/dingdang.svg" alt="' + esc(petName()) + '"></div>' +
      '<div class="msg-body"><div class="bubble bubble-bot"><div class="md"></div></div>' +
      '<span class="msg-time">' + esc(petName()) + ' · 正在输入…</span></div>';
    chatList().appendChild(el);
    scrollBottom();
    return el.querySelector('.md');
  }

  function removeStreamBubble() {
    const el = $('streamMsg');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function finishStreamBubble() {
    const el = $('streamMsg');
    if (!el) return;
    el.removeAttribute('id');
    const t = el.querySelector('.msg-time');
    if (t) t.textContent = petName() + ' · ' + nowTime();
    const md = el.querySelector('.md');
    if (md) {
      const caret = md.querySelector('.caret');
      if (caret) caret.remove();
    }
    setPet('listening');
  }

  async function typeInto(text, apply, paint, interval, step) {
    for (let i = 0; i < text.length; i += step) {
      apply(text.slice(i, i + step));
      paint();
      await sleep(interval);
    }
  }

  async function typeBlocks(mdEl, blocks) {
    const live = [];
    const paint = function () {
      mdEl.innerHTML = renderBlocks(live, true);
      scrollBottom();
    };
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.t === 'ul') {
        const target = { t: 'ul', items: [''] };
        live.push(target);
        const items = b.items || [];
        for (let j = 0; j < items.length; j++) {
          if (target.items[target.items.length - 1] !== '') target.items.push('');
          await typeInto(items[j], function (ch) {
            const k = target.items.length - 1;
            target.items[k] += ch;
          }, paint, 15, 2);
        }
      } else if (b.t === 'code') {
        const target = { t: 'code', lang: b.lang, code: '' };
        live.push(target);
        await typeInto(b.code || '', function (ch) { target.code += ch; }, paint, 11, 5);
      } else {
        const target = { t: b.t, text: '' };
        live.push(target);
        await typeInto(b.text || '', function (ch) { target.text += ch; }, paint, 15, 2);
      }
      paint();
      await sleep(70);
    }
  }

  /* ============================ 7. 发送与回复 ============================ */

  function refreshSend() {
    const input = $('input');
    const btn = $('btnSend');
    const has = input.value.trim().length > 0;
    btn.disabled = !has || state.sending;
    btn.title = state.sending ? petName() + '正在回复' : '发送';
  }

  function autosize() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 92) + 'px';
  }

  function animateSend() {
    const btn = $('btnSend');
    btn.classList.remove('is-flying');
    /* 强制重排，保证连续点击也能重放动画 */
    void btn.offsetWidth;
    btn.classList.add('is-flying');
    window.setTimeout(function () { btn.classList.remove('is-flying'); }, 520);
  }

  function commitBot(sess, blocks) {
    sess.messages.push({ role: 'bot', blocks: blocks, time: nowTime() });
    sess.summary = blocksFirstLine(blocks);
    sess.time = '刚刚';
    renderSessions();
  }

  function blocksFirstLine(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      let text = '';
      if (b.t === 'ul') text = (b.items || []).join('、');
      else if (b.t === 'code') text = '代码片段';
      else text = b.text || '';
      text = String(text).replace(/\*\*/g, '').replace(/`/g, '').trim();
      if (text) return text.length > 26 ? text.slice(0, 26) + '…' : text;
    }
    return petName() + '回了一句';
  }

  async function revealMockReply(sess, text) {
    await sleep(680 + Math.random() * 560);
    hideTyping();
    const blocks = MOCK.replyFor(text);
    const md = createStreamBubble();
    await typeBlocks(md, blocks);
    finishStreamBubble();
    commitBot(sess, blocks);
  }

  async function respondReal(sess, cfg, text) {
    /* 只召回用户确认过的记忆，作为背景注入，不逐条复述 */
    let sys = MOCK.systemPrompt;
    const memo = (window.STORE && STORE.isAdopted()) ? STORE.recall(text, 3) : [];
    if (memo.length) {
      sys += '\n\n【用户已同意保存的记忆，仅作背景参考，不要逐条复述】\n' +
        memo.map(function (m) { return '- [' + m.category + '] ' + m.title + '：' + m.content; }).join('\n');
    }

    const history = [{ role: 'system', content: sys }].concat(
      sess.messages.filter(function (m) { return m.role === 'user' || m.role === 'bot'; }).slice(-10).map(function (m) {
        return { role: m.role === 'user' ? 'user' : 'assistant', content: MOCK.blockToText(m.blocks) };
      })
    );

    let mdEl = null;
    let raw = '';
    let lastPaint = 0;

    const full = await API.streamChat(cfg, history, function (delta) {
      if (!mdEl) {
        hideTyping();
        mdEl = createStreamBubble();
      }
      raw += delta;
      const now = performance.now();
      if (now - lastPaint > 80) {
        lastPaint = now;
        mdEl.innerHTML = renderBlocks(parseMarkdown(raw), true);
        scrollBottom();
      }
    });

    const textOut = full || raw;
    const blocks = parseMarkdown(textOut);
    if (!mdEl) {
      hideTyping();
      mdEl = createStreamBubble();
    }
    mdEl.innerHTML = renderBlocks(blocks);
    finishStreamBubble();
    commitBot(sess, blocks);
    state.config.verified = true;
    applyModeTag();
  }

  async function respond(sess, text) {
    state.sending = true;
    refreshSend();
    showTyping();

    const cfg = liveConfig();
    try {
      if (cfg) {
        await respondReal(sess, cfg, text);
      } else {
        await revealMockReply(sess, text);
      }
    } catch (err) {
      hideTyping();
      removeStreamBubble();
      state.config.verified = false;
      applyModeTag();
      setPet('error');
      window.setTimeout(function () { setPet('listening'); }, 1700);
      toast('模型调用失败，已切回演示对话');
      const msg = String((err && err.message) || err || '未知错误');
      showResult(false, msg);
      await revealMockReply(sess, text);
    } finally {
      state.sending = false;
      refreshSend();
      if (state.pet === 'thinking' || state.pet === 'responding') setPet('listening');
    }
  }

  function ensureMessageId(m) {
    if (!m.id) m.id = 'pm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    return m.id;
  }

  /* 只刷新这一张提议卡，避免整段聊天重新做入场动画 */
  function refreshProposal(m) {
    const el = document.getElementById('proposal_' + m.id);
    if (!el) { renderChat(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = proposalHTML(m, '');
    const node = tmp.firstElementChild;
    if (node) el.parentNode.replaceChild(node, el);
    scrollBottom();
  }

  function appendProposal(m) {
    const tmp = document.createElement('div');
    tmp.innerHTML = proposalHTML(m, '');
    const node = tmp.firstElementChild;
    if (node) chatList().appendChild(node);
    scrollBottom();
  }

  /* 用户说了一句值得记住的话 → 在聊天里给一张提议卡（默认不保存） */
  function maybePropose(sess, text) {
    if (!window.STORE || !STORE.isAdopted()) return;
    const p = STORE.propose(text);
    if (!p) return;
    const dup = STORE.list('memories').some(function (m) {
      return m.title === p.title || m.content === p.content;
    });
    if (dup) return;
    const msg = { role: 'proposal', proposal: p, status: 'pending', time: nowTime() };
    ensureMessageId(msg);
    sess.messages.push(msg);
    appendProposal(msg);
  }

  /* 用户说了一句像「习惯」的话 → 给一张习惯提议卡（一次只提一条） */
  function maybeProposeHabit(sess, text) {
    if (!window.STORE || !STORE.isAdopted()) return false;
    const cands = STORE.extractHabits(text);
    if (!cands.length) return false;
    const exist = STORE.habits();
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const dup = exist.some(function (h) { return h.name === c.name; });
      if (dup) continue;
      const pending = sess.messages.some(function (m) {
        return m.role === 'proposal' && m.kind === 'habit' && m.proposal && m.proposal.name === c.name;
      });
      if (pending) continue;
      const msg = { role: 'proposal', kind: 'habit', proposal: c, status: 'pending', time: nowTime() };
      ensureMessageId(msg);
      sess.messages.push(msg);
      appendProposal(msg);
      return true;
    }
    return false;
  }

  function sendMessage(rawText) {
    const text = String(rawText == null ? $('input').value : rawText).trim();
    if (!text) return;
    if (state.sending) {
      toast(petName() + '正在回你上一条，稍等两秒');
      return;
    }

    closeAllPanels();

    const sess = currentSession();
    sess.messages.push({ role: 'user', blocks: [{ t: 'p', text: text }], time: nowTime() });
    sess.summary = text.length > 26 ? text.slice(0, 26) + '…' : text;
    sess.time = '刚刚';

    $('input').value = '';
    autosize();
    refreshSend();
    animateSend();
    renderChat();
    renderSessions();

    respond(sess, text).then(function () {
      const habitShown = maybeProposeHabit(sess, text);
      if (!habitShown) maybePropose(sess, text);
    });
  }

  /* ============================ 8. 面板（抽屉 / 设置 / 遮罩） ============================ */

  function showScrim(on) {
    const s = $('scrim');
    if (on) {
      s.hidden = false;
      window.requestAnimationFrame(function () { s.classList.add('is-on'); });
    } else {
      s.classList.remove('is-on');
      window.setTimeout(function () {
        if (!$('drawerLeft').classList.contains('is-open') &&
            !$('drawerRight').classList.contains('is-open') &&
            !$('sheet').classList.contains('is-open') &&
            !$('sheetMemory').classList.contains('is-open')) {
          s.hidden = true;
        }
      }, 300);
    }
  }

  function openDrawer(which) {
    closeSheet();
    state.drawer[which] = true;
    const el = which === 'left' ? $('drawerLeft') : $('drawerRight');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    showScrim(true);
  }

  function closeDrawer(which) {
    state.drawer[which] = false;
    const el = which === 'left' ? $('drawerLeft') : $('drawerRight');
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    if (!state.drawer.left && !state.drawer.right && !state.sheet && !state.memSheet) showScrim(false);
  }

  function closeAllPanels() {
    if (state.drawer.left) closeDrawer('left');
    if (state.drawer.right) closeDrawer('right');
    if (state.memSheet) closeMemorySheet(false);
    if (state.sheet) closeSheet();
  }

  function openSheet() {
    if (state.drawer.left) closeDrawer('left');
    if (state.drawer.right) closeDrawer('right');
    if (state.memSheet) closeMemorySheet(false);
    state.sheet = true;
    state.pendingVerified = state.config.verified;
    syncSettingsForm();
    const el = $('sheet');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    showScrim(true);
  }

  function closeSheet() {
    state.sheet = false;
    const el = $('sheet');
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    clearResult();
    if (!state.drawer.left && !state.drawer.right && !state.memSheet) showScrim(false);
  }

  /* ---------- 记忆智能体：独立全屏页（从设置进入） ---------- */

  function openMemorySheet() {
    if (state.drawer.left) closeDrawer('left');
    if (state.drawer.right) closeDrawer('right');
    if (state.sheet) {
      state.sheet = false;
      const s = $('sheet');
      s.classList.remove('is-open');
      s.setAttribute('aria-hidden', 'true');
      clearResult();
    }
    state.memSheet = true;
    renderHabits();
    renderHabitChat();
    renderMemory();
    const el = $('sheetMemory');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    showScrim(true);
    window.setTimeout(function () { const i = $('habitInput'); if (i) i.focus(); }, 340);
  }

  function closeMemorySheet(backToSettings) {
    state.memSheet = false;
    const el = $('sheetMemory');
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    if (backToSettings) {
      openSheet();
    } else if (!state.drawer.left && !state.drawer.right && !state.sheet) {
      showScrim(false);
    }
  }

  let toastTimer = null;

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('is-on');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.classList.remove('is-on'); }, 2600);
  }

  /* ============================ 9. 设置面板 ============================ */

  function renderProvGrid() {
    $('provGrid').innerHTML = API.PROVIDERS.map(function (p) {
      const active = p.id === state.config.provider ? ' is-active' : '';
      return '<button class="prov' + active + '" type="button" data-prov="' + esc(p.id) + '">' +
        '<span class="prov-name">' + esc(p.name) + '</span>' +
        '<span class="prov-tag">' + esc(p.tag) + '</span>' +
        '</button>';
    }).join('');
  }

  function fillModelList(models) {
    $('modelList').innerHTML = (models || []).map(function (m) {
      return '<option value="' + esc(m) + '"></option>';
    }).join('');
  }

  function syncSettingsForm() {
    const c = state.config;
    $('useReal').checked = !!c.enabled;
    $('baseUrl').value = c.base || '';
    $('modelName').value = c.model || '';
    $('apiKey').value = c.key || '';
    $('temp').value = String(c.temp);
    $('tempVal').textContent = Number(c.temp).toFixed(1);
    $('apiKey').type = 'password';
    $('btnToggleKey').innerHTML = icon('eye', 16);
    $('btnToggleKey').setAttribute('aria-label', '显示或隐藏密钥');
    renderProvGrid();

    const p = API.provider(c.provider);
    fillModelList(p.models);
    $('modelHint').textContent = p.id === 'custom' ? '自定义端点请按厂商文档填写模型名' : '切换厂商会填入推荐模型，可手动改';
    const hint = $('modelHint');
    if (p.keyHint) hint.textContent = p.keyHint;

    $('testState').textContent = c.verified ? '配置已保存 · 上次测试通过' : '未测试';
    clearResult();
  }

  function readSettingsForm() {
    return {
      provider: state.config.provider,
      base: $('baseUrl').value.trim(),
      model: $('modelName').value.trim(),
      key: $('apiKey').value.trim(),
      temp: Number($('temp').value) || 0.7,
      enabled: $('useReal').checked,
      verified: false,
    };
  }

  function clearResult() {
    const el = $('result');
    el.hidden = true;
    el.className = 'result';
    el.innerHTML = '';
  }

  function showResult(ok, message, extra) {
    const el = $('result');
    el.hidden = false;
    el.className = 'result ' + (ok ? 'is-ok' : 'is-err');
    el.innerHTML = icon(ok ? 'checkCircle' : 'alert', 15) +
      '<div><b>' + (ok ? '连接成功' : '连接失败') + '</b>' + esc(message) +
      (extra ? '<span class="result-extra">' + esc(extra) + '</span>' : '') + '</div>';
  }

  function setTesting(busy) {
    const btn = $('btnTest');
    btn.disabled = busy;
    if (busy) {
      $('testState').textContent = '正在连接…';
    }
  }

  async function runTest(silent) {
    const cfg = readSettingsForm();
    if (!cfg.base) { if (!silent) showResult(false, '请先填写 Base URL'); return null; }
    if (!cfg.key) { if (!silent) showResult(false, '请先填写 API Key'); return null; }
    if (!cfg.model) { if (!silent) showResult(false, '请先填写模型名称'); return null; }

    setTesting(true);
    let r;
    try {
      r = await API.testConnection(cfg);
    } catch (e) {
      r = { ok: false, message: String(e && e.message || e) };
    }
    setTesting(false);

    if (r.ok) {
      state.pendingVerified = true;
      $('testState').textContent = '连接成功 · ' + r.latency + 'ms';
      showResult(true, '端点可访问（' + r.latency + 'ms）', r.models && r.models.length ? '已自动匹配到模型列表，点击右侧闪电可自动填入' : '');
      if (r.models && r.models.length) fillModelList(r.models);
      autoPickModel(r.models || []);
    } else {
      state.pendingVerified = false;
      $('testState').textContent = '连接失败';
      if (!silent) showResult(false, r.message || '未知错误');
    }
    return r;
  }

  function autoPickModel(models) {
    if (!models.length) return;
    const current = $('modelName').value.trim();
    if (models.indexOf(current) > -1) return;
    const chatLike = models.filter(function (m) {
      return /chat|instruct|pro|plus|max|flash|turbo|v1/i.test(m);
    });
    const pick = chatLike.length ? chatLike[0] : models[0];
    $('modelName').value = pick;
    toast('已自动匹配模型：' + pick);
  }

  async function autoMatchModel() {
    const cfg = readSettingsForm();
    if (!cfg.base || !cfg.key) {
      showResult(false, '先填好 Base URL 与 API Key，再自动匹配模型');
      return;
    }
    toast('正在读取模型列表…');
    const r = await runTest(true);
    if (!r || !r.ok) {
      showResult(false, (r && r.message) || '无法读取模型列表，可手动填写模型名');
      return;
    }
    if (!r.models || !r.models.length) {
      showResult(false, '该端点未返回模型列表，请手动填写模型名称');
    }
  }

  function persistConfig() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state.config));
    } catch (e) {
      toast('保存失败：浏览器存储不可用');
    }
  }

  function applyModeTag() {
    const c = state.config;
    const live = !!liveConfig();
    const text = $('statusText');
    if (text) text.textContent = petLabel();
    const peerStatus = document.querySelector('.peer-status');
    if (peerStatus) {
      peerStatus.title = live
        ? '真实模型：' + c.model + (c.verified ? '（已测通）' : '（待验证）')
        : '当前为内置演示对话';
    }
  }

  function saveSettings() {
    const cfg = readSettingsForm();
    if (cfg.enabled && (!cfg.base || !cfg.key || !cfg.model)) {
      showResult(false, '启用真实模型前，请补全 Base URL、模型名称与 API Key');
      return;
    }
    if (cfg.base && !/^https?:\/\//i.test(cfg.base)) {
      showResult(false, 'Base URL 需要以 http:// 或 https:// 开头');
      return;
    }
    cfg.verified = state.pendingVerified && cfg.enabled && !!cfg.key;
    state.config = cfg;
    persistConfig();
    applyModeTag();
    closeSheet();
    toast(cfg.enabled ? '已启用真实模型 · ' + API.provider(cfg.provider).name : '已切换为演示对话');
  }

  /* ============================ 10. 事件绑定 ============================ */

  function bindEvents() {
    /* 顶部入口 */
    $('btnHistory').addEventListener('click', function () {
      if (state.drawer.left) closeDrawer('left'); else openDrawer('left');
    });
    $('btnTopics').addEventListener('click', function () {
      if (state.drawer.right) closeDrawer('right'); else openDrawer('right');
    });
    $('btnCloseTopics').addEventListener('click', function () { closeDrawer('right'); });
    $('btnSettings').addEventListener('click', openSheet);
    $('sheetClose').addEventListener('click', closeSheet);

    $('scrim').addEventListener('click', closeAllPanels);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAllPanels(); closeModal(); }
    });

    /* 会话列表 */
    $('btnNewSession').addEventListener('click', createSession);

    $('sessionSearch').addEventListener('input', function (e) {
      state.search = e.target.value;
      renderSessions();
    });

    $('sessList').addEventListener('click', function (e) {
      const btn = e.target.closest('.sess');
      if (!btn) return;
      switchSession(btn.getAttribute('data-session'));
    });

    /* 话题面板：编辑模式下的新建 / 删除 / 调序 */
    $('btnEditTopics').addEventListener('click', toggleTopicEdit);
    $('btnAddGroup').addEventListener('click', addTopicGroup);
    $('btnResetTopics').addEventListener('click', confirmResetTopics);

    $('topicGroups').addEventListener('click', function (e) {
      const delGroup = e.target.closest('[data-del-group]');
      if (delGroup) { deleteTopicGroup(Number(delGroup.getAttribute('data-del-group'))); return; }

      const moveGroup = e.target.closest('[data-move-group]');
      if (moveGroup) {
        const p = moveGroup.getAttribute('data-move-group').split(':');
        moveTopicGroup(Number(p[0]), p[1]);
        return;
      }

      const addItem = e.target.closest('[data-add-item]');
      if (addItem) { addTopicItem(Number(addItem.getAttribute('data-add-item'))); return; }

      const delItem = e.target.closest('[data-del-item]');
      if (delItem) {
        const p = delItem.getAttribute('data-del-item').split(':');
        deleteTopicItem(Number(p[0]), Number(p[1]));
        return;
      }

      const moveItem = e.target.closest('[data-move-item]');
      if (moveItem) {
        const p = moveItem.getAttribute('data-move-item').split(':');
        moveTopicItem(Number(p[0]), Number(p[1]), p[2]);
        return;
      }

      if (state.topicEdit) return;
      const btn = e.target.closest('.topic');
      if (!btn) return;
      const t = topicByKey(btn.getAttribute('data-topic'));
      if (!t) return;
      closeDrawer('right');
      sendMessage(t.text);
    });

    /* 快捷 chip + 空状态 chip */
    $('quickbar').addEventListener('click', function (e) {
      const all = e.target.closest('#chipAll');
      if (all) { openDrawer('right'); return; }
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const i = Number(chip.getAttribute('data-quick'));
      const t = MOCK.quickTopics[i];
      if (t) sendMessage(t.text);
    });

    $('chatList').addEventListener('click', function (e) {
      /* 习惯提议卡：点了才写，默认拒绝 */
      const saveHabit = e.target.closest('[data-save-habit]');
      if (saveHabit) {
        const m = findMessage(saveHabit.getAttribute('data-save-habit'));
        if (m && m.status === 'pending' && m.kind === 'habit' && m.proposal) {
          STORE.addHabit({
            name: m.proposal.name,
            scene: m.proposal.scene,
            frequency: m.proposal.frequency,
            confidence: m.proposal.confidence,
            source: 'chat',
          });
          m.status = 'saved';
          refreshProposal(m);
          renderHabits();
          toast('已存进习惯，下次聊到会顺着用');
          celebrate();
        }
        return;
      }
      const skipHabit = e.target.closest('[data-skip-habit]');
      if (skipHabit) {
        const m = findMessage(skipHabit.getAttribute('data-skip-habit'));
        if (m && m.status === 'pending') { m.status = 'skipped'; refreshProposal(m); toast('好，这次不记这个习惯'); }
        return;
      }

      /* 记忆提议卡：点了才写，默认拒绝 */
      const saveMem = e.target.closest('[data-save-memory]');
      if (saveMem) {
        const m = findMessage(saveMem.getAttribute('data-save-memory'));
        if (m && m.status === 'pending' && m.proposal) {
          STORE.add('memories', {
            title: m.proposal.title,
            content: m.proposal.content,
            category: m.proposal.category,
            sourceType: 'chat',
            sourceId: state.activeId,
            status: 'active',
            confirmedAt: new Date().toISOString(),
          });
          STORE.logEvent('memory_add', { title: m.proposal.title });
          m.status = 'saved';
          refreshProposal(m);
          renderMemory();
          toast('已存进记忆，下次聊到会想起来');
          celebrate();
        }
        return;
      }
      const skipMem = e.target.closest('[data-skip-memory]');
      if (skipMem) {
        const m = findMessage(skipMem.getAttribute('data-skip-memory'));
        if (m && m.status === 'pending') { m.status = 'skipped'; refreshProposal(m); toast('好，这次不保存'); }
        return;
      }

      const chip = e.target.closest('.empty-chip');
      if (chip) {
        const i = Number(chip.getAttribute('data-quick'));
        const t = MOCK.quickTopics[i];
        if (t) sendMessage(t.text);
        return;
      }
      const copy = e.target.closest('.copy-btn');
      if (copy) {
        const block = copy.closest('.code-block');
        const codeEl = block && block.querySelector('code');
        if (!codeEl) return;
        copyText(codeEl.innerText).then(function (ok) {
          copy.textContent = ok ? '已复制' : '复制失败';
          copy.classList.add('is-done');
          window.setTimeout(function () {
            copy.textContent = '复制';
            copy.classList.remove('is-done');
          }, 1800);
        });
      }
    });

    /* 输入 */
    const input = $('input');
    input.addEventListener('input', function () {
      autosize();
      refreshSend();
    });
    input.addEventListener('focus', function () { $('composerBar').classList.add('is-focus'); });
    input.addEventListener('blur', function () { $('composerBar').classList.remove('is-focus'); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('btnSend').addEventListener('click', function () { sendMessage(); });

    /* 滚动到底部按钮 */
    $('chatScroll').addEventListener('scroll', function () {
      const box = $('chatScroll');
      const far = box.scrollHeight - box.scrollTop - box.clientHeight > 160;
      $('btnToBottom').hidden = !far;
    });
    $('btnToBottom').addEventListener('click', function () {
      scrollBottom();
      $('btnToBottom').hidden = true;
    });

    /* ---------- 设置：厂商 / 表单 ---------- */
    $('provGrid').addEventListener('click', function (e) {
      const btn = e.target.closest('.prov');
      if (!btn) return;
      const id = btn.getAttribute('data-prov');
      const p = API.provider(id);
      state.config.provider = p.id;
      state.pendingVerified = false;
      $('baseUrl').value = p.base;
      $('modelName').value = p.models[0] || '';
      fillModelList(p.models);
      $('testState').textContent = '未测试';
      $('modelHint').textContent = p.keyHint || '切换厂商会填入推荐模型，可手动改';
      renderProvGrid();
      clearResult();
    });

    $('btnResetBase').addEventListener('click', function () {
      const p = API.provider(state.config.provider);
      if (!p.base) { toast('自定义端点没有默认地址，请手动填写'); return; }
      $('baseUrl').value = p.base;
    });

    $('btnMatchModel').addEventListener('click', autoMatchModel);

    $('btnToggleKey').addEventListener('click', function () {
      const input = $('apiKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const btn = $('btnToggleKey');
      btn.innerHTML = icon(show ? 'eyeOff' : 'eye', 16);
      btn.setAttribute('aria-label', show ? '隐藏密钥' : '显示密钥');
    });

    $('temp').addEventListener('input', function (e) {
      $('tempVal').textContent = Number(e.target.value).toFixed(1);
    });

    $('useReal').addEventListener('change', function (e) {
      if (!e.target.checked) state.pendingVerified = false;
    });

    $('btnTest').addEventListener('click', function () { runTest(false); });

    $('btnSave').addEventListener('click', saveSettings);

    $('btnMock').addEventListener('click', function () {
      state.config.enabled = false;
      state.config.verified = false;
      $('useReal').checked = false;
      persistConfig();
      applyModeTag();
      closeSheet();
      toast('已切换为演示对话');
    });

    /* ---------- 四大视图 / 记忆 / 目标 / 成长 / 弹窗 / 领养 ---------- */

    $('tabbar').addEventListener('click', function (e) {
      const tab = e.target.closest('.tab');
      if (tab) switchView(tab.getAttribute('data-tab'));
    });

    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) closeModal();
    });

    /* 记忆智能体（设置 → 独立全屏页） */
    $('rowMemory').addEventListener('click', openMemorySheet);
    $('habitClose').addEventListener('click', function () { closeMemorySheet(true); });
    $('btnHabitAdd').addEventListener('click', function () { habitModal(null); });
    $('btnHabitScan').addEventListener('click', scanRecentHabits);
    $('btnHabitOthers').addEventListener('click', toggleHabitOthers);
    $('btnAddMem2').addEventListener('click', function () { memoryModal(null); });

    $('btnHabitSend').addEventListener('click', sendHabitMessage);
    $('habitInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendHabitMessage();
      }
    });

    $('habitList').addEventListener('click', function (e) {
      const ed = e.target.closest('[data-edit-habit]');
      if (ed) {
        const h = STORE.find('habits', ed.getAttribute('data-edit-habit'));
        if (h) habitModal(h);
        return;
      }
      const del = e.target.closest('[data-del-habit]');
      if (del) {
        const h = STORE.find('habits', del.getAttribute('data-del-habit'));
        if (h) confirmDeleteHabit(h);
      }
    });

    $('habitChat').addEventListener('click', function (e) {
      const sc = e.target.closest('[data-save-cand]');
      if (sc) { saveHabitCandidate(sc.getAttribute('data-save-cand')); return; }
      const kc = e.target.closest('[data-skip-cand]');
      if (kc) { skipHabitCandidate(kc.getAttribute('data-skip-cand')); }
    });

    /* 其他记忆（折叠区） */

    $('memFilter').addEventListener('click', function (e) {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.memFilter = btn.getAttribute('data-cat');
      renderMemory();
    });

    $('memSearch').addEventListener('input', function (e) {
      state.memQuery = e.target.value;
      renderMemory();
    });

    $('memoryList').addEventListener('click', function (e) {
      if (e.target.closest('[data-add-mem]')) { memoryModal(null); return; }
      const ed = e.target.closest('[data-edit-mem]');
      if (ed) {
        const m = STORE.find('memories', ed.getAttribute('data-edit-mem'));
        if (m) memoryModal(m);
        return;
      }
      const del = e.target.closest('[data-del-mem]');
      if (del) {
        const m = STORE.find('memories', del.getAttribute('data-del-mem'));
        if (m) confirmDeleteMemory(m);
      }
    });

    /* 目标 */
    $('btnAddGoal').addEventListener('click', goalModal);

    $('goalSeg').addEventListener('click', function (e) {
      const btn = e.target.closest('.seg3-btn');
      if (!btn) return;
      state.goalPane = btn.getAttribute('data-pane');
      renderGoal();
    });

    $('goalPane').addEventListener('click', onGoalPaneClick);

    /* 成长 */
    $('btnReview').addEventListener('click', function () { reviewModal(null); });

    $('growthBody').addEventListener('click', function (e) {
      const c = e.target.closest('[data-confirm-review]');
      if (c) {
        const r = STORE.confirmReview(c.getAttribute('data-confirm-review'));
        if (r) {
          renderGrowth();
          toast('复盘已确认，写进成长记录');
          celebrate();
        }
        return;
      }
      const ed = e.target.closest('[data-edit-review]');
      if (ed) {
        const r = STORE.find('reviews', ed.getAttribute('data-edit-review'));
        if (r) reviewModal(r);
      }
    });

    /* 设置：清除本地数据 */
    $('btnResetAll').addEventListener('click', function () {
      openModal({
        title: '清除本地数据？',
        ok: '清除并重新领养',
        danger: true,
        body: '<p class="review-line">记忆、目标、任务、复盘都会从这台设备删除，且无法恢复。模型配置会保留。</p>',
        onSubmit: function () {
          STORE.reset();
          window.setTimeout(function () { window.location.reload(); }, 320);
        },
      });
    });

    /* 领养引导 */
    $('obNext1').addEventListener('click', function () { obShowStep(2); });

    $('obNext2').addEventListener('click', function () {
      const owner = $('obOwner').value.trim();
      if (!owner) {
        $('obError').hidden = false;
        $('obError').textContent = '先告诉我怎么称呼你，它打招呼时要用';
        $('obOwner').focus();
        return;
      }
      $('obError').hidden = true;
      const pet = $('obPet').value.trim() || '叮当';
      const lookName = (STORE.LOOKS[obLook] || STORE.LOOKS.classic).name;
      $('obSummary').innerHTML =
        '<div class="ob-sum-row"><span>你的称呼</span><b>' + esc(owner) + '</b></div>' +
        '<div class="ob-sum-row"><span>伴元名字</span><b>' + esc(pet) + '</b></div>' +
        '<div class="ob-sum-row"><span>形象</span><b>' + esc(lookName) + '</b></div>' +
        '<div class="ob-sum-row"><span>数据位置</span><b>仅这台设备</b></div>';
      obShowStep(3);
    });

    $('obLooks').addEventListener('click', function (e) {
      const btn = e.target.closest('.ob-look');
      if (!btn) return;
      obLook = btn.getAttribute('data-look');
      document.querySelectorAll('.ob-look').forEach(function (b) {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    });

    $('obBack').addEventListener('click', function () { obShowStep(2); });

    $('obDone').addEventListener('click', finishOnboarding);
  }

  /* ============================ 10.5 视图 / 记忆 / 目标 / 成长 / 弹窗 / 领养 ============================ */

  const TABS = ['chat', 'goal', 'growth'];

  function switchView(name) {
    if (TABS.indexOf(name) === -1) name = 'chat';
    state.view = name;
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.getAttribute('data-view') === name);
    });
    document.querySelectorAll('#tabbar .tab').forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === name);
    });
    if (name === 'goal') renderGoal();
    if (name === 'growth') renderGrowth();
    if (name === 'chat') window.setTimeout(scrollBottom, 40);
  }

  /* ---------------- 通用弹窗 ---------------- */

  function openModal(opts) {
    state.modal = opts;
    $('modalTitle').textContent = opts.title || '';
    $('modalBody').innerHTML = opts.body || '';
    const foot = $('modalFoot');
    if (opts.ok) {
      foot.hidden = false;
      foot.innerHTML = '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" type="button" id="modalOk">' + esc(opts.ok) + '</button>';
      $('modalOk').addEventListener('click', function () {
        if (!opts.onSubmit) { closeModal(); return; }
        const r = opts.onSubmit();
        if (r !== false) closeModal();
      });
    } else {
      foot.hidden = true;
      foot.innerHTML = '';
    }
    const el = $('modal');
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(function () { el.classList.add('is-on'); });
    const first = $('modalBody').querySelector('input, textarea, select');
    if (first) window.setTimeout(function () { first.focus(); }, 300);
  }

  function closeModal() {
    const el = $('modal');
    if (!el || el.hidden) return;
    el.classList.remove('is-on');
    el.setAttribute('aria-hidden', 'true');
    state.modal = null;
    window.setTimeout(function () {
      if (state.modal) return; /* 关闭动画期间又开了新弹窗，别把它清掉 */
      el.hidden = true;
      $('modalBody').innerHTML = '';
      $('modalFoot').innerHTML = '';
    }, 220);
  }

  /* ---------------- 小工具 ---------------- */

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) {
      const s = String(v);
      return s.length >= 10 ? s.slice(5, 10) : s;
    }
    return (d.getMonth() + 1) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function todayISO(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function taskStatusLabel(st) {
    return { todo: '待做', doing: '在做', done: '已完成', canceled: '已取消', archived: '已归档' }[st] || st;
  }

  function prioTag(p) {
    const map = { high: ['高优先', 'is-high'], medium: ['中优先', 'is-medium'], low: ['低优先', ''] };
    const m = map[p] || map.low;
    return '<span class="prio' + (m[1] ? ' ' + m[1] : '') + '">' + m[0] + '</span>';
  }

  function emptyBox(title, text, label, attr) {
    return '<div class="empty-box"><h4>' + esc(title) + '</h4><p>' + esc(text) + '</p>' +
      (label ? '<button class="btn btn-soft" type="button" ' + attr + '>' + icon('plus', 15) + ' ' + esc(label) + '</button>' : '') +
      '</div>';
  }

  function emptyBoxSmall(title, text) {
    return '<div class="empty-box"><h4>' + esc(title) + '</h4><p>' + esc(text) + '</p></div>';
  }

  /* ---------------- 记忆 ---------------- */

  function renderMemory() {
    $('memFilter').innerHTML = STORE.CATEGORIES.map(function (c) {
      const active = c === state.memFilter ? ' is-active' : '';
      return '<button class="seg-btn' + active + '" type="button" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');

    const list = STORE.memories(state.memFilter, state.memQuery);
    const box = $('memoryList');
    if (!list.length) {
      box.innerHTML = emptyBox('这里还没有记忆', '聊到重要的事，伴元会先问你一句；你点头才写进来。', '记一条', 'data-add-mem="1"');
      return;
    }
    box.innerHTML = list.map(memCardHTML).join('');
  }

  function memCardHTML(m) {
    const warm = m.category === '偏好' || m.category === '生活';
    return '<div class="mem-card">' +
      '<div class="mem-card-head">' +
      '<span class="tag' + (warm ? ' is-warm' : '') + '">' + esc(m.category || '记忆') + '</span>' +
      '<span class="mem-title">' + esc(m.title) + '</span>' +
      '<span class="mini-actions">' +
      '<button class="mini-btn" type="button" data-edit-mem="' + esc(m.id) + '" aria-label="编辑记忆">' + icon('edit', 14) + '</button>' +
      '<button class="mini-btn is-danger" type="button" data-del-mem="' + esc(m.id) + '" aria-label="删除记忆">' + icon('trash', 14) + '</button>' +
      '</span></div>' +
      '<p class="mem-content">' + esc(m.content) + '</p>' +
      '<div class="mem-foot"><span>' + esc(fmtDate(m.confirmedAt || m.createdAt)) + ' · 你确认保存</span><span>v' + (m.version || 1) + '</span></div>' +
      '</div>';
  }

  function memoryModal(m) {
    const isEdit = !!m;
    const cats = ['方向', '偏好', '生活', '健康', '工作'];
    const cur = isEdit ? m.category : '方向';
    openModal({
      title: isEdit ? '编辑记忆' : '新增记忆',
      ok: isEdit ? '保存修改' : '存进记忆',
      body:
        '<div class="field"><label for="memTitle">一句话标题</label>' +
        '<input id="memTitle" class="input" maxlength="24" placeholder="例如：工作日骑车通勤" value="' + esc(isEdit ? m.title : '') + '"></div>' +
        '<div class="field"><label for="memCat">分类</label><select id="memCat" class="input input-select">' +
        cats.map(function (c) { return '<option value="' + c + '"' + (cur === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label for="memContent">具体内容</label>' +
        '<textarea id="memContent" class="input input-area" maxlength="200" placeholder="写清楚背景，以后它才好用">' + esc(isEdit ? m.content : '') + '</textarea></div>' +
        '<p class="page-note">默认拒绝保存：只有你在这里点确认，才会写进「我的记忆」。</p>',
      onSubmit: function () {
        const title = $('memTitle').value.trim();
        const content = $('memContent').value.trim();
        if (!title || !content) { toast('标题和内容都要填'); return false; }
        const cat = $('memCat').value;
        if (isEdit) {
          STORE.patch('memories', m.id, { title: title, content: content, category: cat });
          toast('记忆已更新');
        } else {
          STORE.add('memories', {
            title: title, content: content, category: cat,
            sourceType: 'manual', status: 'active', confirmedAt: new Date().toISOString(),
          });
          STORE.logEvent('memory_add', { title: title });
          toast('已存进记忆');
          celebrate();
        }
        renderMemory();
      },
    });
  }

  function confirmDeleteMemory(m) {
    openModal({
      title: '删除这条记忆？',
      ok: '删除',
      danger: true,
      body: '<p class="review-line"><b>' + esc(m.title) + '</b></p>' +
        '<p class="review-line">删除后新会话不再召回它；历史消息里出现过的原文仍会保留。</p>',
      onSubmit: function () {
        STORE.remove('memories', m.id);
        STORE.logEvent('memory_delete', { title: m.title });
        renderMemory();
        toast('已删除');
      },
    });
  }

  function findMessage(id) {
    const sess = currentSession();
    if (!sess) return null;
    for (let i = 0; i < sess.messages.length; i++) {
      if (sess.messages[i].id === id) return sess.messages[i];
    }
    return null;
  }

  /* ---------------- 记忆智能体：习惯 ---------------- */

  function renderHabits() {
    const hs = STORE.habits();
    $('habitCount').textContent = hs.length + ' 条';
    const box = $('habitList');
    if (!hs.length) {
      box.innerHTML = '<div class="empty-box"><h4>还没有习惯</h4><p>在下面说一句「我每天睡前都要刷会儿手机」，或者点「手动添加」。</p></div>';
      return;
    }
    box.innerHTML = hs.map(habitCardHTML).join('');
  }

  function habitCardHTML(h) {
    const src = h.source === 'manual' ? '手动添加' : '从对话认出';
    const pct = Math.round(Number(h.confidence || 0) * 100);
    return '<div class="habit-card">' +
      '<div class="habit-top"><h4 class="habit-name">' + esc(h.name) + '</h4>' +
      '<span class="mini-actions">' +
      '<button class="mini-btn" type="button" data-edit-habit="' + esc(h.id) + '" aria-label="编辑习惯">' + icon('edit', 14) + '</button>' +
      '<button class="mini-btn is-danger" type="button" data-del-habit="' + esc(h.id) + '" aria-label="删除习惯">' + icon('trash', 14) + '</button>' +
      '</span></div>' +
      '<div class="habit-chips">' +
      '<span class="habit-chip">' + icon('clock', 12) + esc(h.scene) + '</span>' +
      '<span class="habit-chip">' + icon('refresh', 12) + esc(h.frequency) + '</span>' +
      '<span class="habit-src">' + esc(src) + '</span>' +
      '</div>' +
      '<div class="habit-conf"><span class="habit-conf-bar"><i style="width:' + pct + '%"></i></span><span>可信度 ' + pct + '%</span></div>' +
      '</div>';
  }

  function habitModal(h, preset) {
    const isEdit = !!h;
    const base = isEdit ? h : (preset || {});
    const scenes = ['睡前', '早起', '通勤', '午后', '工作日', '周末', '随时'];
    const freqs = ['每天', '每周3次', '每周2次', '每周1次', '偶尔', '经常'];
    const curScene = scenes.indexOf(base.scene) > -1 ? base.scene : '睡前';
    const curFreq = freqs.indexOf(base.frequency) > -1 ? base.frequency : '每天';
    openModal({
      title: isEdit ? '编辑习惯' : '手动添加习惯',
      ok: isEdit ? '保存修改' : '存进习惯',
      body:
        '<div class="field"><label for="habitName">这个习惯是什么</label>' +
        '<input id="habitName" class="input" maxlength="18" placeholder="例如：刷会儿手机" value="' + esc(base.name || '') + '"></div>' +
        '<div class="form-grid">' +
        '<div class="field"><label for="habitScene">触发场景</label><select id="habitScene" class="input input-select">' +
        scenes.map(function (s) { return '<option value="' + s + '"' + (s === curScene ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label for="habitFreq">频率</label><select id="habitFreq" class="input input-select">' +
        freqs.map(function (f) { return '<option value="' + f + '"' + (f === curFreq ? ' selected' : '') + '>' + f + '</option>'; }).join('') +
        '</select></div>' +
        '</div>' +
        '<p class="page-note">手动添加的习惯记「手动添加」；从对话认出的记「从对话认出」。</p>',
      onSubmit: function () {
        const name = $('habitName').value.trim();
        if (!name) { toast('先写这个习惯是什么'); return false; }
        const scene = $('habitScene').value;
        const frequency = $('habitFreq').value;
        if (isEdit) {
          STORE.patchHabit(h.id, { name: name, scene: scene, frequency: frequency });
          toast('习惯已更新');
        } else {
          STORE.addHabit({ name: name, scene: scene, frequency: frequency, source: 'manual', confidence: 0.7 });
          toast('已存进习惯');
        }
        renderHabits();
      },
    });
  }

  function confirmDeleteHabit(h) {
    openModal({
      title: '删除这个习惯？',
      ok: '删除',
      danger: true,
      body: '<p class="review-line"><b>' + esc(h.name) + '</b> · ' + esc(h.scene) + ' · ' + esc(h.frequency) + '</p>' +
        '<p class="review-line">删掉后它不再作为背景；想找回来，你再说一遍就行。</p>',
      onSubmit: function () {
        STORE.removeHabit(h.id);
        renderHabits();
        toast('已删除');
      },
    });
  }

  function candCardHTML(c) {
    const pct = Math.round(Number(c.confidence || 0) * 100);
    return '<div class="habit-cand">' +
      '<p class="habit-cand-eyebrow">BANYUAN · 习惯候选</p>' +
      '<p class="habit-cand-name">' + esc(c.name) + '</p>' +
      '<p class="habit-cand-meta">场景 ' + esc(c.scene) + ' · 频率 ' + esc(c.frequency) + ' · 可信度 ' + pct + '%</p>' +
      '<div class="habit-cand-acts">' +
      '<button class="btn btn-xs is-primary" type="button" data-save-cand="' + esc(c.id) + '">存进习惯</button>' +
      '<button class="btn btn-xs is-quiet" type="button" data-skip-cand="' + esc(c.id) + '">忽略</button>' +
      '</div></div>';
  }

  function renderHabitChat() {
    const box = $('habitChat');
    if (!state.habitChat.length && !state.habitCand.length) {
      box.innerHTML = '<p class="habit-hint">说一句你常做的事，比如「我每天睡前都要刷会儿手机」。它会整理成场景和频率，你点「存进习惯」才保存。</p>';
      return;
    }
    let html = '';
    state.habitChat.forEach(function (m) {
      if (m.role === 'user') html += '<div class="habit-bubble is-user">' + esc(m.text) + '</div>';
      else html += '<div class="habit-bubble is-bot"><div class="md">' + renderBlocks(m.blocks) + '</div></div>';
    });
    html += state.habitCand.map(candCardHTML).join('');
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function sendHabitMessage() {
    const input = $('habitInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    state.habitChat.push({ role: 'user', text: text });
    state.habitChat.push({ role: 'bot', blocks: MOCK.habitReply(text) });

    const cands = STORE.extractHabits(text);
    const exist = STORE.habits();
    let added = 0;
    cands.forEach(function (c) {
      const dup = exist.some(function (h) { return h.name === c.name; }) ||
        state.habitCand.some(function (x) { return x.name === c.name; });
      if (dup) return;
      state.habitCand.push(Object.assign({ id: 'c_' + Date.now().toString(36) + added }, c));
      added += 1;
    });
    renderHabitChat();
    if (added) toast('认出一条可能的习惯，确认后才保存');
  }

  function saveHabitCandidate(id) {
    const c = state.habitCand.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    STORE.addHabit({
      name: c.name, scene: c.scene, frequency: c.frequency,
      confidence: c.confidence, source: 'chat',
    });
    state.habitCand = state.habitCand.filter(function (x) { return x.id !== id; });
    renderHabits();
    renderHabitChat();
    toast('已存进习惯');
    celebrate();
  }

  function skipHabitCandidate(id) {
    state.habitCand = state.habitCand.filter(function (x) { return x.id !== id; });
    renderHabitChat();
    toast('这条先不记');
  }

  /* 每次进记忆智能体页，都扫一遍最近对话，补上没入库的习惯 */
  function scanRecentHabits() {
    const exist = STORE.habits();
    const found = [];
    state.sessions.forEach(function (sess) {
      (sess.messages || []).slice(-30).forEach(function (m) {
        if (m.role !== 'user' || !m.blocks) return;
        STORE.extractHabits(MOCK.blockToText(m.blocks)).forEach(function (c) {
          if (exist.some(function (h) { return h.name === c.name; })) return;
          if (found.some(function (x) { return x.name === c.name; })) return;
          if (state.habitCand.some(function (x) { return x.name === c.name; })) return;
          found.push(Object.assign({ id: 'c_' + Date.now().toString(36) + found.length }, c));
        });
      });
    });

    if (!found.length) {
      toast('最近的对话里没认出新的习惯');
      return;
    }
    state.habitChat.push({
      role: 'bot',
      blocks: [{ t: 'p', text: '我从最近的对话里翻到 ' + found.length + ' 条可能的习惯。你点「存进习惯」才会真的记下。' }],
    });
    state.habitCand = state.habitCand.concat(found).slice(-6);
    renderHabitChat();
    toast('找到 ' + found.length + ' 条待确认的习惯');
  }

  function toggleHabitOthers() {
    state.habitOthers = !state.habitOthers;
    $('habitOthers').hidden = !state.habitOthers;
    $('btnHabitOthers').setAttribute('aria-expanded', state.habitOthers ? 'true' : 'false');
  }

  /* ---------------- 方向 / 方法 / 成长 ---------------- */

  function renderGoal() {
    const pane = state.goalPane;
    $('goalSub').textContent =
      pane === 'direction' ? '先定方向：想清楚要去哪' :
      pane === 'method' ? '再拆方法：把方向变成每周能做的小步' :
      '最后看成长：只记事实，也记感受';
    document.querySelectorAll('#goalSeg .seg3-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-pane') === pane);
    });
    const box = $('goalPane');
    if (pane === 'direction') box.innerHTML = paneDirection();
    else if (pane === 'method') box.innerHTML = paneMethod();
    else box.innerHTML = paneGoalGrowth();
  }

  function paneDirection() {
    const goals = STORE.openGoals();
    if (!goals.length) {
      return emptyBox('还没有方向', '先写一个想去的方向，比如「三个月提升销售能力」。', '新建方向', 'data-add-goal="1"');
    }
    return '<div class="section-title">进行中的方向</div><div class="list">' + goals.map(function (g) {
      const p = STORE.goalProgress(g.id);
      const tasks = STORE.tasksOf(g.id);
      const open = !!state.openTasks[g.id];
      return '<div class="goal-card">' +
        '<div class="goal-top"><h4 class="goal-title">' + esc(g.title) + '</h4>' + prioTag(g.priority) + '</div>' +
        (g.description ? '<p class="goal-desc">' + esc(g.description) + '</p>' : '') +
        '<div class="progress"><span style="width:' + p.pct + '%"></span></div>' +
        '<div class="goal-meta">' +
        '<span>任务 ' + p.done + '/' + p.total + '</span>' +
        '<span>指标 ' + esc(g.metric || '—') + '</span>' +
        '<span>' + (g.dueDate ? '截止 ' + esc(g.dueDate) : '未设截止') + '</span>' +
        '<span>' + (g.status === 'paused' ? '暂缓中' : '进行中') + '</span>' +
        '</div>' +
        '<div class="goal-actions">' +
        '<button class="btn btn-xs" type="button" data-toggle-tasks="' + esc(g.id) + '">' + icon('listChecks', 13) + ' ' + (open ? '收起任务' : '查看任务') + '</button>' +
        '<button class="btn btn-xs" type="button" data-add-task="' + esc(g.id) + '">' + icon('plus', 13) + ' 加任务</button>' +
        '<button class="btn btn-xs" type="button" data-add-plan="' + esc(g.id) + '">' + icon('layers', 13) + ' 拆方法</button>' +
        '</div>' +
        (open ? taskRows(tasks) : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function taskRows(tasks) {
    if (!tasks.length) return '<p class="task-sub" style="padding:8px 0 0">还没有任务，点「加任务」拆出第一步。</p>';
    return tasks.map(function (t) {
      const done = t.status === 'done';
      const doing = t.status === 'doing';
      const canceled = t.status === 'canceled';
      const cls = done || canceled ? ' is-done' : '';
      const mark = done ? icon('check', 11) : doing ? '<span class="task-dot"></span>' : '';
      return '<div class="task' + cls + '">' +
        '<button class="task-check' + (done ? ' is-done' : doing ? ' is-doing' : '') + '" type="button" data-task="' + esc(t.id) + '" aria-label="切换任务状态">' + mark + '</button>' +
        '<div class="task-main"><div class="task-title">' + esc(t.title) + '</div>' +
        '<div class="task-sub"><b>' + taskStatusLabel(t.status) + '</b>' +
        (t.dueAt ? ' · 截止 ' + esc(t.dueAt) : '') +
        (t.note ? ' · ' + esc(t.note) : '') +
        (t.evidence ? ' · 证据：' + esc(t.evidence) : '') +
        '</div></div>' +
        '<button class="mini-btn is-danger" type="button" data-del-task="' + esc(t.id) + '" aria-label="删除任务">' + icon('trash', 13) + '</button>' +
        '</div>';
    }).join('');
  }

  function paneMethod() {
    const plans = STORE.list('plans');
    if (!plans.length) {
      return emptyBox('还没有方法卡', '在方向卡片里点「拆方法」，把目标拆成每周能做的步骤。', '新建方向', 'data-add-goal="1"');
    }
    const goals = STORE.list('goals');
    return '<div class="section-title">计划 · 拆到能做的步</div><div class="list">' + plans.map(function (pl) {
      const g = goals.filter(function (x) { return x.id === pl.goalId; })[0];
      const steps = pl.steps || [];
      return '<div class="plan-card">' +
        '<p class="plan-goal">' + icon('target', 12) + ' ' + esc(g ? g.title : '未关联方向') + '</p>' +
        steps.map(function (s) {
          return '<div class="plan-step' + (s.done ? ' is-done' : '') + '" data-step="' + esc(pl.id) + ':' + esc(s.id) + '" role="button" tabindex="0">' +
            '<span class="task-check' + (s.done ? ' is-done' : '') + '>' + (s.done ? icon('check', 11) : '') + '</span>' +
            '<span>' + esc(s.text) + '</span></div>';
        }).join('') +
        '<div class="goal-actions"><button class="btn btn-xs" type="button" data-add-step="' + esc(pl.id) + '">' + icon('plus', 13) + ' 加一步</button></div>' +
        '</div>';
    }).join('') + '</div>' +
      '<p class="page-note">方法卡一行一步，做完打勾；走完一整张才算「这个方法跑通过」。</p>';
  }

  function paneGoalGrowth() {
    const s = STORE.growthStats();
    const goals = STORE.openGoals();
    return '<div class="stat-grid">' +
      '<div class="stat"><b>' + s.userTasks + '<em>件</em></b><span>已完成的任务</span></div>' +
      '<div class="stat"><b>' + s.reviews + '<em>次</em></b><span>已确认的复盘</span></div>' +
      '</div>' +
      '<div class="section-title">每个方向走到哪了</div><div class="list">' +
      goals.map(function (g) {
        const p = STORE.goalProgress(g.id);
        return '<div class="goal-card">' +
          '<div class="goal-top"><h4 class="goal-title">' + esc(g.title) + '</h4><span class="prio">' + p.pct + '%</span></div>' +
          '<div class="progress"><span style="width:' + p.pct + '%"></span></div>' +
          '<div class="goal-meta"><span>完成 ' + p.done + ' 件</span><span>还剩 ' + (p.total - p.done) + ' 件</span></div>' +
          '</div>';
      }).join('') + '</div>' +
      '<p class="page-note">成长只记事实与感受；技能卡是伴元从复盘里提炼的方法，需你验证后才算数。</p>';
  }

  function onGoalPaneClick(e) {
    const tg = e.target.closest('[data-toggle-tasks]');
    if (tg) {
      const id = tg.getAttribute('data-toggle-tasks');
      state.openTasks[id] = !state.openTasks[id];
      renderGoal();
      return;
    }
    const at = e.target.closest('[data-add-task]');
    if (at) { taskModal(at.getAttribute('data-add-task')); return; }
    const ap = e.target.closest('[data-add-plan]');
    if (ap) { planModal(ap.getAttribute('data-add-plan')); return; }
    const dt = e.target.closest('[data-del-task]');
    if (dt) { confirmTaskDelete(dt.getAttribute('data-del-task')); return; }
    const tk = e.target.closest('[data-task]');
    if (tk) {
      const t = STORE.find('tasks', tk.getAttribute('data-task'));
      if (!t) return;
      const next = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : t.status === 'done' ? 'archived' : 'todo';
      const r = STORE.setTaskStatus(t.id, next);
      if (!r) { toast('这个状态不能这样切'); return; }
      renderGoal();
      if (next === 'done') { toast('做完了，这一步算数'); celebrate(); }
      else if (next === 'doing') toast('开始做了，先做 10 分钟也算');
      return;
    }
    const st = e.target.closest('[data-step]');
    if (st) {
      const parts = st.getAttribute('data-step').split(':');
      toggleStep(parts[0], parts[1]);
      return;
    }
    const as = e.target.closest('[data-add-step]');
    if (as) { stepModal(as.getAttribute('data-add-step')); return; }
    if (e.target.closest('[data-add-goal]')) { goalModal(); return; }
  }

  function goalModal() {
    openModal({
      title: '新建方向',
      ok: '保存方向',
      body:
        '<div class="field"><label for="goalTitle">想去哪</label><input id="goalTitle" class="input" maxlength="26" placeholder="例如：三个月提升销售能力"></div>' +
        '<div class="field"><label for="goalDesc">为什么 / 现状</label><textarea id="goalDesc" class="input input-area" maxlength="160" placeholder="一句话说清楚现在在哪、想去哪"></textarea></div>' +
        '<div class="form-grid">' +
        '<div class="field"><label for="goalMetric">怎么算达成</label><input id="goalMetric" class="input" maxlength="30" placeholder="独立成单 3 单"></div>' +
        '<div class="field"><label for="goalDue">截止日期</label><input id="goalDue" class="input" type="date" value="' + todayISO(30) + '"></div>' +
        '</div>' +
        '<div class="field"><label for="goalPrio">优先级</label><select id="goalPrio" class="input input-select">' +
        '<option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></div>' +
        '<p class="page-note">方向可以模糊，但「怎么算达成」最好能验证。</p>',
      onSubmit: function () {
        const title = $('goalTitle').value.trim();
        if (!title) { toast('先写一个想去哪'); return false; }
        STORE.add('goals', {
          title: title,
          description: $('goalDesc').value.trim(),
          metric: $('goalMetric').value.trim(),
          dueDate: $('goalDue').value,
          priority: $('goalPrio').value,
          status: 'active',
        });
        STORE.logEvent('goal_add', { title: title });
        renderGoal();
        toast('方向已建立');
      },
    });
  }

  function taskModal(goalId) {
    const goals = STORE.openGoals();
    if (!goals.length) { toast('先建一个方向，任务才有地方挂'); goalModal(); return; }
    openModal({
      title: '加一个任务',
      ok: '加进方向',
      body:
        '<div class="field"><label for="taskTitle">下一步做什么</label><input id="taskTitle" class="input" maxlength="30" placeholder="例如：写第 1 个客户场景讲法"></div>' +
        '<div class="field"><label for="taskGoal">属于哪个方向</label><select id="taskGoal" class="input input-select">' +
        goals.map(function (g) {
          return '<option value="' + esc(g.id) + '"' + (g.id === goalId ? ' selected' : '') + '>' + esc(g.title) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="form-grid">' +
        '<div class="field"><label for="taskDue">截止日期</label><input id="taskDue" class="input" type="date" value="' + todayISO(2) + '"></div>' +
        '<div class="field"><label for="taskPrio">优先级</label><select id="taskPrio" class="input input-select">' +
        '<option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></div>' +
        '</div>' +
        '<div class="field"><label for="taskNote">备注</label><input id="taskNote" class="input" maxlength="40" placeholder="可选：做的时候要注意什么"></div>',
      onSubmit: function () {
        const title = $('taskTitle').value.trim();
        if (!title) { toast('先写下一步做什么'); return false; }
        const gid = $('taskGoal').value;
        STORE.add('tasks', {
          goalId: gid, title: title,
          note: $('taskNote').value.trim(),
          dueAt: $('taskDue').value,
          priority: $('taskPrio').value,
          status: 'todo',
        });
        STORE.logEvent('task_add', { title: title });
        state.openTasks[gid] = true;
        renderGoal();
        toast('任务已加上');
      },
    });
  }

  function confirmTaskDelete(id) {
    const t = STORE.find('tasks', id);
    if (!t) return;
    openModal({
      title: '删除这个任务？',
      ok: '删除',
      danger: true,
      body: '<p class="review-line"><b>' + esc(t.title) + '</b></p>' +
        '<p class="review-line">删除后不再计入完成数与成长记录。</p>',
      onSubmit: function () {
        STORE.remove('tasks', id);
        renderGoal();
        toast('任务已删除');
      },
    });
  }

  function planModal(goalId) {
    openModal({
      title: '拆方法',
      ok: '生成计划',
      body:
        '<div class="field"><label for="planInput">这周能做的步骤，一行一条</label>' +
        '<textarea id="planInput" class="input input-area" placeholder="1) 拆一个典型场景\n2) 每周做一次演练\n3) 把复盘写下来"></textarea></div>' +
        '<p class="page-note">先拆到 2–4 步就够；做完再补，别一次排满。</p>',
      onSubmit: function () {
        const steps = $('planInput').value.split(/\n/).map(function (s) {
          return s.replace(/^\s*\d+[).、]\s*/, '').trim();
        }).filter(Boolean).slice(0, 6);
        if (!steps.length) { toast('至少写一步'); return false; }
        STORE.add('plans', {
          goalId: goalId,
          status: 'active',
          steps: steps.map(function (text, i) { return { id: 's' + (i + 1), text: text, done: false }; }),
        });
        STORE.logEvent('plan_add', { goalId: goalId, count: steps.length });
        state.goalPane = 'method';
        renderGoal();
        toast('方法拆好了');
      },
    });
  }

  function stepModal(planId) {
    openModal({
      title: '加一步',
      ok: '加上',
      body: '<div class="field"><label for="stepText">这一步做什么</label>' +
        '<input id="stepText" class="input" maxlength="40" placeholder="例如：每周做 1 次角色扮演"></div>',
      onSubmit: function () {
        const text = $('stepText').value.trim();
        if (!text) { toast('先写这一步做什么'); return false; }
        const pl = STORE.find('plans', planId);
        if (!pl) { toast('这张方法卡不存在'); return false; }
        const steps = (pl.steps || []).concat([{ id: 's' + ((pl.steps || []).length + 1), text: text, done: false }]);
        STORE.patch('plans', planId, { steps: steps });
        renderGoal();
        toast('已加一步');
      },
    });
  }

  function toggleStep(planId, sid) {
    const pl = STORE.find('plans', planId);
    if (!pl) return;
    const steps = (pl.steps || []).map(function (s) {
      return s.id === sid ? { id: s.id, text: s.text, done: !s.done } : s;
    });
    const allDone = steps.length > 0 && steps.every(function (s) { return s.done; });
    STORE.patch('plans', planId, { steps: steps, status: allDone ? 'done' : 'active' });
    renderGoal();
    if (allDone) { toast('这张方法卡走完了'); celebrate(); }
  }

  /* ---------------- 成长 ---------------- */

  function renderGrowth() {
    const s = STORE.growthStats();
    const drafts = STORE.list('reviews').filter(function (r) { return r.status === 'draft'; });
    const confirmed = STORE.list('reviews').filter(function (r) { return r.status === 'confirmed'; });
    const skills = STORE.list('skills');
    const growth = STORE.list('growth');

    let html = '<div class="stat-grid">' +
      '<div class="stat"><b>' + s.userTasks + '<em>件</em></b><span>已完成的任务</span></div>' +
      '<div class="stat is-pet"><b>' + s.petSkills + '<em>张</em></b><span>伴元沉淀的方法卡</span></div>' +
      '</div>';

    if (drafts.length) {
      html += '<div class="section-title">等你确认的复盘</div><div class="list">' + drafts.map(reviewCard).join('') + '</div>';
    }

    html += '<div class="section-title">已确认的复盘</div>' +
      (confirmed.length ? '<div class="list">' + confirmed.map(reviewCard).join('') + '</div>'
        : emptyBoxSmall('还没有确认过的复盘', '做完一件小事就能写一条：先记事实，再说感受。'));

    html += '<div class="section-title">伴元沉淀的方法卡</div>' +
      (skills.length ? '<div class="list">' + skills.map(skillCard).join('') + '</div>'
        : emptyBoxSmall('还没有方法卡', '复盘确认后，伴元会试着提炼一份可复用的方法。'));

    html += '<div class="section-title">成长时间线</div>' +
      (growth.length ? '<div class="timeline">' + growth.map(function (g) {
        return '<div class="tl-item' + (g.subject === 'pet' ? ' is-pet' : '') + '">' +
          '<p class="tl-text">' + esc(g.summary) + '</p>' +
          '<span class="tl-date">' + esc(fmtDate(g.createdAt)) + (g.subject === 'pet' ? ' · 伴元' : ' · 你') + '</span>' +
          '</div>';
      }).join('') + '</div>'
        : emptyBoxSmall('时间线还空着', '每一次你确认的复盘，都会在这里留一笔。'));

    $('growthBody').innerHTML = html;
  }

  function reviewCard(r) {
    const draft = r.status === 'draft';
    return '<div class="review-card' + (draft ? ' is-draft' : '') + '">' +
      '<div class="review-head">' +
      '<span class="tag' + (draft ? ' is-warm' : '') + '">' + esc(r.period) + '</span>' +
      '<span class="review-status">' + (draft ? '待你确认' : '已确认') + '</span>' +
      '<span class="mini-actions"><button class="mini-btn" type="button" data-edit-review="' + esc(r.id) + '" aria-label="编辑复盘">' + icon('edit', 13) + '</button></span>' +
      '</div>' +
      '<p class="review-line"><b>事实</b>' + esc(r.factual || '—') + '</p>' +
      '<p class="review-line"><b>感受</b>' + esc(r.reflection || '—') + '</p>' +
      '<p class="review-line"><b>建议</b>' + esc(r.aiSuggestions || '—') + '</p>' +
      (draft ? '<div class="review-actions"><button class="btn btn-xs is-primary" type="button" data-confirm-review="' + esc(r.id) + '">确认写进成长</button></div>' : '') +
      '</div>';
  }

  function skillCard(s) {
    const verified = s.validationStatus === 'verified';
    return '<div class="skill-card">' +
      '<div class="skill-head"><span class="tag' + (verified ? '' : ' is-warm') + '">' + (verified ? '已验证' : '候选') + '</span>' +
      '<span class="skill-title">' + esc(s.title) + '</span></div>' +
      '<p class="skill-body">' + esc(s.steps) + '</p>' +
      (s.risks ? '<div class="skill-foot">注意：' + esc(s.risks) + '</div>' : '') +
      '</div>';
  }

  function reviewModal(r) {
    const isEdit = !!r;
    openModal({
      title: isEdit ? '编辑复盘' : '写一条复盘',
      ok: isEdit ? '保存修改' : '存为草稿',
      body:
        '<div class="field"><label for="revPeriod">日期</label><input id="revPeriod" class="input" type="date" value="' + esc(isEdit ? r.period : todayISO(0)) + '"></div>' +
        '<div class="field"><label for="revFact">事实（发生了什么）</label><textarea id="revFact" class="input input-area" maxlength="200" placeholder="只写发生的事，不加评价">' + esc(isEdit ? r.factual : '') + '</textarea></div>' +
        '<div class="field"><label for="revFeel">感受（你怎么想）</label><textarea id="revFeel" class="input input-area" maxlength="160" placeholder="可以写「还行」「有点累」这种真话">' + esc(isEdit ? r.reflection : '') + '</textarea></div>' +
        '<div class="field"><label for="revSug">下一步建议</label><textarea id="revSug" class="input input-area" maxlength="160" placeholder="可选：下次可以怎么试">' + esc(isEdit ? r.aiSuggestions : '') + '</textarea></div>' +
        '<p class="page-note">先存草稿；确认之后才写进成长时间线。</p>',
      onSubmit: function () {
        const period = $('revPeriod').value || todayISO(0);
        const factual = $('revFact').value.trim();
        if (!factual) { toast('事实至少要写一句'); return false; }
        const payload = {
          period: period,
          factual: factual,
          reflection: $('revFeel').value.trim(),
          aiSuggestions: $('revSug').value.trim(),
        };
        if (isEdit) {
          STORE.patch('reviews', r.id, payload);
          toast('复盘已更新');
        } else {
          payload.status = 'draft';
          STORE.add('reviews', payload);
          STORE.logEvent('review_add', { period: period });
          toast('已存为草稿，确认后才写进成长');
        }
        renderGrowth();
      },
    });
  }

  /* ---------------- 领养 ---------------- */

  let obLook = 'classic';

  function obShowStep(n) {
    document.querySelectorAll('#onboarding .ob-step').forEach(function (s) {
      s.classList.toggle('is-active', Number(s.getAttribute('data-step')) === n);
    });
    document.querySelectorAll('#onboarding .ob-dot').forEach(function (d) {
      d.classList.toggle('is-active', Number(d.getAttribute('data-step-dot')) <= n);
    });
  }

  function openOnboarding() {
    const el = $('onboarding');
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    obShowStep(1);
    window.setTimeout(function () { const o = $('obOwner'); if (o) o.focus(); }, 320);
  }

  function closeOnboarding() {
    const el = $('onboarding');
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
  }

  function finishOnboarding() {
    const owner = $('obOwner').value.trim() || '主人';
    const pet = $('obPet').value.trim() || '叮当';
    STORE.adopt({ ownerName: owner, petName: pet, look: obLook || 'classic' });
    applyProfile();
    renderMemory();
    renderGoal();
    renderGrowth();
    closeOnboarding();
    switchView('chat');
    toast('领养完成，' + pet + ' 在');
    celebrate();
  }

  function applyProfile() {
    const p = STORE.profile();
    if (!p) return;
    $('petName').textContent = p.petName;
    document.documentElement.style.setProperty('--pet-filter', LOOK_FILTERS[p.look] || 'none');
  }

  /* ============================ 11. 会话操作 ============================ */

  function switchSession(id) {
    if (!id || id === state.activeId) { closeDrawer('left'); return; }
    if (state.sending) { toast(petName() + '还在回复，稍等一下再切换会话'); return; }
    state.activeId = id;
    renderSessions();
    renderChat();
    closeDrawer('left');
  }

  function createSession() {
    const id = 'n' + Date.now();
    state.sessions.unshift({
      id: id,
      title: '新的陪伴',
      summary: '还没有开始，慢慢说就好',
      time: '刚刚',
      dateLabel: '今天 · 新的一段',
      pinned: false,
      unread: 0,
      messages: [],
    });
    state.activeId = id;
    state.search = '';
    $('sessionSearch').value = '';
    renderSessions();
    renderChat();
    closeDrawer('left');
    window.setTimeout(function () { $('input').focus(); }, 320);
    toast('开了一个新的会话，我在');
  }

  /* ============================ 12. 启动 ============================ */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(fallback);
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  function init() {
    state.sessions = clone(MOCK.sessions);
    state.activeId = state.sessions[0].id;
    state.config = loadConfig();

    renderQuickbar();
    renderTopics();
    renderSessions();
    renderChat();
    renderProvGrid();
    syncSettingsForm();
    bindEvents();

    if (STORE.isAdopted()) {
      applyProfile();
      renderMemory();
      renderGoal();
      renderGrowth();
      switchView('chat');
    } else {
      renderMemory();
      renderGoal();
      renderGrowth();
      switchView('chat');
      openOnboarding();
    }

    applyModeTag();
    refreshSend();
    autosize();

    window.setTimeout(function () { scrollBottom(); }, 120);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
