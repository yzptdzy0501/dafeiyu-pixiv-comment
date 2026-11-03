# 更新日志

用人话记每个版本改了什么 —— 面向使用者，不是开发笔记。

## 1.1.0 — 2026-11-03

评语现在有了自己的去处：本机的一个小网页，不用再翻 jsonl。

- **新增：本地评论墙**。插件自带 `tools/comment-wall.mjs`，只监听 `127.0.0.1`，
  默认地址 <http://127.0.0.1:7878/>。每条评语写完会 `POST` 过去，网页按时间倒序排成卡片，
  带作品标题 / 画师 / 分级徽章 / 原作品链接；数据落在 `$DSH_HOME/pixiv-comment/wall/comments.jsonl`。
- **三个新配置**：`wallEnabled`（同步开关，默认开）、`wallAutoStart`（插件启动时顺手拉起，默认开）、
  `wallUrl`（地址，端口被占就换，例如 `http://127.0.0.1:7879`）。
  设置页多了「本地评论墙」一栏，带「打开评论墙」「重新拉起」两个按钮和实时状态。
- **推不过去不影响评论**：墙没开 / 端口不通时 `pixivc_comment` 仍成功，只在回执里带
  `wall: { ok:false, error }`，不会让整轮失败。
- **幂等**：同 id + 同文本在 10 分钟内重复推送会被认成重复跳过，重试安全。
- **接口**：`GET /`（页面）、`GET /api/comments?limit=&q=`、`POST /api/comments`、`GET /api/health`。
- 自检从 115 项加到 130 项（配置键、wall.mjs 导出、地址回落、服务端关键实现）。

## 1.0.0 — 2026-11-03

从刷图插件 `dsh-pixiv-scroll` 1.2.0 里**拆出来的评论专用版**。底座（登录 / Python MCP / 代理 / 精选表）
原样保留，只做评论，不保存作品。

- **新增：独立的评论插件**。设置 → **评论Pixiv** →「现在评论一批」，
  起一个只做评论的子会话：找作品 → 看图/读小说 → 写一句中文评语。
- **删掉了保存链路**：没有 `pixivc_save` 工具，没有「保存到哪 / 目录模板 / 自动打开文件夹」，
  没有刷图提示词，没有 `/run` 接口。评论模式下就算模型想存也没工具可用。
- **额度**：`commentPerRun`（每次最多几条，默认 5，1–20）+ `commentPerDay`
  （每天最多几条，默认 20，0 = 不限），按 `comments.jsonl` 当天条数实时算。
- **精选表 `favorites.jsonl`**：值得再看的作品连同**标题 / 画师 / 网址 / 分数 / 理由 / 评语**记一行，
  按 id 收敛（高分那条胜），超 600 行压实到最近 300 行。
  配了 `credentialHome` 时会**镜像一份**给刷图插件，那边的【优先候选】直接吃到。
- **共用登录态**：新增 `credentialHome`。refresh_token 每次刷新都轮换，
  两个插件各存一份会互相踢下线 —— 指到刷图插件家目录就只维护一份。
- **工具 16 个 `pixivc_*`**（与刷图版的 `pixiv_*` 不撞名，两个插件可以同时装）：
  status / login_status / search / inspect / prepare / novel_outline / novel_read / novel_pick /
  novel_vibe / seen / report / tag_suggest / comment / comments / favorite / favorites。
- **修：模型请求超时**。子会话固定 `NODE_OPTIONS=--dns-result-order=ipv4first`，
  并**明确不**把模型请求塞进本地代理（实测代理节点对 `你的模型接口域名` 的 TLS 握手会失败，
  整轮 `dsh: TRANSPORT: Connection error`；直连 + IPv4 优先首次 4.3 s、之后 0.3 s）。
  Pixiv 的代理由 MCP 子进程自己带，互不影响。
- **改：评语只谈画面**。章程新增两条：不写性化描写（成人向作品也只说画得如何）；
  遇到不想评的作品就**跳过换下一件**，不要因此结束整轮。
- **改：精选是必做动作**。一轮里至少记 1–2 件进精选表，不再是「可选」。

## 上游历史与致谢

本插件的**思路来源**和**代码底本**都是大肥鱼的
[`kuroshio4396/dafayu-pixiv-duty`](https://github.com/kuroshio4396/dafayu-pixiv-duty)
（包名 `dsh-pixiv-scroll` 1.1.3，「让 deepseek 自己刷蓝P」那套插件：宿主半端 + headless 子会话 +
内置 Python MCP + 设置面板 + `duty.md` 章程）—— 玩法、插件骨架、章程写法都来自它，刷图版也一样。

血统是两条接力：`dafayu-pixiv-duty`（1.1.3，直接底本）→ 刷图版 `dsh-pixiv-scroll` 1.2.0（本仓库的母本）
→ 本仓库（把「评论」这条支线单独拆出来，保存作品那条链路整条拿掉）。
底本自己是从 [`c1overzz/dsh-bili-scroll`](https://github.com/c1overzz/dsh-bili-scroll)（MIT）**借的架构**，
隔了两层，只是架构参考，**不是本仓库的代码底本**。更早的更新日志留在上游仓库里，本仓库从「评论」这条线往下走。

谢谢上游作者的铺路。
