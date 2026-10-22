// 主动刷小红书设置：每日冲浪配额 + 主动找话题（apiVersion 1）
// 安装：聊天设置 → 扩展插件 → 导入插件，选择本文件后启用
// 提示词在 prompt.system 注入；计数在 llm.request 里扫描小红书工具结果，去重后扣减。

const TOOL_NAMES = ['xhs_list_feeds', 'xhs_search'];
// xhs-mcp 成功时正文为「首页推荐共 N 条：」或「搜索结果共 N 条：」
const SUCCESS_RE = /(?:首页推荐|搜索结果)共\s*\d+\s*条/;
const ACTION_RE = /<action_result name="(xhs_list_feeds|xhs_search)"([^>]*)>([\s\S]*?)<\/action_result>/g;
// 本插件注入的提示行：每次请求前先剥掉旧的，再按最新配额重写
const OUR_LINE_RE = /\n*\[(?:今日小红书冲浪剩余配额|今日主动冲浪配额已用完|你们已经有一阵子没聊了|刚才的小红书工具没有成功)[^\]]*\]/g;
const NON_CHAT_MEDIA = ['tool_call', 'tool_result', 'tool_notice', 'system_instruction'];
const USER_REQUEST_WINDOW_MS = 10 * 60 * 1000; // 用户提到关键词后 10 分钟内的调用算用户要求
const IDLE_MIN_GAP_MS = 3 * 60 * 1000;         // 最后一条是角色发的且用户沉默超过 3 分钟 → 角色主动开口
const RETRY_WINDOW_MS = 10 * 60 * 1000;
const SEEN_CAP = 300;
const DEFAULT_LIMIT = 1;
const DEFAULT_KEYWORDS = '小红书,红书,刷一下,刷刷,搜一下,搜搜';

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('\n');
  }
  return '';
}

function timeOf(m) {
  const t = Date.parse(m && m.createdAt);
  return Number.isFinite(t) ? t : 0;
}

// 从请求 messages 里提取小红书浏览/搜索结果（兼容文本协议与原生工具调用两种形态）
function extractXhsResults(messages) {
  const out = [];
  const toolNameById = {};
  for (const m of messages) {
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const n = (tc && tc.function && tc.function.name) || (tc && tc.name);
        if (tc && tc.id && n) toolNameById[tc.id] = n;
      }
    }
  }
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      const name = m.name || toolNameById[m.tool_call_id];
      if (TOOL_NAMES.includes(name)) {
        const body = textOf(m.content);
        out.push({ name, body, ok: SUCCESS_RE.test(body) });
      }
      continue;
    }
    const text = textOf(m.content);
    if (!text.includes('<action_result')) continue;
    ACTION_RE.lastIndex = 0;
    let mm;
    while ((mm = ACTION_RE.exec(text)) !== null) {
      const errored = /\serror="/.test(mm[2]);
      out.push({ name: mm[1], body: mm[3], ok: !errored && SUCCESS_RE.test(mm[3]) });
    }
  }
  return out;
}

// 剥离所有消息里本插件写过的提示行（复制消息对象，不改宿主原数据）；返回是否找到过
function stripOurLines(messages) {
  let found = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (typeof m.content === 'string') {
      const next = m.content.replace(OUR_LINE_RE, '');
      if (next !== m.content) { found = true; messages[i] = { ...m, content: next }; }
    } else if (Array.isArray(m.content)) {
      let changed = false;
      const parts = m.content.map(part => {
        if (part && typeof part.text === 'string') {
          const next = part.text.replace(OUR_LINE_RE, '');
          if (next !== part.text) { changed = true; return { ...part, text: next }; }
        }
        return part;
      });
      if (changed) { found = true; messages[i] = { ...m, content: parts }; }
    }
  }
  return found;
}

// 追加到实际发出的系统提示词末尾（不改原对象，避免污染宿主历史）
function appendSystem(p, text) {
  const first = p.messages[0];
  if (first && first.role === 'system') {
    let content;
    if (typeof first.content === 'string') content = first.content + '\n\n' + text;
    else if (Array.isArray(first.content)) content = [...first.content, { type: 'text', text }];
    else content = text;
    p.messages[0] = { ...first, content };
  } else {
    p.messages.unshift({ role: 'system', content: text });
  }
}

export default {
  manifest: {
    id: 'xhs-proactive-quota',
    name: '主动刷小红书设置',
    apiVersion: 1,
    version: '1.0.1',
    description: '限制角色每天主动刷小红书的次数，配额内引导角色带着新鲜帖子主动找话题',
    permissions: ['chat.read', 'storage', 'ui'],
    settings: [
      { key: 'dailyLimit', label: '每日主动冲浪上限（次）', type: 'number', default: DEFAULT_LIMIT,
        description: '每个角色独立计数，0 点自动重置；当天改大立即生效' },
      { key: 'userKeywords', label: '用户要求关键词', type: 'text', default: DEFAULT_KEYWORDS,
        description: '用户最近一条消息含任一关键词时，本次调用不扣配额（逗号分隔）' },
      { key: 'retryLimit', label: '失败后提示重试次数', type: 'number', default: 2,
        description: '工具没刷出内容时不扣配额，并提示角色再试，最多提示这么多次' },
      { key: 'idleBoost', label: '冷场主动联系时引导先刷小红书', type: 'boolean', default: true },
      { key: 'hardStop', label: '配额用完后明确告知不要主动刷', type: 'boolean', default: false,
        description: '关闭时配额为 0 不注入任何提示；开启会多一句禁止提示，限制更严格' },
    ],
  },

  setup(ctx) {
    const store = ctx.system.storage;
    const num = (key, fallback) => {
      const raw = ctx.system.settings.get(key);
      if (raw === undefined || raw === null || raw === '') return fallback;
      const v = Number(raw);
      return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
    };
    const flag = (key, fallback) => {
      const v = ctx.system.settings.get(key);
      return typeof v === 'boolean' ? v : fallback;
    };
    const dailyLimit = () => num('dailyLimit', DEFAULT_LIMIT);
    const retryLimit = () => num('retryLimit', 2);
    const keywords = () => String(ctx.system.settings.get('userKeywords') ?? DEFAULT_KEYWORDS)
      .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);

    // ── 配额：按「已用 + 手动加减」记账，剩余 = 上限 + bonus − used ──
    function getQuota(charId) {
      const q = store.get('q:' + charId);
      if (!q || q.date !== todayKey()) return { date: todayKey(), used: 0, bonus: 0 };
      return { date: q.date, used: Number(q.used) || 0, bonus: Number(q.bonus) || 0 };
    }
    const saveQuota = (charId, q) => store.set('q:' + charId, q);
    const remaining = (charId) => {
      const q = getQuota(charId);
      return Math.max(0, dailyLimit() + q.bonus - q.used);
    };
    function consume(charId) {
      const q = getQuota(charId);
      q.used += 1;
      saveQuota(charId, q);
      ctx.system.log(`扣减配额：${charId} 今日已用 ${q.used}`);
    }

    // ── 会话 → 角色 ──
    // 单聊会话的 contactId 在宿主里就是角色 id；兼容「联系人 id → 角色 id」的结构作兜底
    function charIdOfSession(s) {
      if (!s || s.isGroup || !s.contactId) return null; // 群聊暂不计数
      if (ctx.data.characters.get(s.contactId)) return s.contactId;
      const contacts = ctx.data.contacts.list();
      const c = contacts.find(x => x.id === s.contactId) || contacts.find(x => x.characterId === s.contactId);
      return c && c.characterId ? c.characterId : null;
    }
    function resolveCharacterId(sessionId) {
      return sessionId ? charIdOfSession(ctx.data.sessions.get(sessionId)) : null;
    }

    // ── 消息判断 ──
    function realMessages(sessionId) {
      if (!sessionId) return [];
      return ctx.data.messages.list(sessionId)
        .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.isRetracted && !NON_CHAT_MEDIA.includes(m.mediaType))
        .sort((a, b) => timeOf(a) - timeOf(b));
    }
    const lastUserOf = (list) => [...list].reverse().find(m => m.role === 'user');

    // 方案 A：用户最近一条消息含关键词 → 用户要求，不扣配额
    function isUserRequested(sessionId) {
      const lastUser = lastUserOf(realMessages(sessionId));
      if (!lastUser || Date.now() - timeOf(lastUser) > USER_REQUEST_WINDOW_MS) return false;
      const text = String(lastUser.content || '');
      return keywords().some(k => text.includes(k));
    }
    // 角色主动开口（冷场重连 / 定时醒来等）：最后一条是角色发的，且用户已沉默一段时间
    function isProactive(sessionId) {
      const list = realMessages(sessionId);
      const last = list[list.length - 1];
      if (!last || last.role !== 'assistant') return false;
      const lastUser = lastUserOf(list);
      return !lastUser || Date.now() - timeOf(lastUser) >= IDLE_MIN_GAP_MS;
    }
    function allowRetry(sessionId) {
      const key = 'retry:' + sessionId;
      const r = store.get(key);
      const now = Date.now();
      const count = r && now - r.at < RETRY_WINDOW_MS ? r.count : 0;
      if (count >= retryLimit()) return false;
      store.set(key, { count: count + 1, at: now });
      return true;
    }

    // 按当前配额生成要注入的提示行
    function buildLines(charId, sessionId, opts) {
      const lines = [];
      if (opts.retry) {
        lines.push('[刚才的小红书工具没有成功返回内容，这次不占用配额，可以换个关键词或再调用一次重试]');
      }
      const rem = remaining(charId);
      if (rem > 0) {
        lines.push(`[今日小红书冲浪剩余配额: ${rem}次，可在闲聊或需要新话题时主动调用小红书工具]`);
        if (flag('idleBoost', true) && !opts.justBrowsed && isProactive(sessionId)) {
          lines.push('[你们已经有一阵子没聊了。主动开口前，优先调用小红书工具刷一下首页推荐或搜你感兴趣的话题，带着刷到的新鲜帖子或梗自然地去找对方聊，不要罗列结果]');
        }
      } else if (flag('hardStop', false)) {
        lines.push('[今日主动冲浪配额已用完：除非用户明确要求，不要主动调用小红书工具]');
      }
      return lines;
    }

    // ── 提示词注入：单聊系统提示词组装时写入（宿主直接给出 characterId）──
    ctx.hooks.transform('prompt.system', (p) => {
      if (p.isGroup) return p;
      const charId = p.characterId || resolveCharacterId(p.sessionId);
      if (!charId) return p;
      const lines = buildLines(charId, p.sessionId, {});
      if (lines.length) p.hint = (p.hint ? p.hint + '\n' : '') + lines.join('\n');
      return p;
    });

    // ── 计数：扫描请求里的小红书工具结果，并把提示行刷新为最新配额 ──
    ctx.hooks.transform('llm.request', (p) => {
      if (!p.sessionId || !Array.isArray(p.messages)) return p;
      const charId = resolveCharacterId(p.sessionId);
      if (!charId) return p;

      const seenArr = store.get('seen');
      const seen = new Set(Array.isArray(seenArr) ? seenArr : []);
      const initedArr = store.get('inited');
      const inited = new Set(Array.isArray(initedArr) ? initedArr : []);
      // 首次接管某会话：历史里已有的结果只登记、不扣次数
      const firstTime = !inited.has(p.sessionId);

      let newResults = 0;
      let newFailure = false;
      for (const r of extractXhsResults(p.messages)) {
        const key = hashText(p.sessionId + '|' + r.name + '|' + r.body);
        if (seen.has(key)) continue;
        seen.add(key);
        if (firstTime) continue;
        newResults += 1;
        if (!r.ok) newFailure = true;                            // 失败/空结果不扣
        else if (!isUserRequested(p.sessionId)) consume(charId); // 只扣角色主动的成功调用
      }
      store.set('seen', [...seen].slice(-SEEN_CAP));
      if (firstTime) {
        inited.add(p.sessionId);
        store.set('inited', [...inited].slice(-500));
      }

      // 先剥掉 prompt.system 写入的旧提示行，再按扣减后的最新配额重写；
      // 既不是聊天主请求、也没带过本插件提示的请求（摘要等）不动
      const hadLines = stripOurLines(p.messages);
      if (!hadLines && p.purpose !== 'chat') return p;
      const retry = newFailure && allowRetry(p.sessionId);
      const lines = buildLines(charId, p.sessionId, { retry, justBrowsed: newResults > 0 });
      if (lines.length) appendSystem(p, lines.join('\n'));
      return p;
    });

    // ── 设置区：各角色今日用量与手动调整（每 5 秒自动刷新）──
    ctx.ui.slot('settings.section', (el) => {
      const render = () => {
        el.replaceChildren();
        el.style.cssText = 'display:flex;flex-direction:column;gap:8px;font-size:13px;padding:10px 16px 0;';

        const title = document.createElement('div');
        title.textContent = `今日配额（每日上限 ${dailyLimit()} 次，0 点自动重置）`;
        title.style.cssText = 'font-weight:600;';
        el.appendChild(title);

        const ids = [...new Set(ctx.data.sessions.list().map(charIdOfSession).filter(Boolean))];

        if (!ids.length) {
          const empty = document.createElement('div');
          empty.textContent = '还没有单聊角色';
          empty.style.opacity = '.6';
          el.appendChild(empty);
          return;
        }

        for (const id of ids) {
          const ch = ctx.data.characters.get(id);
          const name = (ch && ch.name) || '未命名角色';
          const q = getQuota(id);

          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
          const label = document.createElement('span');
          label.style.cssText = 'flex:1;min-width:140px;';
          label.textContent = `${name}：今日已主动刷 ${q.used} 次 · 剩余 ${remaining(id)} 次${q.bonus ? `（手动 ${q.bonus > 0 ? '+' : ''}${q.bonus}）` : ''}`;
          row.appendChild(label);

          const mkBtn = (text, aria, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.setAttribute('aria-label', aria);
            b.style.cssText = 'padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer;';
            b.addEventListener('click', () => { fn(); render(); });
            row.appendChild(b);
          };
          mkBtn('+1', `给${name}增加 1 次今日配额`, () => { const x = getQuota(id); x.bonus += 1; saveQuota(id, x); });
          mkBtn('−1', `给${name}减少 1 次今日配额`, () => { const x = getQuota(id); x.bonus -= 1; saveQuota(id, x); });
          mkBtn('重置', `重置${name}的今日用量`, () => saveQuota(id, { date: todayKey(), used: 0, bonus: 0 }));
          el.appendChild(row);
        }
      };
      render();
      const offSettings = ctx.system.settings.onChange(render);
      const offTimer = ctx.system.timers.setInterval(render, 5000);
      return () => { offSettings(); offTimer(); };
    });
  },
};
