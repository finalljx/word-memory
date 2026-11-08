import http from 'node:http';
import fsSync from 'node:fs';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDb,
  listDecks,
  getWords,
  getWord,
  getQueue,
  applyReview,
  getStats,
  resetProgress,
  makeQuiz,
  answerQuiz,
  createWord,
  updateWord,
  deleteWord,
  importWords,
  createDeck,
  getWrongWords,
  resetWord,
  clearWrong,
  touchDeck,
  renameDeck,
  deleteDeck,
  getOverview,
  isValidDbFile,
  replaceDbFromFile,
  saveDeckStory,
} from './db.js';
import { loadAiConfig, enrichWord, testConnection, generateStory } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4610;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const reEscape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function missingWordsInStory(story, words) {
  const lower = String(story).toLowerCase();
  return words
    .filter((w) => !new RegExp(`(^|[^a-z])${reEscape(w.word.toLowerCase())}([^a-z]|$)`).test(lower))
    .map((w) => w.word);
}

async function handleApi(req, res, url) {
  const db = getDb();
  const { pathname, searchParams } = url;
  const deckId = searchParams.get('deck') || 'taste';

  if (req.method === 'GET' && pathname === '/api/state') {
    touchDeck(db, deckId);
    return json(res, 200, {
      deckId,
      decks: listDecks(db),
      words: getWords(db, deckId),
      stats: getStats(db, deckId),
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/backup/export') {
    const tmp = path.join(os.tmpdir(), `wm-export-${Date.now()}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const stat = fsSync.statSync(tmp);
      const name = `word-memory-${new Date().toISOString().slice(0, 10)}.db`;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const stream = fsSync.createReadStream(tmp);
      stream.pipe(res);
      stream.on('close', () => fsSync.unlink(tmp, () => {}));
    } catch (e) {
      fsSync.unlink(tmp, () => {});
      return json(res, 500, { error: '导出失败：' + e.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/backup/import') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) return json(res, 413, { error: '文件太大（上限 200MB）' });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return json(res, 400, { error: '没有收到文件' });

    const tmp = path.join(os.tmpdir(), `wm-import-${Date.now()}.db`);
    fsSync.writeFileSync(tmp, buf);
    try {
      if (!isValidDbFile(tmp)) {
        return json(res, 400, { error: '这不是词卡导出的 .db 备份文件' });
      }
      replaceDbFromFile(tmp);
      const decks = listDecks(getDb());
      return json(res, 200, {
        ok: true,
        decks: decks.length,
        words: decks.reduce((n, d) => n + d.total, 0),
        deckList: decks,
      });
    } finally {
      fsSync.unlink(tmp, () => {});
    }
  }

  if (req.method === 'GET' && pathname === '/api/overview') {
    return json(res, 200, { decks: getOverview(db) });
  }

  if (req.method === 'GET' && pathname === '/api/queue') {
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 100);
    const exclude = (searchParams.get('exclude') || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
    const items = getQueue(db, deckId, limit, exclude);
    return json(res, 200, { items, stats: getStats(db, deckId) });
  }

  if (req.method === 'POST' && pathname === '/api/review') {
    const body = await readBody(req);
    const wordId = Number(body.wordId);
    if (!wordId) return json(res, 400, { error: 'wordId required' });
    const progress = applyReview(
      db,
      wordId,
      Boolean(body.remembered),
      String(body.mode || 'flip').slice(0, 20),
      Number(body.elapsedMs) || 0
    );
    return json(res, 200, { progress, stats: getStats(db, deckId) });
  }

  if (req.method === 'GET' && pathname === '/api/ai/status') {
    const cfg = loadAiConfig(__dirname);
    let host = '';
    try {
      host = new URL(cfg.baseUrl).host;
    } catch {}
    return json(res, 200, {
      enabled: cfg.enabled,
      model: cfg.model,
      baseUrl: host,
      hint: cfg.enabled ? '' : '在 config.json 或环境变量 DEEPSEEK_API_KEY 中配置 key',
    });
  }

  if (req.method === 'POST' && pathname === '/api/ai/story') {
    const cfg = loadAiConfig(__dirname);
    if (!cfg.enabled) return json(res, 400, { error: '还没有配置 API key' });
    const body = await readBody(req);
    const words = Array.isArray(body.words)
      ? body.words
          .map((w) => ({ word: String(w?.word || '').trim(), cn: String(w?.cn || '').trim() }))
          .filter((w) => w.word)
          .slice(0, 40)
      : [];
    if (words.length < 2) return json(res, 400, { error: '至少需要 2 个单词' });
    try {
      const { story, scene } = await generateStory(cfg, body.title || '错题本', words);
      return json(res, 200, { story, scene, missing: missingWordsInStory(story, words) });
    } catch (e) {
      return json(res, 502, { error: e.message || '生成失败' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/ai/fill') {
    const cfg = loadAiConfig(__dirname);
    if (!cfg.enabled) return json(res, 400, { error: '还没有配置 API key' });
    const body = await readBody(req);
    const word = String(body.word || '').trim();
    if (!word) return json(res, 400, { error: '先填单词' });
    try {
      const fields = await enrichWord(
        cfg,
        word,
        { cn: body.cn || '', pos: body.pos || '' },
        ['ipa', 'pos', 'cn', 'enDef', 'syllables', 'chunks', 'hook', 'altHook', 'family', 'example', 'extracts', 'synonyms', 'antonyms']
      );
      return json(res, 200, { fields });
    } catch (e) {
      return json(res, 502, { error: e.message || '调用 DeepSeek 失败' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/ai/test') {
    const cfg = loadAiConfig(__dirname);
    if (!cfg.enabled) return json(res, 400, { error: '还没有配置 API key' });
    const result = await testConnection(cfg);
    return json(res, result.ok ? 200 : 502, result);
  }

  if (req.method === 'GET' && pathname === '/api/stats') {
    return json(res, 200, { stats: getStats(db, deckId) });
  }

  if (req.method === 'GET' && pathname === '/api/quiz') {
    const exclude = (searchParams.get('exclude') || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
    const only = (searchParams.get('only') || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
    const typeParam = searchParams.get('type');
    const quiz = makeQuiz(
      db,
      deckId,
      ['spell', 'cloze'].includes(typeParam) ? typeParam : 'choice',
      exclude,
      only
    );
    if (!quiz) return json(res, 404, { error: 'not enough words' });
    return json(res, 200, quiz);
  }

  if (req.method === 'POST' && pathname === '/api/quiz/answer') {
    const body = await readBody(req);
    const answerType = ['spell', 'cloze'].includes(body.type) ? body.type : 'choice';
    const result = answerQuiz(db, Number(body.wordId), answerType, body.answer);
    if (!result) return json(res, 404, { error: 'word not found' });
    return json(res, 200, { ...result, stats: getStats(db, deckId) });
  }

  if (req.method === 'GET' && pathname === '/api/wrong') {
    const onlyDeck = searchParams.get('deck');
    return json(res, 200, { items: getWrongWords(db, onlyDeck || null) });
  }

  if (req.method === 'POST' && pathname === '/api/wrong/clear') {
    const body = await readBody(req);
    clearWrong(db, body.deck || null);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/words') {
    const body = await readBody(req);
    const target = body.deck || deckId;
    try {
      const word = createWord(db, target, body, {
        allowEmptyCn: loadAiConfig(__dirname).enabled,
      });
      return json(res, 201, { word, stats: getStats(db, target) });
    } catch (e) {
      return json(res, e.code === 'DUPLICATE' ? 409 : 400, { error: e.message, code: e.code });
    }
  }

  if (req.method === 'POST' && pathname === '/api/words/import') {
    const body = await readBody(req);
    const target = body.deck || deckId;
    const result = importWords(db, target, body.words ?? body.text ?? '', {
      aiEnabled: loadAiConfig(__dirname).enabled,
    });
    return json(res, 200, { ...result, stats: getStats(db, target) });
  }

  const enrichMatch = pathname.match(/^\/api\/words\/(\d+)\/enrich$/);
  if (req.method === 'POST' && enrichMatch) {
    const cfg = loadAiConfig(__dirname);
    if (!cfg.enabled) {
      return json(res, 400, {
        error: '还没有配置 DeepSeek key：在 config.json 里填 deepseek.apiKey，或设置环境变量 DEEPSEEK_API_KEY',
      });
    }
    const id = Number(enrichMatch[1]);
    const current = getWord(db, id);
    if (!current) return json(res, 404, { error: 'word not found' });

    const missingMap = wordMissingFields(current);
    const missing = Object.keys(missingMap).filter((k) => missingMap[k]);
    if (!missing.length) {
      return json(res, 200, { word: current, filled: [], message: '字段已经齐了' });
    }

    try {
      const filled = await enrichWord(
        cfg,
        current.word,
        { cn: current.cn, pos: current.pos },
        missing
      );
      const patch = {};
      for (const key of missing) {
        const value = filled[key];
        const ok = Array.isArray(value) ? value.length > 0 : Boolean(value);
        if (ok) patch[key] = value;
      }
      if (Object.keys(patch).length) updateWord(db, id, patch);
      return json(res, 200, {
        word: getWord(db, id),
        filled: Object.keys(patch),
        stats: getStats(db, deckId),
      });
    } catch (e) {
      return json(res, 502, { error: e.message || '调用 DeepSeek 失败' });
    }
  }

  const wordMatch = pathname.match(/^\/api\/words\/(\d+)$/);
  if (wordMatch) {
    const id = Number(wordMatch[1]);
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const word = updateWord(db, id, body);
        return json(res, 200, { word, stats: getStats(db, body.deck || deckId) });
      } catch (e) {
        return json(res, e.code === 'DUPLICATE' ? 409 : 400, { error: e.message, code: e.code });
      }
    }
    if (req.method === 'DELETE') {
      deleteWord(db, id);
      return json(res, 200, { ok: true, stats: getStats(db, deckId) });
    }
  }

  const resetMatch = pathname.match(/^\/api\/words\/(\d+)\/reset$/);
  if (req.method === 'POST' && resetMatch) {
    resetWord(db, Number(resetMatch[1]));
    return json(res, 200, { ok: true, stats: getStats(db, deckId) });
  }

  const storyMatch = pathname.match(/^\/api\/decks\/([^/]+)\/story$/);
  if (req.method === 'POST' && storyMatch) {
    const cfg = loadAiConfig(__dirname);
    if (!cfg.enabled) {
      return json(res, 400, { error: '还没有配置 DeepSeek key，无法生成故事' });
    }
    const id = decodeURIComponent(storyMatch[1]);
    const deck = listDecks(db).find((d) => d.id === id);
    if (!deck) return json(res, 404, { error: '词库不存在' });
    const words = getWords(db, id);
    if (words.length < 2) return json(res, 400, { error: '至少要有 2 个单词才能编故事' });

    try {
      const { story, scene } = await generateStory(cfg, deck.title, words);
      saveDeckStory(db, id, story, scene);
      return json(res, 200, { story, scene, missing: missingWordsInStory(story, words) });
    } catch (e) {
      return json(res, 502, { error: e.message || '生成失败' });
    }
  }

  const deckWordsMatch = pathname.match(/^\/api\/decks\/([^/]+)\/words$/);
  if (req.method === 'GET' && deckWordsMatch) {
    const id = decodeURIComponent(deckWordsMatch[1]);
    const deck = listDecks(db).find((d) => d.id === id);
    if (!deck) return json(res, 404, { error: '词库不存在' });
    return json(res, 200, {
      deck: { id: deck.id, title: deck.title },
      words: getWords(db, id),
    });
  }

  const deckMatch = pathname.match(/^\/api\/decks\/([^/]+)$/);
  if (deckMatch) {
    const deckIdParam = decodeURIComponent(deckMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        renameDeck(db, deckIdParam, body.title);
        return json(res, 200, { decks: listDecks(db) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (req.method === 'DELETE') {
      deleteDeck(db, deckIdParam);
      return json(res, 200, { decks: listDecks(db) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/decks') {
    const body = await readBody(req);
    try {
      const id = createDeck(db, body.title);
      return json(res, 201, { id, decks: listDecks(db) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    const body = await readBody(req);
    resetProgress(db, body.deck || null);
    return json(res, 200, { ok: true, stats: getStats(db, body.deck || null) });
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

function wordMissingFields(w) {
  const hasList = (v) => Array.isArray(v) && v.length > 0;
  return {
    ipa: !w.ipa,
    pos: !w.pos,
    cn: !w.cn,
    enDef: !w.enDef,
    syllables: !w.syllables,
    chunks: !hasList(w.chunks),
    hook: !w.hook,
    altHook: !w.altHook,
    family: !w.family,
    example: !w.example,
    extracts: !hasList(w.extracts),
    synonyms: !w.synonyms,
    antonyms: !w.antonyms,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, decodeURIComponent(url.pathname));
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`词卡 running at http://${HOST}:${PORT}`);
});
