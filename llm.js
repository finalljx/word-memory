import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  timeoutMs: 45000,
};

/**
 * 读取配置。优先级：环境变量 > config.json > 默认值。
 * 支持的 config.json 结构：
 *   { "deepseek": { "apiKey": "...", "baseUrl": "...", "model": "..." } }
 * 或扁平写法：
 *   { "apiKey": "...", "baseUrl": "...", "model": "..." }
 */
export function loadAiConfig(rootDir = process.cwd()) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  } catch {
    fileCfg = {};
  }
  const nested = fileCfg.deepseek && typeof fileCfg.deepseek === 'object' ? fileCfg.deepseek : fileCfg;

  const apiKey = String(process.env.DEEPSEEK_API_KEY || nested.apiKey || '').trim();
  const baseUrl = String(process.env.DEEPSEEK_BASE_URL || nested.baseUrl || DEFAULTS.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  const model = String(process.env.DEEPSEEK_MODEL || nested.model || DEFAULTS.model).trim();

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || nested.timeoutMs || DEFAULTS.timeoutMs),
    enabled: Boolean(apiKey),
  };
}

const SYSTEM_PROMPT = `你是中国小学五年级英语单词卡的编写助手。给定一个英文单词和已知信息，补齐缺失字段。

硬性规则：
1. 读者是 10-11 岁中文母语孩子，英语水平为小学五年级。
2. enDef（英文解释）：只用孩子已会的简单词，一句话，不超过 10 个词，必须能据它判断真假。例：salty → "tasting of salt"；boring → "not interesting at all"。
3. chunks：2 个常用词块，整块可用，不用生僻搭配。
4. hook（主钩）：只给 1 个，以【类型】开头，类型取 谐音 / 构词 / 图像 / 动作 / 对比 / 场景 之一，必须写清"为什么挂得上"，不能只给一个联想词。用谐音时必须补一句"只借声音，读音仍按音标"。
5. family（词族）：1-3 项，含派生词、近义或反义；超出五年级范围的标"拓展"。
6. example：一句五年级能读懂的例句，不超过 12 个词。
7. extracts：2 个提取题，中英混合，例："看「咸的」写英文"、"用英文说一句今天发生的事"。
8. ipa 用英式音标，带斜杠，如 /ˈsɔːlti/；syllables 用「sal · ty（2 拍，重音在前）」格式；pos 用 n. / v. / adj. / adv. / prep.。
9. 已有值的字段不要改动，原样返回。
10. 只输出一个 JSON 对象，不要解释、不要代码块围栏。键固定为：
ipa, pos, cn, enDef, syllables, chunks, hook, altHook, family, example, extracts, synonyms, antonyms
其中 chunks、extracts 是字符串数组，其余是字符串。没有内容的字段给空字符串。`;

function buildPrompt(word, known, missing) {
  return `单词：${word}
${known.cn ? `已知中文：${known.cn}` : ''}
${known.pos ? `已知词性：${known.pos}` : ''}
${missing.includes('cn') ? '中文意思也缺失，请补一个该年级最常用的义项。' : ''}

需要补齐的字段：${missing.join(', ')}

只返回 JSON。`;
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型没有返回 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function clamp(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function toStringArray(v, maxItems = 4) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function statusError(status) {
  if (status === 401) return 'API key 无效（401）';
  if (status === 402) return '账户余额不足（402）';
  if (status === 429) return '请求太频繁（429），稍后再试';
  return `DeepSeek 接口返回 ${status}`;
}

async function chat(cfg, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.6,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(statusError(res.status));
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('DeepSeek 接口超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 只补齐缺失字段，不覆盖已有内容 */
export async function enrichWord(cfg, word, known = {}, missing = []) {
  const content = await chat(cfg, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(word, known, missing) },
  ]);
  const data = extractJson(content);

  const out = {
    ipa: clamp(data.ipa, 60),
    pos: clamp(data.pos, 20),
    cn: clamp(data.cn, 80),
    enDef: clamp(data.enDef, 160),
    syllables: clamp(data.syllables, 120),
    chunks: toStringArray(data.chunks, 3),
    hook: clamp(data.hook, 300),
    altHook: clamp(data.altHook, 300),
    family: clamp(data.family, 200),
    example: clamp(data.example, 200),
    extracts: toStringArray(data.extracts, 3),
    synonyms: clamp(data.synonyms, 80),
    antonyms: clamp(data.antonyms, 80),
  };
  return out;
}

/** 用 GET /models 做一次不花 token 的连通性检查 */
export async function testConnection(cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: statusError(res.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '连接超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}
