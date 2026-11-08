import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECKS } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'words.db');

// 莱特纳记忆箱：箱号即「下次间隔」的天数索引
export const BOX_DAYS = [0, 1, 2, 4, 7, 15];
const DAY = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000; // 没记住：1 分钟后可再练

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  story TEXT,
  scene TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT
);
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  ipa TEXT NOT NULL,
  pos TEXT,
  cn TEXT NOT NULL,
  en_def TEXT NOT NULL,
  syllables TEXT,
  chunks TEXT NOT NULL DEFAULT '[]',
  hook TEXT NOT NULL,
  alt_hook TEXT,
  family TEXT,
  example TEXT,
  extracts TEXT NOT NULL DEFAULT '[]',
  synonyms TEXT,
  antonyms TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(deck_id, word)
);
CREATE TABLE IF NOT EXISTS progress (
  word_id INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  box INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  last_result INTEGER,
  last_reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  remembered INTEGER NOT NULL,
  mode TEXT NOT NULL,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(due_at);
CREATE INDEX IF NOT EXISTS idx_reviews_word ON reviews(word_id);
CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck_id);
`;

let db = null;

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {}
  db = null;
}

export function isValidDbFile(filePath) {
  let probe = null;
  try {
    probe = new DatabaseSync(filePath);
    const names = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    return ['decks', 'words', 'progress'].every((t) => names.includes(t));
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {}
  }
}

/**
 * 用外部 .db 文件替换当前数据库。会先备份旧库，失败时自动回滚。
 */
export function replaceDbFromFile(srcPath) {
  if (!isValidDbFile(srcPath)) throw new Error('这不是有效的词卡备份文件');

  closeDb();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.bak-${stamp}`;
  let hadOld = false;
  try {
    fs.copyFileSync(DB_PATH, backupPath);
    hadOld = true;
  } catch {}

  for (const ext of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(DB_PATH + ext);
    } catch {}
  }

  fs.copyFileSync(srcPath, DB_PATH);

  try {
    return getDb();
  } catch (e) {
    if (hadOld) {
      closeDb();
      fs.copyFileSync(backupPath, DB_PATH);
      getDb();
    }
    throw e;
  }
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  migrateDeckColumns(db);
  migrateWordUniqueness(db);
  seed(db);
  return db;
}

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(progress)').all().map((c) => c.name);
  if (!cols.includes('wrong_count')) {
    db.exec('ALTER TABLE progress ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0');
  }
}

function migrateDeckColumns(db) {
  const cols = db.prepare('PRAGMA table_info(decks)').all().map((c) => c.name);
  if (!cols.includes('last_opened_at')) {
    db.exec('ALTER TABLE decks ADD COLUMN last_opened_at TEXT');
  }
}

function migrateWordUniqueness(db) {
  const indexes = db.prepare('PRAGMA index_list(words)').all();
  let hasGlobalUnique = false;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const quoted = String(idx.name).replace(/'/g, "''");
    const cols = db
      .prepare(`PRAGMA index_info('${quoted}')`)
      .all()
      .map((c) => c.name);
    if (cols.length === 1 && cols[0] === 'word') hasGlobalUnique = true;
  }
  if (!hasGlobalUnique) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE words_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      ipa TEXT NOT NULL,
      pos TEXT,
      cn TEXT NOT NULL,
      en_def TEXT NOT NULL,
      syllables TEXT,
      chunks TEXT NOT NULL DEFAULT '[]',
      hook TEXT NOT NULL,
      alt_hook TEXT,
      family TEXT,
      example TEXT,
      extracts TEXT NOT NULL DEFAULT '[]',
      synonyms TEXT,
      antonyms TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      UNIQUE(deck_id, word)
    )`);
    db.exec(`INSERT INTO words_new
      (id, deck_id, word, ipa, pos, cn, en_def, syllables, chunks, hook, alt_hook, family, example, extracts, synonyms, antonyms, sort)
      SELECT id, deck_id, word, ipa, pos, cn, en_def, syllables, chunks, hook, alt_hook, family, example, extracts, synonyms, antonyms, sort
      FROM words`);
    db.exec('DROP TABLE words');
    db.exec('ALTER TABLE words_new RENAME TO words');
    db.exec('CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck_id)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON;');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('[migrate] words 的唯一约束从 word 改为 (deck_id, word)');
}

function seed(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM words').get().n;
  if (n > 0) return;
  const now = new Date().toISOString();
  const insDeck = db.prepare(
    'INSERT INTO decks (id, title, subtitle, story, scene, sort) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insWord = db.prepare(`
    INSERT INTO words
      (deck_id, word, ipa, pos, cn, en_def, syllables, chunks, hook, alt_hook, family, example, extracts, synonyms, antonyms, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insProg = db.prepare('INSERT INTO progress (word_id, box, due_at) VALUES (?, 0, ?)');

  db.exec('BEGIN');
  try {
    DECKS.forEach((deck, di) => {
      insDeck.run(deck.id, deck.title, deck.subtitle ?? '', deck.story ?? '', deck.scene ?? '', di);
      deck.words.forEach((w, wi) => {
        const r = insWord.run(
          deck.id,
          w.word,
          w.ipa,
          w.pos ?? '',
          w.cn,
          w.enDef,
          w.syllables ?? '',
          JSON.stringify(w.chunks ?? []),
          w.hook,
          w.altHook ?? '',
          w.family ?? '',
          w.example ?? '',
          JSON.stringify(w.extracts ?? []),
          w.synonyms ?? '',
          w.antonyms ?? '',
          wi
        );
        insProg.run(r.lastInsertRowid, now);
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function parseJson(s, fallback) {
  try {
    return JSON.parse(s ?? '');
  } catch {
    return fallback;
  }
}

export function toCard(r) {
  return {
    id: r.id,
    word: r.word,
    ipa: r.ipa,
    pos: r.pos,
    cn: r.cn,
    enDef: r.en_def,
    syllables: r.syllables,
    chunks: parseJson(r.chunks, []),
    hook: r.hook,
    altHook: r.alt_hook,
    family: r.family,
    example: r.example,
    extracts: parseJson(r.extracts, []),
    synonyms: r.synonyms,
    antonyms: r.antonyms,
    deckId: r.deck_id,
    progress: {
      box: r.box ?? 0,
      dueAt: r.due_at,
      total: r.total ?? 0,
      correct: r.correct ?? 0,
      wrongCount: r.wrong_count ?? 0,
      lastResult: r.last_result,
      lastReviewedAt: r.last_reviewed_at,
    },
  };
}

const CARD_SELECT = `
  SELECT w.*, p.box, p.due_at, p.total, p.correct, p.wrong_count, p.last_result, p.last_reviewed_at
  FROM words w JOIN progress p ON p.word_id = w.id
`;

export function listDecks(db) {
  return db
    .prepare('SELECT id, title, subtitle, story, scene, sort, last_opened_at FROM decks ORDER BY sort')
    .all()
    .map((d) => ({
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      story: d.story,
      scene: d.scene,
      sort: d.sort,
      lastOpenedAt: d.last_opened_at,
      total: db.prepare('SELECT COUNT(*) AS n FROM words WHERE deck_id = ?').get(d.id).n,
    }));
}

export function touchDeck(db, deckId) {
  db.prepare('UPDATE decks SET last_opened_at = ? WHERE id = ?').run(new Date().toISOString(), deckId);
}

export function renameDeck(db, id, title) {
  const t = String(title || '').trim();
  if (!t) throw fail('词库名不能为空', 'INVALID');
  db.prepare('UPDATE decks SET title = ? WHERE id = ?').run(t, id);
}

export function saveDeckStory(db, id, story, scene) {
  db.prepare('UPDATE decks SET story = ?, scene = ? WHERE id = ?').run(story, scene, id);
}

export function deleteDeck(db, id) {
  db.prepare('DELETE FROM decks WHERE id = ?').run(id);
}

export function getOverview(db) {
  return listDecks(db).map((d) => ({
    ...d,
    stats: getStats(db, d.id),
    words: getWords(db, d.id).map((w) => ({
      id: w.id,
      word: w.word,
      cn: w.cn,
      box: w.progress.box,
      wrongCount: w.progress.wrongCount,
    })),
  }));
}

export function getWords(db, deckId) {
  return db
    .prepare(`${CARD_SELECT} WHERE w.deck_id = ? ORDER BY w.sort`)
    .all(deckId)
    .map(toCard);
}

export function getWord(db, wordId) {
  const r = db.prepare(`${CARD_SELECT} WHERE w.id = ?`).get(wordId);
  return r ? toCard(r) : null;
}

export function getQueue(db, deckId, limit = 50, exclude = []) {
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `${CARD_SELECT} WHERE w.deck_id = ? AND p.due_at <= ?
       ORDER BY p.box ASC, p.due_at ASC, w.sort`
    )
    .all(deckId, nowIso);
  return rows
    .filter((r) => !exclude.includes(r.id))
    .slice(0, limit)
    .map(toCard);
}

export function applyReview(db, wordId, remembered, mode, elapsedMs = 0) {
  const row = db.prepare('SELECT * FROM progress WHERE word_id = ?').get(wordId);
  if (!row) return null;
  const now = new Date();
  const hard = (row.wrong_count || 0) >= 2;
  const box = remembered ? Math.min(row.box + 1, hard ? 3 : BOX_DAYS.length - 1) : 0;
  const delay = remembered ? BOX_DAYS[box] * DAY : RETRY_MS;
  const due = new Date(now.getTime() + delay).toISOString();

  db.prepare(
    `UPDATE progress
     SET box = ?, due_at = ?, streak = ?, total = ?, correct = ?, wrong_count = ?, last_result = ?, last_reviewed_at = ?
     WHERE word_id = ?`
  ).run(
    box,
    due,
    remembered ? row.streak + 1 : 0,
    row.total + 1,
    row.correct + (remembered ? 1 : 0),
    remembered ? row.wrong_count : row.wrong_count + 1,
    remembered ? 1 : 0,
    now.toISOString(),
    wordId
  );

  db.prepare(
    'INSERT INTO reviews (word_id, remembered, mode, elapsed_ms, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wordId, remembered ? 1 : 0, mode, elapsedMs, now.toISOString());

  return db.prepare('SELECT * FROM progress WHERE word_id = ?').get(wordId);
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function getStats(db, deckId) {
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT p.box, p.due_at, p.total, p.wrong_count, p.last_result FROM progress p
       JOIN words w ON w.id = p.word_id ${deckId ? 'WHERE w.deck_id = ?' : ''}`
    )
    .all(...(deckId ? [deckId] : []));

  const boxes = [0, 0, 0, 0, 0, 0];
  let mastered = 0;
  let learning = 0;
  let fresh = 0;
  let due = 0;
  let wrong = 0;
  for (const r of rows) {
    boxes[r.box] = (boxes[r.box] || 0) + 1;
    if (r.total === 0) fresh++;
    else if (r.box >= 4) mastered++;
    else learning++;
    if (r.due_at <= nowIso) due++;
    if (r.wrong_count > 0 || r.last_result === 0) wrong++;
  }

  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const revs = db
    .prepare(
      `SELECT r.remembered, r.created_at FROM reviews r
       JOIN words w ON w.id = r.word_id
       WHERE r.created_at >= ? ${deckId ? 'AND w.deck_id = ?' : ''}`
    )
    .all(...(deckId ? [since, deckId] : [since]));

  const today = localDate(new Date());
  const todays = revs.filter((r) => localDate(new Date(r.created_at)) === today);
  const todayCorrect = todays.filter((r) => r.remembered).length;

  return {
    total: rows.length,
    wrong,
    mastered,
    learning,
    fresh,
    due,
    boxes,
    todayReviews: todays.length,
    todayCorrect,
    accuracy: todays.length ? Math.round((todayCorrect / todays.length) * 100) : null,
  };
}

export function resetProgress(db, deckId) {
  const now = new Date().toISOString();
  if (deckId) {
    db.prepare(
      `UPDATE progress SET box = 0, due_at = ?, streak = 0, total = 0, correct = 0,
       last_result = NULL, last_reviewed_at = NULL
       WHERE word_id IN (SELECT id FROM words WHERE deck_id = ?)`
    ).run(now, deckId);
    db.prepare(
      'DELETE FROM reviews WHERE word_id IN (SELECT id FROM words WHERE deck_id = ?)'
    ).run(deckId);
  } else {
    db.prepare(
      `UPDATE progress SET box = 0, due_at = ?, streak = 0, total = 0, correct = 0,
       last_result = NULL, last_reviewed_at = NULL`
    ).run(now);
    db.prepare('DELETE FROM reviews').run();
  }
}


/* ---------------- 词条管理 ---------------- */

const WORD_FIELDS = {
  word: 'word',
  ipa: 'ipa',
  pos: 'pos',
  cn: 'cn',
  enDef: 'en_def',
  syllables: 'syllables',
  hook: 'hook',
  altHook: 'alt_hook',
  family: 'family',
  example: 'example',
  synonyms: 'synonyms',
  antonyms: 'antonyms',
};

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function normWord(input) {
  const w = {};
  for (const key of Object.keys(WORD_FIELDS)) w[key] = String(input?.[key] ?? '').trim();
  w.chunks = Array.isArray(input?.chunks)
    ? input.chunks.map((c) => String(c).trim()).filter(Boolean)
    : [];
  w.extracts = Array.isArray(input?.extracts)
    ? input.extracts.map((c) => String(c).trim()).filter(Boolean)
    : [];
  return w;
}

export function createWord(db, deckId, data, opts = {}) {
  const w = normWord(data);
  if (!w.word) throw fail('单词不能为空', 'INVALID');
  if (!w.cn && !opts.allowEmptyCn) throw fail('中文不能为空', 'INVALID');
  if (db.prepare('SELECT id FROM words WHERE deck_id = ? AND word = ?').get(deckId, w.word)) {
    throw fail(`「${w.word}」已经在这个词库里了`, 'DUPLICATE');
  }
  if (!db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId)) {
    throw fail('词库不存在', 'NO_DECK');
  }
  const maxSort = db
    .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM words WHERE deck_id = ?')
    .get(deckId).m;

  const r = db
    .prepare(
      `INSERT INTO words
        (deck_id, word, ipa, pos, cn, en_def, syllables, chunks, hook, alt_hook, family, example, extracts, synonyms, antonyms, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      deckId,
      w.word,
      w.ipa,
      w.pos,
      w.cn,
      w.enDef,
      w.syllables,
      JSON.stringify(w.chunks),
      w.hook,
      w.altHook,
      w.family,
      w.example,
      JSON.stringify(w.extracts),
      w.synonyms,
      w.antonyms,
      maxSort + 1
    );

  db.prepare('INSERT INTO progress (word_id, box, due_at) VALUES (?, 0, ?)').run(
    r.lastInsertRowid,
    new Date().toISOString()
  );
  return getWord(db, r.lastInsertRowid);
}

export function updateWord(db, id, data) {
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(WORD_FIELDS)) {
    if (key in (data || {})) {
      sets.push(`${col} = ?`);
      vals.push(String(data[key] ?? '').trim());
    }
  }
  if ('chunks' in (data || {})) {
    sets.push('chunks = ?');
    vals.push(JSON.stringify((data.chunks || []).map(String).filter(Boolean)));
  }
  if ('extracts' in (data || {})) {
    sets.push('extracts = ?');
    vals.push(JSON.stringify((data.extracts || []).map(String).filter(Boolean)));
  }
  if (!sets.length) return getWord(db, id);

  if ('word' in data) {
    const row = db.prepare('SELECT deck_id FROM words WHERE id = ?').get(id);
    const dup = db
      .prepare('SELECT id FROM words WHERE deck_id = ? AND word = ? AND id <> ?')
      .get(row?.deck_id, data.word, id);
    if (dup) throw fail(`「${data.word}」已经在这个词库里了`, 'DUPLICATE');
  }
  vals.push(id);
  db.prepare(`UPDATE words SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getWord(db, id);
}

export function deleteWord(db, id) {
  db.prepare('DELETE FROM words WHERE id = ?').run(id);
}

function parseLine(line) {
  let s = String(line ?? '').trim();
  s = s.replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s*/, '');
  if (!s || s.startsWith('#')) return null;

  let parts;
  if (/[|｜\t]/.test(s)) {
    parts = s.split(/\s*[|｜\t]\s*/);
  } else if (/[,，]/.test(s)) {
    const raw = s.split(/\s*[,，]\s*/);
    parts = [raw[0], raw[1] ?? '', raw.slice(2).join('，')];
  } else if (/\s{2,}/.test(s)) {
    parts = s.split(/\s{2,}/);
  } else if (/^[A-Za-z][A-Za-z'’ .\-]*$/.test(s)) {
    // 只写了英文：中文和其余字段留给 AI 补
    return { word: s, cn: '', enDef: '' };
  } else {
    return { error: `「${s}」不是英文单词，也不是「单词 | 中文」格式` };
  }

  parts = parts.map((p) => p.trim());
  if (!parts[0] || !parts[1]) return { error: `「${s}」格式不对，至少要有：单词 | 中文` };
  return { word: parts[0], cn: parts[1], enDef: (parts[2] ?? '').trim() };
}

/**
 * 批量导入。同一个词库里已存在的词做「更新」而不是跳过，
 * 所以同一份词表重复粘贴不会报错，只会把新信息补进去。
 */
export function importWords(db, deckId, payload, opts = {}) {
  const result = { added: 0, updated: 0, skipped: 0, errors: [], ids: [] };
  const allowEmptyCn = Boolean(opts.aiEnabled);
  let items = [];

  if (Array.isArray(payload)) {
    items = payload;
  } else {
    const lines = String(payload || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    items = lines.map(parseLine).filter(Boolean);
  }

  for (const item of items) {
    if (item.error) {
      result.skipped++;
      result.errors.push(item.error);
      continue;
    }

    if (!item.cn && !allowEmptyCn) {
      result.skipped++;
      result.errors.push(`「${item.word}」只有英文，配置 DeepSeek 后才能自动补中文`);
      continue;
    }

    const existing = db
      .prepare('SELECT id FROM words WHERE deck_id = ? AND word = ?')
      .get(deckId, item.word);

    if (existing) {
      const patch = { word: item.word };
      // 只写英文 = 让 AI 重新生成中文，所以把旧的中文清空
      if (item.cn) patch.cn = item.cn;
      else if (allowEmptyCn) patch.cn = '';
      if (item.enDef) patch.enDef = item.enDef;
      for (const key of ['ipa', 'pos', 'syllables', 'hook', 'altHook', 'family', 'example', 'synonyms', 'antonyms']) {
        if (item[key]) patch[key] = item[key];
      }
      if (Array.isArray(item.chunks) && item.chunks.length) patch.chunks = item.chunks;
      if (Array.isArray(item.extracts) && item.extracts.length) patch.extracts = item.extracts;
      try {
        updateWord(db, existing.id, patch);
        result.updated++;
        result.ids.push(existing.id);
      } catch (e) {
        result.skipped++;
        result.errors.push(e.message);
      }
      continue;
    }

    try {
      const created = createWord(db, deckId, item, { allowEmptyCn });
      result.added++;
      if (created) result.ids.push(created.id);
    } catch (e) {
      result.skipped++;
      result.errors.push(e.message);
    }
  }

  return result;
}

export function createDeck(db, title) {
  const t = String(title || '').trim();
  if (!t) throw fail('词库名不能为空', 'INVALID');
  const id = `d${Date.now().toString(36)}`;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM decks').get().m;
  db.prepare('INSERT INTO decks (id, title, subtitle, story, scene, sort) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    t,
    '自建词库',
    '',
    '',
    maxSort + 1
  );
  return id;
}

export function getWrongWords(db, deckId) {
  const filter = deckId ? 'AND w.deck_id = ?' : '';
  const rows = db
    .prepare(
      `${CARD_SELECT} WHERE (p.wrong_count > 0 OR p.last_result = 0) ${filter}
       ORDER BY p.wrong_count DESC, p.last_result ASC, w.sort`
    )
    .all(...(deckId ? [deckId] : []));
  const titles = Object.fromEntries(db.prepare('SELECT id, title FROM decks').all().map((d) => [d.id, d.title]));
  return rows.map((r) => ({ ...toCard(r), deckTitle: titles[r.deck_id] || r.deck_id }));
}

export function resetWord(db, id) {
  db.prepare(
    `UPDATE progress SET box = 0, due_at = ?, streak = 0, total = 0, correct = 0,
     wrong_count = 0, last_result = NULL, last_reviewed_at = NULL WHERE word_id = ?`
  ).run(new Date().toISOString(), id);
}

export function clearWrong(db, deckId) {
  if (deckId) {
    db.prepare(
      `UPDATE progress SET wrong_count = 0, last_result = NULL
       WHERE word_id IN (SELECT id FROM words WHERE deck_id = ?)`
    ).run(deckId);
  } else {
    db.prepare('UPDATE progress SET wrong_count = 0, last_result = NULL').run();
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pickOne(list, nowIso) {
  const due = list.filter((w) => w.progress.dueAt <= nowIso);
  const bag = due.length ? due : list;
  return bag[Math.floor(Math.random() * bag.length)];
}

export function makeQuiz(db, deckId, type = 'choice', exclude = [], only = []) {
  const nowIso = new Date().toISOString();
  const all = db
    .prepare(`${CARD_SELECT} WHERE w.deck_id = ? ORDER BY w.sort`)
    .all(deckId)
    .map(toCard);

  const ready = all.filter((w) => w.cn);
  const base = ready.length >= 2 ? ready : all;
  const scope = only.length ? base.filter((w) => only.includes(w.id)) : base;

  // 例句填空：只挑例句里真的包含该词的词
  if (type === 'cloze') {
    const eligible = scope.filter(
      (w) => w.example && new RegExp(escapeRe(w.word), 'i').test(w.example)
    );
    const remaining = eligible.filter((w) => !exclude.includes(w.id));
    if (!eligible.length) {
      type = 'spell';
    } else if (!remaining.length) {
      return { done: true, total: eligible.length };
    } else {
      const pick = pickOne(remaining, nowIso);
      const sentence = pick.example.replace(new RegExp(escapeRe(pick.word), 'i'), '_____');
      return {
        type: 'cloze',
        wordId: pick.id,
        sentence,
        cn: pick.cn,
        ipa: pick.ipa,
        pos: pick.pos,
        total: eligible.length,
        remaining: remaining.length,
      };
    }
  }

  const remaining = scope.filter((w) => !exclude.includes(w.id));
  if (!remaining.length) {
    return { done: true, total: scope.length };
  }
  const pick = pickOne(remaining, nowIso);

  if (type === 'spell') {
    return {
      type: 'spell',
      wordId: pick.id,
      prompt: pick.cn,
      ipa: pick.ipa,
      syllables: pick.syllables,
      pos: pick.pos,
      answer: pick.word,
      total: scope.length,
      remaining: remaining.length,
    };
  }

  const promptType = Math.random() < 0.5 ? 'word' : 'def';
  const others = shuffle(base.filter((w) => w.id !== pick.id)).slice(0, 3);
  const options = shuffle(
    [pick, ...others].map((w) => ({
      key: w.id,
      text: promptType === 'word' ? w.cn : w.word,
    }))
  );

  return {
    type: 'choice',
    wordId: pick.id,
    promptType,
    prompt: promptType === 'word' ? pick.word : pick.enDef,
    ipa: promptType === 'word' ? pick.ipa : '',
    pos: promptType === 'word' ? pick.pos : '',
    options,
    total: scope.length,
    remaining: remaining.length,
  };
}

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z' -]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function answerQuiz(db, wordId, type, answer) {
  const w = getWord(db, wordId);
  if (!w) return null;
  const correct =
    type === 'choice' ? Number(answer) === Number(wordId) : normalize(answer) === normalize(w.word);
  const progress = applyReview(db, wordId, correct, type === 'choice' ? 'choice' : 'spell', 0);
  return {
    correct,
    answer: w.word,
    cn: w.cn,
    ipa: w.ipa,
    example: w.example,
    hook: w.hook,
    progress,
  };
}
