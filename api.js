/* ==========================================================================
   api.js · 模型接入层（唯一网络出入口）
   --------------------------------------------------------------------------
   国产主流模型全部走 OpenAI 兼容协议：
     POST {base}/chat/completions   （stream: true 时为 SSE 流）
     GET  {base}/models             （用于连通性测试 / 模型自动匹配）
   浏览器直连受厂商 CORS 策略影响，失败时给出明确的原因提示并回落到演示对话。
   API Key 只保存在本机 localStorage，仅在测试与对话时随请求发送，不上传到任何第三方。
   ========================================================================== */
window.API = (function () {
  'use strict';

  /* ---------- 厂商与默认端点（切换厂商即自动填充） ---------- */
  const PROVIDERS = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      tag: '深度求索',
      base: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      keyHint: 'API Key 以 sk- 开头',
    },
    {
      id: 'qwen',
      name: '通义千问',
      tag: '阿里云百炼',
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
      keyHint: '百炼平台 API Key，形如 sk-xxx',
    },
    {
      id: 'glm',
      name: '智谱 GLM',
      tag: 'BigModel',
      base: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
      keyHint: '形如 xxxxxxxx.xxxxxxxx 的密钥',
    },
    {
      id: 'kimi',
      name: 'Kimi',
      tag: '月之暗面',
      base: 'https://api.moonshot.cn/v1',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      keyHint: 'Moonshot 平台 API Key',
    },
    {
      id: 'doubao',
      name: '豆包',
      tag: '火山方舟',
      base: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['doubao-pro-32k', 'doubao-lite-32k'],
      keyHint: '模型名需填方舟「接入点 ID」（形如 ep-xxxx）',
    },
    {
      id: 'custom',
      name: '自定义',
      tag: 'OpenAI 兼容',
      base: '',
      models: [],
      keyHint: '任何 OpenAI 兼容端点，可填代理地址',
    },
  ];

  const TIMEOUT = 20000;

  function trimBase(base) {
    return String(base || '').trim().replace(/\/+$/, '');
  }

  function abortAfter(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ms);
    return { signal: ctrl.signal, clear: function () { clearTimeout(timer); } };
  }

  function friendlyError(err, res) {
    if (err && err.name === 'AbortError') return '请求超时（20 秒），请检查网络或接口地址';
    if (res) {
      if (res.status === 401 || res.status === 403) return '鉴权失败（HTTP ' + res.status + '）：API Key 无效或没有该模型权限';
      if (res.status === 404) return '接口地址不存在（HTTP 404）：请检查 Base URL 是否需要带上 /v1';
      if (res.status === 429) return '请求过于频繁或额度不足（HTTP 429）';
      if (res.status >= 500) return '厂商服务异常（HTTP ' + res.status + '），稍后再试';
      return '接口返回异常（HTTP ' + res.status + '）';
    }
    if (err && (err.name === 'TypeError' || /fetch|Failed/i.test(String(err.message || ''))) ) {
      return '无法发起请求：可能是浏览器跨域（CORS）限制或网络不可达，可改用自建代理地址';
    }
    return '连接失败：' + String((err && err.message) || err || '未知错误');
  }

  /* ---------- 连通性测试 ----------
     先试 GET /models（顺带拿到可用模型列表，用于"自动匹配"）；
     若该端点不支持，再用一次极小的 chat 请求兜底验证。 */
  async function testConnection(cfg) {
    const base = trimBase(cfg.base);
    if (!base) return { ok: false, message: '请先填写 Base URL' };
    if (!cfg.key) return { ok: false, message: '请先填写 API Key' };
    if (!cfg.model) return { ok: false, message: '请先填写模型名称' };

    const started = performance.now();
    const guard = abortAfter(TIMEOUT);
    const headers = {
      Authorization: 'Bearer ' + cfg.key.trim(),
      'Content-Type': 'application/json',
    };

    try {
      const res = await fetch(base + '/models', { method: 'GET', headers: headers, signal: guard.signal });
      const latency = Math.round(performance.now() - started);

      if (res.ok) {
        let models = [];
        try {
          const data = await res.json();
          models = (data && data.data || []).map(function (m) { return m.id; }).filter(Boolean);
        } catch (e) { /* 部分端点 /models 返回非 JSON，忽略 */ }
        guard.clear();
        return { ok: true, latency: latency, models: models, message: '已连通 · ' + (models.length ? '读取到 ' + models.length + ' 个模型' : '端点可访问') };
      }

      // /models 不支持（404/405）时，用最小 chat 请求验证
      if (res.status === 404 || res.status === 405) {
        guard.clear();
        return await pingChat(cfg, started);
      }

      guard.clear();
      return { ok: false, latency: latency, message: friendlyError(null, res) };
    } catch (err) {
      guard.clear();
      return { ok: false, message: friendlyError(err, null) };
    }
  }

  async function pingChat(cfg, started) {
    const guard = abortAfter(TIMEOUT);
    try {
      const res = await fetch(trimBase(cfg.base) + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + cfg.key.trim(),
          'Content-Type': 'application/json',
        },
        signal: guard.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false,
        }),
      });
      const latency = Math.round(performance.now() - started);
      if (!res.ok) {
        guard.clear();
        return { ok: false, latency: latency, message: friendlyError(null, res) };
      }
      const data = await res.json();
      guard.clear();
      if (!data || !data.choices) {
        return { ok: false, latency: latency, message: '返回结构不符合 OpenAI 兼容格式' };
      }
      return { ok: true, latency: latency, models: [], message: '已连通 · 模型可正常返回内容' };
    } catch (err) {
      guard.clear();
      return { ok: false, message: friendlyError(err, null) };
    }
  }

  /* ---------- 流式对话 ----------
     onDelta(chunk) 收到增量文本；返回完整文本 */
  async function streamChat(cfg, messages, onDelta) {
    const guard = abortAfter(TIMEOUT * 3);
    let res;
    try {
      res = await fetch(trimBase(cfg.base) + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + cfg.key.trim(),
          'Content-Type': 'application/json',
        },
        signal: guard.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          temperature: Number(cfg.temp) || 0.7,
          stream: true,
        }),
      });
    } catch (err) {
      guard.clear();
      throw new Error(friendlyError(err, null));
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch (e) { /* noop */ }
      guard.clear();
      throw new Error(friendlyError(null, res) + (detail ? '｜' + detail : ''));
    }
    if (!res.body) {
      guard.clear();
      throw new Error('当前浏览器不支持流式响应');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let finished = false;

    while (!finished) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { finished = true; break; }
        try {
          const json = JSON.parse(payload);
          const choice = json.choices && json.choices[0];
          const delta = choice && choice.delta && choice.delta.content;
          if (delta) { full += delta; onDelta(delta); }
        } catch (e) { /* 忽略不完整分片 */ }
      }
    }

    guard.clear();
    if (!full) throw new Error('模型没有返回内容，请检查模型名称是否正确');
    return full;
  }

  return {
    PROVIDERS: PROVIDERS,
    testConnection: testConnection,
    streamChat: streamChat,
    provider: function (id) {
      for (let i = 0; i < PROVIDERS.length; i++) {
        if (PROVIDERS[i].id === id) return PROVIDERS[i];
      }
      return PROVIDERS[0];
    },
  };
})();
