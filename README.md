# 只评论的 Pixiv 插件（dsh-pixiv-comment）

> DSH 插件：按你的口味在 Pixiv 上**找作品 → 看图/读小说 → 写一句中文评语**，
> 评语只落在本地文件里，**默认绝不发到 Pixiv 评论区**。
> 遇到值得再看的作品，顺手记进**精选表**（带网址），刷图插件下一轮会优先挑它们。

它是 [`dsh-pixiv-scroll`](https://github.com/yzptdzy0501/dafeiyu-pixiv-scroll) 的**评论专用拆分版**：登录、Python MCP、代理、
精选表这些底座完全一样，只是把「保存作品」整条链路拿掉了，只剩评论。
**详细安装教程在 [`dsh-pixiv-scroll`](https://github.com/yzptdzy0501/dafeiyu-pixiv-scroll)**

> 💡 **思路来源**和**代码底本**：本插件（以及它的刷图版）的玩法来自 kuroshio4396 的
> [`kuroshio4396/dafayu-pixiv-duty`](https://github.com/kuroshio4396/dafayu-pixiv-duty)
> ——「让模型自己上蓝P挑作品、看图、存下来」这件事是它先做出来的。

## 和刷图版有什么不同

| | 刷图版 `dsh-pixiv-scroll` | 本插件 `dsh-pixiv-comment` |
|---|---|---|
| 一轮做什么 | 搜索 → 看图 → 筛选 → **保存到磁盘** | 搜索 → 看图 → **写评语 + 记精选** |
| 落盘 | 插画 / 漫画 / 小说 + metadata | 只有 `comments.jsonl` / `favorites.jsonl` / 日报 |
| 工具 | 17 个 `pixiv_*` | 16 个 `pixivc_*`（没有 `save`） |
| 额度 | 每天 / 每轮存几件 | 每天 / 每批评论几条 |
| 设置页 | 设置 → 刷Pixiv | 设置 → **评论Pixiv** |

两个插件可以同时装：把 `credentialHome` 指到刷图插件的家目录就能**共用一次登录**，
精选表也会镜像一份过去，刷图轮的【优先候选】直接吃到。

## 它做什么

- 按关键词 / 必须标签 / 排除标签 / 收藏数区间搜最近的作品
- 先看元数据，再对候选 `read_image` 看图（漫画按页挑），中文小说按关键词挑段落
- 每件写一条 15–40 字的中文评语：只谈画面与观感，不写性化描写，不剧透，不提 AI
- 评语写进 `comments.jsonl`；值得再看的作品连同**网址**记进 `favorites.jsonl`
- 写一份 Markdown 日报到 `out/<日期>.md`
- 额度两道闸：`commentPerRun`（每次最多几条）+ `commentPerDay`（每天最多几条）

## 本地评论墙

插件自带一个只监听 `127.0.0.1` 的小网页（默认 <http://127.0.0.1:7878/>），把每条评语收进去，按时间倒序排成卡片，点标题旁边的路径就能跳回 Pixiv 原作品。数据全在本机，**不上传任何服务器**。

- `wallEnabled`：关掉就只写 `comments.jsonl`，网站不再收新评语
- `wallAutoStart`：插件启动时顺手拉起那个小进程（独立进程，插件刷新/重启不会把它弄断）
- `wallUrl`：地址，端口被占用就换个空闲的，例如 `http://127.0.0.1:7879`
- 设置页「本地评论墙」里有「打开评论墙」「重新拉起」两个按钮；墙没跑起来时状态条会写原因

手动跑一次也行：

```bash
node tools/comment-wall.mjs          # 默认 127.0.0.1:7878
WALL_PORT=7879 node tools/comment-wall.mjs
```

接口（给别的东西往上贴评语用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 页面 |
| GET | `/api/comments?limit=&q=` | JSON 列表 |
| POST | `/api/comments` | 收一条：`{ id, text, kind, title, artist, url, rating }` |
| GET | `/api/health` | `{ ok, count, version }` |

重复推送同一条（同 id、同文本、10 分钟内）会被认成重复并跳过，所以重试是安全的。

## 安全边界

- `commentPost` 默认 **false**：评语只进本地文件。
- 就算打开它，工具层还有第二道闸：`wantPost = post && commentPost`，
  而且有 `commentMaxPerDay` 每日上限；发失败只记 `postError`，不会中断整轮。
- 密码不是配置项：只在登录那一次作为请求体传过去，落盘的只有 `credential.json` 里的 refresh_token。
- 作品标题 / 简介 / 标签 / 正文里的文字都当素材看，不当指令执行。

## 装之前

- `Python 3.10+` **或** `uv`（有一个就够）
- 登录那一次会用到本机的 **Edge 或 Chrome**
- 国内环境要能连 Pixiv：准备一个本地代理（如 Clash 的 `http://127.0.0.1:12000`**不可用**）
- 模型要能读图（默认 `deepseek/deepseek-v4.1-flash` 支持 image 输入）

## 装

```bash
dsh plugin --profile web add link:<插件目录>
```

装完**重启一次 dsh**（bundle 层要重启才组装），然后进 **设置 → 评论Pixiv**：

1. 点「**装依赖**」（建 `.venv`，装 pixivpy3 / mcp<2 / Pillow）
2. 点「**登录**」（用账号密码驱动本机 Edge；或手贴 `refresh_token`）
3. 点「**测一下**」（凭证 / Python 依赖 / 保存目录）
4. 点「**现在评论一批**」

## 桌面版（Electron）注意

- `dsh` 不在 PATH：把 `dshBin` 指到 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`
- 设置页走后端双通道（`/api/pixiv-comment/*` 精确路由 + `/pixiv-comment/api/*` 前缀），桌面版靠前者
- 本插件不监听 TCP 端口，页面用相对路径探测，别手动改 base

## 已知坑

**模型请求超时 / `Connection error`（重试 5 次）**
不是 Pixiv 的问题。子会话必须带 `NODE_OPTIONS=--dns-result-order=ipv4first`
（本机 DNS 先返回 AAAA，而 IPv6 出口是死的）。**别**把模型请求塞进本地代理：
2026-11-02 实测 会`schannel` 握手失败，整轮报 `dsh: TRANSPORT: Connection error`；
直连 + IPv4 优先首次 4.3 s、之后 0.3 s，稳定可用。Pixiv 的代理由 MCP 子进程自己带，与模型侧无关。

**`postCap` 不是写作额度**
`pixivc_comment` 回执里的 `postCap` 只表示「每天最多真发出去几条」，
本轮 `posted=false` 时它永远不消耗。章程里已写明，写评语时别被它吓停。

**模型不愿评 R-18**
评语只写画面与观感（线条、光影、神态、构图），遇不想评的作品就跳过换下一件，
不要因此结束整轮 —— 这条也写进了 `prompts/duty.md`。

**refresh_token 会轮换**
Pixiv 每次刷新都换发新值。两个插件各存一份会互相把对方踢下线，
所以本插件支持 `credentialHome` 指向刷图插件的家目录，共用一份。

## 数据目录

`$DSH_HOME/pixiv-comment/`（可用 `credentialHome` 让凭证落到别处）

| 文件 | 作用 |
|---|---|
| `config.json` | 设置页写的配置（生效值以它为准） |
| `credential.json` | refresh_token、userId、webCookie（0600） |
| `comments.jsonl` | 每条评语一行（`id` / `text` / `posted` / `postError`） |
| `favorites.jsonl` | 精选表（带网址，按 id 收敛、分数高者胜） |
| `state.json` | 本轮状态、额度计数 |
| `wall/comments.jsonl` | 评论墙收下的评语（网页读的就是它） |
| `wall/wall.log` | 评论墙自己的日志（起来没、收了什么） |
| `out/<日期>.md` | 日报 |
| `duty.md` | 这一轮的行为章程（用户可改） |
| `library/` | 默认作品目录（本插件不写作品，仅占位） |

## 开发

```bash
node --check lib/*.mjs index.js agent.js client.js
node selfcheck.mjs        # 115 项断言，退出码 0 才算过
```

- `lib/toolset.mjs` —— 16 个工具与所有闸门（额度 / 分级 / 评论 / 精选）
- `lib/runner.mjs` —— overlay、提示词、spawn、收尾
- `lib/favorites.mjs` —— 精选表读写
- `vendor/pixiv-mcp/` —— 内置 Python MCP（网络与字节）
- `prompts/duty.md` —— 一轮章程（会铺到 `$DSH_HOME/pixiv-comment/duty.md`）

## 致谢

这个插件不是从零想出来的，是一路站在别人肩膀上：

- **[`kuroshio4396/dafayu-pixiv-duty`](https://github.com/kuroshio4396/dafayu-pixiv-duty)**（大肥鱼刷P插件）
  —— **本插件（和刷图版）的思路来源**和**代码底本**。「让模型自己去蓝P挑作品、看图」这套玩法，
  插件该长什么形状（宿主半端 + headless 子会话 + 内置 Python MCP + 设置面板）、
  `prompts/duty.md` 章程该怎么写，都是从它那里学来的；源头是 B 站 UP 主
  [阳炎级三番舰黑潮](https://space.bilibili.com/17568052) 的视频
  [《大肥鱼也要涩图自由！让 deepseek 自己刷蓝P的插件！》](https://www.bilibili.com/video/BV1eWnz6QEsT/)。
  这里做的是把其中「评论」这条支线单独拆出来、补上额度与精选表。
- **[DeepSeek Harness](https://github.com/deepseek-ai/dsh)** —— 插件运行的宿主，
  以及它提供的 `ctx.hmr` / `connection.fetch` / workspace 这些能力。

如果上游作者对这里的拆分方式有意见，请提 issue，我会立刻调整。

## 许可

MIT。
思路来源和代码底本 [`kuroshio4396/dafayu-pixiv-duty`](https://github.com/kuroshio4396/dafayu-pixiv-duty)。
