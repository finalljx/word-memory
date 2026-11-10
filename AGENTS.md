# AGENTS.md

给后续接手这个仓库的人 / agent 的项目说明。先读这一页，需要改 LLM 再看 [docs/llm.md](docs/llm.md)。

## 项目是什么

一个给小学五年级（中文母语）用的英语单词记忆 Web 应用：翻转自测 + 间隔复习 + 三种自测题型 + AI 补词/编故事 + 打印。Node.js 单进程，SQLite 落盘，前端原生 JS，无构建步骤、无 npm 依赖。

## 跑起来

```bash
node server.js          # 需要 Node ≥ 22.5（内置 node:sqlite）
# http://127.0.0.1:4610
PORT=5000 node server.js
```

macOS 普通用户走双击：`启动词卡.command`（前台）、`制作桌面图标.command`（生成桌面 App）、`停止词卡.command`。脚本会检查 Node 版本、端口占用，并自动开浏览器；`scripts/serve-bg.sh` 里做了 PATH 兜底，因为 AppleScript 启动时 PATH 很短。

验证改动的基本顺序：

1. `node --check server.js && node --check db.js && node --check llm.js && node --check public/app.js`
2. `curl localhost:4610/api/state?deck=taste`
3. 涉及 UI 时用无头 Chrome 截图（见「测试」）

## 目录

```
server.js     零依赖 HTTP 服务：静态文件 + 全部 /api 路由
db.js         SQLite 建表 / 迁移 / 种子 / 查询 / 复习算法 / 出题
llm.js        DeepSeek 客户端 + 提示词 + 三个能力（补词/故事/连通性）
seed.js       两个内置词库（首次建库时写入）
public/       index.html · style.css · app.js（单页，hash 路由）
docs/llm.md   LLM 模块详细说明
config.example.json  AI 配置模板
data/words.db 运行时数据库（.gitignore）
```

## 数据模型

| 表 | 关键列 |
|---|---|
| `decks` | `id, title, story, scene, sort, last_opened_at` |
| `words` | 14 个单词卡字段 + `deck_id, sort`，唯一约束 `(deck_id, word)` |
| `progress` | `word_id, box, due_at, streak, total, correct, wrong_count, last_result, last_reviewed_at` |
| `reviews` | 每次复习流水：`word_id, remembered, mode, elapsed_ms, created_at` |

迁移函数在 `db.js` 顶部（`migrate` / `migrateDeckColumns` / `migrateWordUniqueness`），启动时自动跑，老库可以直接升级。

## 核心机制

- **记忆箱**：`BOX_DAYS = [0,1,2,4,7,15]` 天；记住进一箱，没记住回第 0 箱并 1 分钟后可再练
- **难词**：`wrong_count >= 2` 的词记忆箱封顶第 3 箱（4 天），学习卡标「难词」
- **错词本**：全词库共享，`wrong_count > 0 || last_result = 0`
- **全对闯关**：一轮错词进下一轮，直到某轮零错
- **自测**：`choice / spell / cloze` 三种题型，一轮内用 `exclude` 去重，全部过完给成绩单
- **学习队列**：`GET /api/queue` 按 `box asc, due_at asc` 取到期词
- **模式**：全局 `S.mode = all | wrong`，学习与自测共用；`wrong` 时学习队列是筛选后的错词，自测传 `scope=wrong` + `since` / `wrongDeck`

## LLM

- 配置在 `config.json` 或环境变量，**每次请求重新读取**（改完刷新页面即可）
- 出网只在 `llm.js` 的 `chat()`，全部要求 `response_format: json_object`
- **最重要的不变量：只补空字段，绝不覆盖用户手写内容**
- key 只在服务端，任何路由都不透传
- 模型输出一律当不可信数据：校验类型 → 截断长度 → 再入库

路由、提示词、错误码、stub 测法、加新能力的步骤，全部在 [docs/llm.md](docs/llm.md)。

## 前端结构（public/app.js）

单文件、无框架，全局状态对象 `S`：

| 字段 | 含义 |
|---|---|
| `deckId / decks / words / stats` | 当前词库与数据 |
| `queue / i / revealed / wrong` | 学习队列与进度 |
| `peek / reviewLog` | 学习页回看：正在看的旧卡下标、每张卡的评分记录 |
| `mastery / round / roundWrong` | 闯关 |
| `mode` | 全局模式：`all` / `wrong`（学习、自测共用） |
| `quiz / quizType / quizSeen / quizWrong / quizScore` | 自测一轮的状态 |
| `quizHistory / quizPos / quizReview` | 自测回看：题目历史、当前下标、是否在回看 |
| `ai / wrongWords / overview` | AI 状态、全局错词、词库总览 |
| `wordQuery / wordPage`、`deckQuery / deckPage` | 管理页单词搜索/分页、词库页搜索/分页 |
| `print / printBack` | 打印预览 |

主要渲染函数：`renderCard`（学习卡）、`renderQuiz`、`renderStats`、`renderAdmin`、`renderDecksPage`、`renderPrintSheet`。

视图通过 `switchView(name)` 切换，hash 路由：`#quiz` `#stats` `#admin` `#decks` `#print/deck/<id>` `#print/wrong`。

## 接口一览

```
GET  /api/state?deck=       GET  /api/queue?deck=&exclude=
GET  /api/overview          GET  /api/stats?deck=
POST /api/review            GET  /api/quiz?deck=&type=choice|spell|cloze&exclude=&only=
POST /api/quiz/answer       GET  /api/wrong
POST /api/words             PUT/DELETE /api/words/:id
POST /api/words/:id/enrich  POST /api/words/:id/reset
POST /api/words/import      POST /api/wrong/clear
POST /api/decks   PATCH/DELETE /api/decks/:id   GET /api/decks/:id/words
POST /api/decks/:id/story   GET  /api/backup/export   POST /api/backup/import
```

## 约定

- 文案统一中文，语气平实，不用感叹号堆情绪
- 新增字段先想清楚「空值语义」，AI 补词依赖「空 = 待补」
- 改表结构必须写迁移，且能对已有 `data/words.db` 平滑升级
- 打印走 `@media print`，页面里只保留 `#print-overlay`，别把新元素漏进去
- 学习页要求一屏不滚动：改布局后至少在 1440×900 / 1366×768 / 390×844 下量一次

## 测试

- 接口：`curl` 直接打，注意 AI 相关用**临时 `DB_PATH`**，不要在线上库上试
- UI：无头 Chrome 截图 + `--dump-dom` 断言，例如

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1340,1000 --virtual-time-budget=7000 \
  --screenshot=/tmp/shot.png "http://127.0.0.1:4610/#admin"
```

- 注意无头 Chrome 的窗口最小宽度是 500，模拟手机要用 390px 宽的 iframe
- 截图偶发「旧画面」，加 `--run-all-compositor-stages-before-draw` 或延时

## 已知坑

- `node:sqlite` 是实验特性，升级 Node 时先跑一遍冒烟
- 数据库是 WAL 模式，直接拷 `.db` 时最好连同 `-wal/-shm` 一起，或走「导出数据」
- 导入备份会覆盖数据库，代码里已做「先备份再替换 + 失败回滚」，别绕过
- 前端 `esc()` 必须用在所有模型/用户内容上，打印和卡片都在拼接 HTML
