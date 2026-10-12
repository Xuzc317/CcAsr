# 更新日志

## [未发布]

### 新增 — 测试指南 `TESTING.md`

面向测试人员的完整手册：9 个用例（含必测与补充）、每步都给出**确切文件路径**
与预期结果、问题反馈模板、已知限制清单、以及排障步骤。
测试音频已备好：

```
D:\Project\CcAsr\samples\multi_meeting\会议A-第1段-文档.wav   (19.3 分钟)
D:\Project\CcAsr\samples\multi_meeting\会议A-第2段-网站.wav   (18.0 分钟)
D:\Project\CcAsr\samples\zh_sapi.wav                          (30 秒，冒烟用)
```

### 修复 — 分批上传会把自己挡死（用户可见）

`update_state()` 仅因"存在 pending 录音"就把项目标为 `transcribing`，
而上传接口用该状态做并发保护，导致：

- 用 `start=false` 分批上传时，**第二次上传就返回 409**
  「该项目队列正在运行」—— 而实际上并没有队列在跑
- 提示信息误导，且项目被永久挡住，只能重新建会议
- 界面上的多文件上传也可能因此受影响

修法：把 `transcribing` 的语义明确为**「队列确实在跑」**，
用进程内的 `_queue_running` 集合记录真实运行状态；
有 pending 但未启队列时状态为 `draft`。
同时 `/start` 增加重复启动保护，队列结束后在 `finally` 中清理标志
（否则项目会被永久锁死）。

### 测试 — 新增边界与异常路径套件

`backend/tests/test_edge_cases.py`（28 项断言）覆盖：分批上传、空项目、
内容非音频、不存在资源 404、特殊文件名与导出名净化、重命名。
已纳入 `run_all.py`（现 **6 个套件**）。

### 验证 — 真实 LLM 联调通过

用真实 DeepSeek key 对 37 分钟真实会议（587 段转录）生成纪要：
**15 秒完成，4966→6180 字符**，产出 6 类版式组件 + 5 项待办，
内容确实反映会议实质（分支 0.4/0.5/0.6 对应关系、烧录工具、
网站后台模块、刷机文档等），非空话套话。

对抗性测试 22 项全部通过（409 占用保护、坏音频记录失败而非崩溃、
MD5 去重、特殊文件名、404 语义等）。

### 修复 — 合并文档的编辑在导出/纪要中被丢弃（用户可见）

用户在前端校对文本、给说话人改名后，`PATCH /transcript` 会写入
`projects/{id}/transcript.json`，`GET /transcript` 也能读回。
但 `build_transcript()` **总是从各录音原始结果重新拼装**，导致：

- 导出 TXT / JSON 用的是**未编辑的原始文本**
- 生成会议纪要也基于未编辑文本

即用户的校对成果被**静默丢弃**。现改为优先复用已保存的
`transcript.json`，并保留 `rebuild=True` 用于强制重新拼装。

新增 `backend/tests/test_transcript_editing.py`（19 项断言）覆盖：
改文本、改说话人、保存 `speaker_map`、未知 id 不破坏数据、空请求幂等、
导出反映编辑、不存在项目返回 404。已纳入 `run_all.py`（现 5 个套件）。

### 清理

- 删除死代码 `SummarizeJob`（旧预设式总结的遗留，重构后无任何引用）
- `run_server.py` 注释由「AI 总结功能需要」更正为「会议纪要的 LLM 配置、ASR 路由等」
- `TaskStatus` 补充说明：已被 Project/Recording 取代，保留以兼容旧数据读取

### 修复 — 前端工程文件缺失（严重）

`.gitignore` 第 4 行的 `*.json` **把 `app/package.json` 也忽略了**，
导致仓库里一直**没有前端的 `package.json`**。后果：
克隆本仓库后无法构建前端（`npm install` 会误用默认的 `package.json`，
生成的 `package-lock.json` 对应的是错误的依赖集）。

缺失的 5 个文件（本次补齐）：

| 文件 | 作用 |
|------|------|
| `app/package.json` | 前端依赖与脚本定义（**最关键**） |
| `app/tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | TypeScript 配置，缺了 `tsc -b` 无法运行 |
| `app/package-lock.json` | 依赖锁定 |

同时删除已过期的 `app/pnpm-lock.yaml` —— 它仍引用重构时已移除的
`wavesurfer.js` / `zustand` / `localforage` / `immer`，与当前 `package.json`
不一致，保留会误导使用者。

`.gitignore` 现显式放行前端工程配置（`package.json`、各 `tsconfig*.json`、
lock 文件），并加注释说明为何需要例外。

### 测试 — 全链路验证改为自包含

此前 `test_summary_over_http.py` 需要**人工**以假 LLM 模式启动一个关闭热重载的
后端进程才能跑，不利于回归。新增
`backend/tests/test_summary_e2e_selfcontained.py`：
用 FastAPI `TestClient` 在同进程内跑完整链路，**无需启动服务、无需 API key**。

只替换两处外部依赖（假 ASR、假 LLM），其余全为生产代码：
多文件上传 → 串行队列（真实调度）→ 跨录音说话人统一（真实聚类）→
合并时间轴（真实拼接）→ 自动触发纪要 → `/summary` 响应 → 导出 → 删除。
**26 项断言全部通过**，含"两段录音共用同一套说话人编号"这一核心验收点。

新增 `backend/tests/run_all.py` 一键跑完 4 个后端套件（4/4 通过），
并在 `app/package.json` 加 `test:be` 脚本。

### 新增 — LLM 配置体检（`/health` 暴露）

把「配置写错但不报错、直到生成纪要才失败」变成一眼可见。`GET /health`
新增 `llm` 字段（**不发网络请求**）：

```json
"llm": {
  "ok": false,
  "problems": ["CCASR_LLM_API_KEY 仍是占位符，需填真实 key"],
  "warnings": ["模型名 'deepseek-flash' 不在 api.deepseek.com 的常见列表
                 ['deepseek-chat','deepseek-reasoner'] 中，若调用报「模型不存在」请改这里"],
  "api_base": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "key_set": false,
  "fake": false
}
```

可检出：未填 key / 仍是占位符 / base 缺失或不像 URL / 模型名笔误。
对自建或代理端点（如 Ollama）不误报模型名。测试见
`backend/tests/test_llm_config_check.py`（11 项断言）。

### 修复

- **`requests` 未声明依赖**：`doubao_backend.py` 与测试脚本都 import 了它，
  但 `pyproject.toml` 未列出（仅因环境里恰好装了才没暴露）。已补上。

### 验证 — 纪要全链路（HTTP 层）16/16 通过

补齐此前未覆盖的接缝：**上传 → 串行队列 → 跨录音统一 → 合并 →
自动触发纪要 → `/summary` 响应 → 结构化数据可被前端还原**。

做法：新增 `backend/fake_llm.py`（**仅当 `CCASR_LLM_FAKE=1` 时启用**，
默认关闭，生产环境为零影响的 no-op），在没有真实 API key 的情况下驱动全链路。
假客户端**故意返回脏数据**，用于验证清洗逻辑真的生效：

| 断言 | 结果 |
|---|---|
| 纪要自动完成（无需点按钮） | ✅ |
| `/summary` 返回非空 Markdown | ✅ |
| 结构化注释可被提取 | ✅ |
| 非法类型 `flowchart` 被清洗 | ✅ |
| 缺 items / 空 points 的块被丢弃 | ✅ |
| 六类版式组件齐全（bullets/columns/timeline/steps/table/todo） | ✅ |
| 待办字段归一化（missing → 未指定/未提及） | ✅ |
| 导出纪要 Markdown | ✅ |

**排查中发现并修复的问题**

1. `meeting_summary.generate_meeting_summary()` 的配置校验在注入客户端**之前**执行，
   导致测试注入被"LLM 未配置"挡住。现改为：若已注入客户端替身则跳过配置校验
   （生产环境工厂恒为 `OpenAI` 本身，校验行为不变）。
2. **uvicorn StatReload 会重新导入 `meeting_summary`**，把模块级客户端工厂
   重置回真实 `OpenAI`，使启动时的注入失效。现除启动时注入外，
   在每次生成纪要前也会幂等地重新确认一次；并新增
   `backend/tests/serve_fake_llm.py`（关闭热重载的测试启动器）。

> 新增文件：`backend/fake_llm.py`、`backend/tests/serve_fake_llm.py`、
> `backend/tests/test_summary_over_http.py`

### 验证 — 真实双段会议（37 分钟）

用用户提供的**同一场会议的两份连续录音**（`wx交接1-文档.wav` 19.3min +
`wx交接2-网站.wav` 18.0min，合计 68.4 MB / 37 分钟）实跑：

| 项 | 结果 |
|---|---|
| 串行队列 | 两段依次处理，总耗时 **180s**；两段分别 1091.7s / 1035.8s |
| 合并文档 | **587 段**，2 位说话人，全局总时长 2129s |
| 时间轴 | 单调递增；录音2 偏移 1092.7s，与录音1 尾部衔接间隔恰为 1.0s |
| **跨录音说话人统一** | 两段**共用**同一套 `SPEAKER_0/1` 编号 |
| 说话人比例 | 录音1 = 66%/34%，录音2 = 57%/43%（同一场会议两半，比例吻合） |
| 导出 | TXT 19649 字符 / JSON 255283 字符，中文文件名正常 |
| 会议纪要 | `failed` —— 因未配置 LLM API key（预期，非缺陷） |

录音1 为已验证过的文件（MD5 `aea36b54…`），FileStore **MD5 去重**命中，未重复占用空间。

脚本归档为 `backend/tests/real_meeting_two_parts.py`，可复跑。

### 验证 — 纪要组件契约三方一致

会议纪要的 block 类型在三处必须严格对齐，已核对**完全一致（各 8 种）**：

| 位置 | 内容 |
|---|---|
| 后端白名单 `meeting_summary.BLOCK_TYPES` | summary / columns / table / timeline / steps / todo / bullets / text |
| 前端类型 `types/index.ts` 的联合类型 | 同上 8 种 |
| 前端渲染 `SummaryView.tsx` 的 switch case | 同上 8 种 |

后端会对 LLM 返回的非法类型做清洗（实测 `flowchart` 被丢弃），
因此 LLM 即使不守 schema 也不会让前端崩。

### 新增 — 多语种 ASR 路由（需求 5）

- 新增 `backend/whisper_backend.py`：faster-whisper（CTranslate2）本地多语种后端
- 新增按语言自动路由（`backend/backends.py`）：
  - `zh/yue/en/ja/ko` → 本地 SenseVoice（**带说话人分离**，中文质量更好）
  - 其它语种 → faster-whisper（多语种兜底，**不做说话人分离**）
  - `CCASR_ASR_ROUTING` 可强制指定 `sensevoice|whisper|doubao`；
    兼容旧的 `CCASR_BACKEND`（优先级更低）
- `/health` 新增 `asr_routing` 字段，便于确认当前路由与模型档位

**实测（Windows / Py3.13 / CPU-only）**
- `faster-whisper 1.2.1` + `ctranslate2 4.8.2` + `av 18.1.0` + `onnxruntime 1.31.0`
  在 Python 3.13 上有 cp313 wheel，免编译安装成功
- `tiny` 模型 30.3s 音频：耗时 1.6s，**RTF 0.053**，词级时间戳可用，语言识别 zh(0.998)
- Whisper 语言表含 `yue`（粤语）但**不含 `nan`（台语/闽南语）**，与调研结论一致

**两个必须记录的取舍（避免以后踩坑）**
1. **`av` 必须钉 `<19`**。faster-whisper 依赖只写 `av>=11` 无上界，而 av>=19 删除了
   `metadata_errors` 参数、faster-whisper 仍在调用 → 装最新版转写时抛 `TypeError`。
   已在 `pyproject.toml` 的 `[project.optional-dependencies].whisper` 中钉死，
   并在 `whisper_backend.py` 中对这个 TypeError 给出可操作提示。
2. **中文不要降档**。实测 `tiny` 把"语音识别"听成"**與因時別**"，
   故中文默认仍走 SenseVoice；faster-whisper 中文需 large 级才有竞争力。

### 测试（新增）

- `backend/tests/test_routing.py` — 路由判定 29 项断言（含语种覆盖、强制指定、
  环境变量优先级、大小写容错、非法值回退）
- `backend/tests/smoke_faster_whisper.py` — 真实加载模型并转写，兼查 av 版本坑

### 文档

- `.env.example` 重写：默认值改为 DeepSeek，并特别标注
  **DeepSeek 没有 `deepseek-flash` 这个模型名**（应填 `deepseek-chat`）

### 测试

- `backend/tests/test_meeting_summary.py` — 会议纪要管道验证（注入假 LLM 客户端，
  除网络外全链路真实）：正常 JSON / 代码围栏包裹 / 前后夹带解释文字 /
  两次都不可解析时降级 / 首次坏重试后正常，共 5 个场景
- `app/tests/frontend_verify.mjs` — 前端纯函数验证（`npm run test:fe`）：
  后端结构化产出能否被前端还原、Markdown 降级路径、LLM 内容的 XSS 转义、
  时间格式化、说话人配色稳定性，共 24 项断言
- `backend/tests/acceptance_e2e.py` — 走真实 HTTP 的端到端验收脚本

### 变更

- `meeting_summary.py` 的 LLM 客户端改为模块级导入，并暴露
  `set_llm_client_factory()` 注入点，便于测试替身（也避免每次调用重复 import）

### 新增 — 会议项目工作台

架构从「单文件转录工具」重构为「会议项目制」，一个会议 = 一个文档。

- **项目管理**：新建/重命名/删除会议（如「11月产品评审会」），一个会议可导入多段录音
- **批量上传 + 串行队列**：一次选择多个音频，按文件名顺序**串行**转录。
  用单个后台任务 + while 循环而非每文件一个任务，避免并发争抢 CPU/GPU；
  队列运行中再次上传返回 `409`
- **跨录音说话人统一**：各段录音独立聚类会把同一个人编成不同 `SPEAKER_x`。
  队列结束后汇总全部声纹向量**全局重聚类**，全会议共用一套编号；
  时长 < 1 秒的片段不参与（声纹不可靠）
- **合并转录文档**：跨录音统一时间轴（`offset + local_start`），
  点击任一句自动切到所属录音并定位到本地时间播放；支持校对与说话人改名
- **自动会议纪要**：全部录音转录完成后自动生成，无需手动触发；
  也可在改动参考材料/校对后手动「重新生成」
- **纪要可视化**：LLM 输出受约束的结构化 JSON 组件，前端渲染
  分栏色块 / 三线表格 / 垂直时间轴 / 流程条 / 待办表格 6 类版式
  （版式依据对腾讯会议「元宝纪要」的实测调研，见 `docs/`）；
  JSON 解析失败自动降级为 Markdown，绝不白屏
- **导出**：纪要 Markdown / 转录 TXT / 转录 JSON
- **参考材料**：上传议程、参会名单等，作为纪要生成的背景信息

### 移除

- 旧的单文件任务流程：`/api/tasks`、`/transcribe`、`/api/files` 及
  `summarize/presets` 等预设式总结 API
- 前端 `SummarizeModal`、`TaskListPage`、`UploadPage`、`WorkspacePage`、
  `SegmentBlock`、`ExportMenu` 及 zustand/immer 状态层
- 后端 `summarize.py`、`prompts/`（预设式 Prompt 模板）、`ccasr.py` CLI
- 前端依赖 `wavesurfer.js`、`localforage`、`zustand`、`immer`（打包体积 406KB → 327KB）

### 修复

- **声纹聚类失败导致全部说话人合并为 `SPEAKER_0`**
  归一化 Laplacian 需对"度"开平方，而余弦相似度含负值时行和可能为负，
  造成 NaN 并使聚类整体失败、被 `except` 静默吞掉。
  现改为非负亲和矩阵 `(cos + 1) / 2` 并配合 L2 归一化。
- **eigengap 判据索引错误**（上一轮引入，被 `max(2, ...)` 掩盖而永远返回 2）
  三处问题：ARPACK 已返回 λ0 却被重复追加导致整个谱右移一位；
  未跳过 `gaps[0]`（λ1−λ0 恒为最大）；下标换算差一。
  实测校准：合成 3 簇在噪声 ≤0.15 时纯度 1.00，而轮廓系数在低噪声下会拆开真实簇。
  实测 217 段双人对话由「1 个说话人」恢复为正确的 2 个。
- **说话人数判据过分割**
  原先以"轮廓系数取最大"选 k，在声纹噪声长尾上会系统性偏向过多聚类。
  改为**特征间隙（eigengap）**判据（实测 λ1−λ0 = 0.918，远大于其它间隙）。
- **聚类异常不再静默**
  由 `warning` 提升为 `error` 级并输出完整堆栈，避免同类故障再次被掩盖。
- **AI 总结预设被静默忽略**
  前端以 multipart 提交 `preset` / `include_intro`，后端却声明为 Query 参数，
  导致「会议总结」永远回落到「播客整理润色」。改为 `Form` 绑定。

### 变更

- 项目更名为 **CcAsr**（原 WinASR）
- 环境变量前缀由 `WINASR_` 改为 `CCASR_`；旧前缀仍兼容读取并打印弃用警告
- 输出目录默认为 `~/CcAsr/output`；首次启动会自动迁移旧的 `~/WinASR/output`
- `/health` 新增 `code` 字段，用于确认运行进程已加载当前代码

### 工程

- 新增 `backend/config.py` 统一收口环境变量与输出目录
- 修复 `.gitignore`：原 `*.md` 规则会静默忽略所有新增文档
- `ecosystem.config.js` 改为按 `__dirname` 自动定位，去除硬编码绝对路径
- Windows 启动脚本不再硬编码 Node 路径，并补充依赖检查
- 文档补充 Windows 安装与启动说明
