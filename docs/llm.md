# LLM 模块说明

这份文档写给后续接手的人（或 agent）：LLM 接在哪、怎么配、提示词什么规矩、怎么加新能力、怎么在没有 key 的情况下测试。

代码集中在 [llm.js](../llm.js)，路由在 [server.js](../server.js)，前端调用在 [public/app.js](../public/app.js)。

## 1. 哪些功能用了 LLM

| 功能 | 入口 | 服务端路由 | 实现函数 |
|---|---|---|---|
| 补全单词卡字段 | 管理页「AI 补齐」/ 批量录入后自动补 | `POST /api/words/:id/enrich` | `enrichWord()` |
| 新增单词前预填表单 | 弹窗里「AI 补齐」 | `POST /api/ai/fill` | `enrichWord()` |
| 生成情节故事 | 进度页「AI 串联」 | `POST /api/decks/:id/story` | `generateStory()` |
| 连通性检查 | 管理页「测试连接」 | `POST /api/ai/test` | `testConnection()` |
| 状态展示 | 管理页顶部 | `GET /api/ai/status` | `loadAiConfig()` |

## 2. 配置

**优先级：环境变量 > `config.json` > 默认值。**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 没有就视为未启用，所有 AI 路由返回 400 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 可指向任何 OpenAI 兼容网关 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | |
| `DEEPSEEK_TIMEOUT_MS` | `45000` | 单次请求超时，`AbortController` 控制 |

`config.json`（已在 `.gitignore`）两种写法都认：

```json
{ "deepseek": { "apiKey": "sk-...", "baseUrl": "...", "model": "..." } }
{ "apiKey": "sk-..." }
```

**每次请求都会重新读配置**（`loadAiConfig(__dirname)`），所以改完 `config.json` 刷新页面即可，不用重启服务。

## 3. 客户端实现（llm.js）

唯一的出网函数是模块私有的 `chat(cfg, messages)`：

```js
POST {baseUrl}/chat/completions
Authorization: Bearer <key>
{
  model,
  messages,
  temperature: 0.6,
  max_tokens: 1200,
  response_format: { type: 'json_object' }
}
```

- 所有调用都要求**只返回 JSON**，靠 `response_format` + 提示词里「只输出 JSON」双保险
- `extractJson()` 会兜底：去掉 ```` ```json ```` 围栏、截取第一个 `{` 到最后一个 `}` 再 `JSON.parse`
- `clamp()` / `toStringArray()` 对输出做长度截断和类型收敛，模型乱写不会污染数据库
- 超时抛 `DeepSeek 接口超时`；状态码映射见第 8 节

## 4. 三个能力

### 4.1 `enrichWord(cfg, word, known, missing)` → 字段对象

- `word`：英文单词
- `known`：已有信息 `{ cn, pos }`，作为上下文
- `missing`：需要补的字段名数组，提示词里会明确列出

返回固定 13 个键（缺失给空串）：

```js
{
  ipa, pos, cn, enDef, syllables, chunks: [], hook, altHook,
  family, example, extracts: [], synonyms, antonyms
}
```

调用方（`server.js`）**只把原本为空的字段写回**，用户手写的内容永远不会被覆盖。

### 4.2 `generateStory(cfg, deckTitle, words)` → `{ story, scene }`

输入是词库里全部单词（`word` + `cn`），输出一段 150–250 字的中文故事 + 一句画面描述。服务端会检查每个词是否真的出现在故事里，没出现的放进 `missing` 返回给前端提示。

### 4.3 `testConnection(cfg)` → `{ ok, error? }`

走 `GET /models`，不消耗 token，用来验证 key 是否有效。

## 5. 提示词

两段 system prompt 都写死在 `llm.js` 顶部：`SYSTEM_PROMPT`（单词卡）和 `STORY_SYSTEM`（故事）。

单词卡的硬规矩（改提示词时别删）：

1. 读者是 10–11 岁中文母语、小学五年级
2. `enDef` 只用已学词，一句话 ≤10 词，必须能判断真假
3. `hook` 只给 1 个，以【谐音/构词/图像/动作/对比/场景】开头，必须解释「为什么挂得上」
4. 用谐音必须附「只借声音，读音仍按音标」
5. `example` 不超过 12 个词
6. `extracts` 2 个、中英混合
7. 只输出 JSON，键固定

故事的规矩：英文词原样嵌在中文句子里、每个词至少一次、有画面、不写空话。

> 提示词改动后，建议用 `generateStory` / `enrichWord` 各跑一个真实单词验证，别只看代码。

## 6. 路由契约

| 方法 | 路由 | 入参 | 成功响应 | 失败 |
|---|---|---|---|---|
| GET | `/api/ai/status` | — | `{ enabled, model, baseUrl, hint }` | — |
| POST | `/api/ai/test` | — | `{ ok: true }` | 400 未配置 / 502 连接失败 |
| POST | `/api/ai/fill` | `{ word, cn?, pos? }` | `{ fields }`（**不落库**） | 400 / 502 |
| POST | `/api/words/:id/enrich` | — | `{ word, filled: [], stats }` | 400 / 404 / 502 |
| POST | `/api/decks/:id/story` | — | `{ story, scene, missing: [] }` | 400 / 404 / 502 |

`/api/ai/fill` 是唯一的「只读」AI 路由：不写数据库，专门给前端填表单用，方便用户保存前修改。

## 7. 前端调用流程

**单条补全**：弹窗 →「AI 补齐」→ `POST /api/ai/fill` → 把空输入框填上 → 用户改完再保存。

**保存即补全**：只填英文保存 → 创建成功 → `POST /api/words/:id/enrich`。

**批量**：`POST /api/words/import` 返回 `ids[]` → 前端并发 3 个 `enrich`，顶部显示 `AI 补齐中 2/5…` → 全部完成后统一刷新。

**故事**：进度页按钮 → `POST /api/decks/:id/story` → 写回 `decks.story/scene` → 重渲染。

## 8. 错误处理

| 情况 | 返回 |
|---|---|
| 没配 key | 400 `还没有配置 DeepSeek key…` |
| 401 | `API key 无效（401）` |
| 402 | `账户余额不足（402）` |
| 429 | `请求太频繁（429），稍后再试` |
| 超时 | `DeepSeek 接口超时` |
| 模型没给 JSON | `模型没有返回 JSON` |

前端的 `api()` 会优先读响应里的 `error` 字段，直接 toast 出来。

## 9. 没有 key 怎么测

起一个本地假接口，把 `DEEPSEEK_BASE_URL` 指过去：

```js
// /tmp/stub-llm.js
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url.startsWith('/models')) return res.end('{"data":[]}');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        ipa: '/stʌb/', cn: '测试的', enDef: 'a stub word', hook: '【图像】stub',
        syllables: 'stub', chunks: ['a stub'], family: '', example: 'A stub.',
        extracts: ['看中文写英文'], synonyms: '', antonyms: '', pos: 'adj.', altHook: ''
      }) } }]
    }));
  });
}).listen(4620);
```

```bash
node /tmp/stub-llm.js &
DEEPSEEK_API_KEY=sk-test DEEPSEEK_BASE_URL=http://127.0.0.1:4620 \
  DB_PATH=/tmp/test.db PORT=4611 node server.js
```

这样能跑通「补词、批量、故事、错误分支」，不花 token，也不碰真实数据。**测 AI 相关改动时务必用临时 `DB_PATH`**，别在线上库上试。

## 10. 加一个新 AI 能力（五步）

1. 在 `llm.js` 里加一个 `export async function xxx(cfg, ...)`，内部复用 `chat()` + `extractJson()` + `clamp()`
2. 提示词单独写成常量，明确「只输出 JSON」和字段名
3. 在 `server.js` 的 `handleApi` 里加路由：先 `loadAiConfig`，`!enabled` 返回 400，`try/catch` 转 502
4. 前端加按钮 + loading 态 + 错误 toast；长任务显示进度
5. 更新这份文档的路由表和功能表

## 11. 注意

- **key 只在服务端**，任何路由都不把 key 透给前端
- 模型输出一律不可信：先校验类型、再截断长度、最后才入库
- 一次只补「空字段」，不覆盖用户内容——这是这个项目最重要的数据不变量
- `response_format: json_object` 是 DeepSeek 的能力；换别家不支持时，把这行去掉，靠提示词约束
