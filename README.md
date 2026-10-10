# CcAsr

会议录音 → 说话人分离转录 → 自动会议纪要

## 功能

- **会议项目管理**：以「xx 会议」为单位建立文档，一个会议可导入**多段录音**
- **批量上传 + 串行队列**：一次选多个音频，按文件名顺序**串行**转录，避免并发抢 CPU/GPU
- **跨录音说话人统一**：多段录音合并后**全局重聚类**，同一个人在整个会议中编号一致
- **合并转录文档**：跨录音统一时间轴，点击任一句即跳转到对应录音的对应位置播放
- **自动会议纪要**：全部录音转录完成后**自动**生成，无需手动点按钮
- **纪要可视化**：分栏色块 / 三线表格 / 时间轴 / 流程条 / 待办表格（参考腾讯会议元宝版式）
- **语音转文字**：基于 FunASR SenseVoice 模型
- **声纹识别**：基于 CAM++ 模型 + 谱聚类（非负亲和矩阵 + 特征间隙定簇数）
- **情绪/语种检测**：SenseVoice 自带情绪和语种标签
- **在线校对**：双击改文本、说话人改名、导出 TXT / JSON / Markdown
- **多格式支持**：wav / mp3 / m4a / flac / ogg / aac / wma / mp4
- **文件去重**：MD5 哈希存储，相同文件不重复占用空间

## 技术架构

```
┌──────────────────────────────────────────────────────┐
│  Frontend: React 19 + TypeScript + Vite               │
│  ┌────────────┐  ┌─────────────────────────────────┐  │
│  │ 我的会议    │→ │ 会议详情                         │  │
│  └────────────┘  │  多文件拖拽上传 + 队列进度        │  │
│                  │  Tabs: 纪要 / 合并转录 / 录音     │  │
│                  │  Virtuoso 虚拟滚动                │  │
│                  └─────────────────────────────────┘  │
├──────────────────────────────────────────────────────┤
│  Backend: FastAPI + Python                            │
│  ┌────────────────────────────────────────────────┐   │
│  │ 项目队列（串行）                                 │   │
│  │  录音1 → 录音2 → … → 录音N                      │   │
│  │   每段: VAD → ASR(SenseVoice) + 声纹(CAM++)     │   │
│  │   ↓                                            │   │
│  │ 跨录音统一聚类 → 合并时间轴 → 自动会议纪要       │   │
│  │   ↑                        ↑                   │   │
│  │ 声纹向量(.npy)          LLM(OpenAI 兼容)        │   │
│  └────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────┤
│  Hardware: CUDA / MPS 自动检测, 无 GPU 回退 CPU         │
└──────────────────────────────────────────────────────┘
```

## 快速开始

详见 [INSTALL.md](INSTALL.md)

```bash
## 后端
cd CcAsr
uv sync
# Windows
.venv\Scripts\python.exe run_server.py
# macOS / Linux
.venv/bin/python run_server.py

## 前端（新终端）
cd CcAsr/app
npm install
npm run dev

# 推荐 pm2 方案管理，可逐个重启服务
pm2 reload all
```

> 前端包管理器用 **npm**（仓库内为 `app/package-lock.json`，
> `start_frontend.bat` 也调用 npm）。

Windows 用户也可直接双击 `start_backend.bat` / `start_frontend.bat`。

打开 `http://localhost:5173`，新建一个会议、导入录音即可使用。

## 使用流程

```
① 新建会议            输入名称，例如「11月产品评审会」
        ↓
② 导入录音            拖拽或一次选择多个音频；按文件名顺序排队
        ↓
③ 串行转录            队列逐段处理，可在「录音」Tab 看到每段状态
        ↓
④ 自动合并            跨录音统一说话人 → 生成全局时间轴文档
        ↓
⑤ 自动会议纪要        全部转录完成后自动生成，无需点按钮
        ↓
⑥ 校对与导出          双击改文本 / 说话人改名 / 导出 TXT·JSON·Markdown
```

### 关于多段录音

一场长会议若被拆成多段录音，直接分段转写会遇到两个问题，本项目都做了处理：

| 问题 | 处理方式 |
|------|----------|
| 同一人在不同录音里被编成不同 `SPEAKER_x` | 汇总所有录音的声纹向量**全局重聚类**，全会议共用一套编号 |
| 时间戳各自从 0 开始，无法定位 | 合并为**统一时间轴**（`offset + local_start`），点击任一句自动切到对应录音的对应位置播放 |

> 全局重聚类会排除时长 < 1 秒的片段，因为过短片段的声纹不可靠，会把聚类带偏。


## 环境变量

复制 `.env.example` 为 `.env`，按需填写：

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `CCASR_BACKEND` | 否 | 识别后端：`sensevoice`（默认，本地离线）/ `doubao`（云端） |
| `CCASR_OUTPUT_DIR` | 否 | 输出目录，默认 `~/CcAsr/output` |
| `CCASR_DEBUG` | 否 | 设为 `1` 开启详细日志 |
| `CCASR_LLM_API_BASE` | 是 | LLM API 地址（OpenAI 兼容），如 `https://api.openai.com/v1` |
| `CCASR_LLM_API_KEY` | 是 | API Key |
| `CCASR_LLM_MODEL` | 是 | 模型名称，如 `gpt-4o` |
| `CCASR_LLM_MAX_CONTEXT` | 否 | 最大上下文长度（token），默认 `1000000` |

> 旧版 `WINASR_*` 前缀仍兼容读取，但会打印弃用警告，建议改为 `CCASR_*`。

> ⚠️ **修改 `.env` 后必须重启后端服务**，环境变量仅在启动时加载。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects` | 创建会议项目（body: `{"name": "xx 会议"}`） |
| GET | `/api/projects` | 列出会议项目 |
| GET | `/api/projects/{id}` | 项目详情（含录音队列状态） |
| PATCH | `/api/projects/{id}` | 重命名项目 |
| DELETE | `/api/projects/{id}` | 删除项目及全部产物 |
| POST | `/api/projects/{id}/recordings` | **一次上传多个录音**（multipart，字段名 `files`） |
| POST | `/api/projects/{id}/start` | 启动/继续转录队列 |
| GET | `/api/projects/{id}/transcript` | 合并转录文档（统一时间轴） |
| PATCH | `/api/projects/{id}/transcript` | 保存校对与说话人改名 |
| GET | `/api/projects/{id}/summary` | 会议纪要（Markdown + 状态） |
| POST | `/api/projects/{id}/summary/regenerate` | 重新生成纪要 |
| POST | `/api/projects/{id}/reference` | 上传参考材料（议程/参会名单） |
| GET | `/api/projects/{id}/recordings/{rid}/audio` | 单段录音音频（支持 Range） |
| GET | `/api/projects/{id}/recordings/{rid}/transcript` | 单段录音的本地时间轴转录 |
| GET | `/api/projects/{id}/export?fmt=md\|txt\|json` | 导出 |
| GET | `/health` | 健康检查 |

### 示例：建会议并导入多段录音

```bash
# 1) 建会议
PID=$(curl -s -X POST http://localhost:8000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"11月产品评审会"}' | python -c "import sys,json;print(json.load(sys.stdin)['project_id'])")

# 2) 一次上传多个录音（按文件名顺序排队，自动开始串行转录）
curl -X POST "http://localhost:8000/api/projects/$PID/recordings" \
  -F "files=@part1.m4a" \
  -F "files=@part2.m4a" \
  -F "files=@part3.m4a" \
  -F "language=zh"

# 3) 查询进度（state: transcribing → summarizing → completed）
curl -s "http://localhost:8000/api/projects/$PID"

# 4) 取会议纪要与合并转录
curl -s "http://localhost:8000/api/projects/$PID/summary"
curl -s "http://localhost:8000/api/projects/$PID/transcript"
```

> ⚠️ 队列运行中再次上传会返回 `409`，避免多段录音并发争抢 CPU/GPU。
> 需要追加录音时，等当前队列跑完再传。

## 性能参考

| 音频时长 | 处理耗时 | RTF |
|----------|----------|-----|
| 4 min | ~15 s | ~0.06 |
| 103 min | ~14 min | ~0.14 |

> RTF < 1 表示快于实时。优化措施：ASR+声纹并行、GPU 加速（CUDA/MPS 自动检测）、非 WAV 预转码。
>
> 实测参考（Windows / CPU-only / 16 核 / 19 分钟中文对话）：228 段，耗时约 88 秒，RTF ≈ 0.076。

## 项目结构

```
CcAsr/
├── backend/
│   ├── app.py            # FastAPI 服务入口（会议项目 API）
│   ├── project_store.py  # 项目/录音管理 + 串行队列 + 跨录音说话人统一
│   ├── meeting_summary.py# 会议纪要生成（结构化 JSON 组件 + Markdown 降级）
│   ├── config.py         # 配置解析（环境变量 + 输出目录迁移）
│   ├── backends.py       # ASR 后端分发（本地 / 豆包）
│   ├── pipeline.py       # 核心 Pipeline（VAD → ASR + 声纹 → 聚类）
│   ├── doubao_backend.py # 火山引擎豆包云端后端（可选）
│   ├── schema.py         # 数据模型（Project / Recording / Segment）
│   └── file_store.py     # 文件管理（MD5 去重 + 元数据持久化）
├── app/                  # React 前端
│   ├── src/
│   │   ├── components/
│   │   │   ├── MeetingListPage.tsx     # 我的会议（新建/重命名/删除）
│   │   │   ├── MeetingDetailPage.tsx   # 会议详情（多文件上传 + 队列 + Tabs）
│   │   │   ├── TranscriptWorkspace.tsx # 合并转录（跨录音回放 + 校对）
│   │   │   └── SummaryView.tsx         # 纪要渲染（6 类版式组件）
│   │   ├── services/api.ts   # API 调用
│   │   ├── utils/format.ts   # 时间格式化 + 说话人配色
│   │   └── types/            # TypeScript 类型
│   ├── vite.config.ts    # Vite 配置（含 API 代理）
│   └── package.json
├── docs/                 # 调研资料（元宝纪要版式分析 + 证据截图）
├── output/               # 输出目录（默认 ~/CcAsr/output）
│   ├── files/            # 上传音频（MD5 命名，永久保存）
│   ├── projects.json     # 项目索引
│   └── projects/{id}/    # 每场会议
│       ├── recordings/   #   各段结果 JSON + 声纹向量 .npy
│       ├── transcript.json  # 合并转录（统一时间轴）
│       └── summary.md       # 会议纪要
├── .env                  # 环境变量（不提交，从 .env.example 复制）
├── .env.example          # 环境变量模板
├── run_server.py         # 启动脚本（支持 --debug）
├── start_backend.bat     # Windows 后端启动
├── start_frontend.bat    # Windows 前端启动
├── CHANGELOG.md          # 更新日志
├── INSTALL.md            # 安装说明
└── pyproject.toml        # Python 依赖
```

## 多语种支持

默认按语言自动路由，无需配置：

| 语种 | 后端 | 说话人分离 |
|------|------|-----------|
| 中 / 粤 / 英 / 日 / 韩 | 本地 SenseVoice | ✅ 有 |
| 其它语种（法/德/西/俄/泰/越…） | 本地 faster-whisper | ❌ 无 |

用 `CCASR_ASR_ROUTING` 可强制指定：`auto`（默认）/ `sensevoice` / `whisper` / `doubao`。

**为什么要这样分工**（均经实测）：

- **中文不走 faster-whisper**：实测 `tiny` 档把"语音识别"听成"**與因時別**"，
  中文需要 large 级才有竞争力，而 large 在 CPU 上很慢。SenseVoice 中文又快又准。
- **faster-whisper 不做说话人分离**：它本身不含 diarization，需要额外的
  pyannote（gated 模型，商用条款未确认）。走该路径时说话人会统一为 `SPEAKER_0`，
  日志与 `model_info.speaker` 都会标注。
- **台语/闽南语暂不支持**：Whisper 的 100 种语言表里有 `yue`（粤语）但**没有 `nan`**，
  SenseVoice 也只发布 zh/yue/en/ja/ko。要支持只能挂社区微调模型。

### 安装多语种依赖（可选）

```bash
# Windows
.venv\Scripts\python.exe -m pip install -e ".[whisper]" --index-url https://pypi.org/simple
# macOS / Linux
.venv/bin/pip install -e ".[whisper]"
```

> ⚠️ **`av` 必须 <19**。faster-whisper 的依赖只写 `av>=11` 没有上界，
> 而 av>=19 删除了 `metadata_errors` 参数、faster-whisper 仍在调用它，
> 装上最新版会在转写时抛 `TypeError`。`pyproject.toml` 已钉死该约束。
>
> ⚠️ 若你的 pip 配置了指向不可达的镜像（如 TUNA），会报
> "No matching distribution found"。此时加 `--index-url https://pypi.org/simple`。

## 测试

一键跑完后端全部测试（**不需要 API key、不需要启动服务**）：

```bash
# Windows
.venv\Scripts\python.exe backend\tests\run_all.py
# macOS / Linux
.venv/bin/python backend/tests/run_all.py
```

前端测试：

```bash
cd app && npm run test:fe
```

### 各套件说明

| 套件 | 覆盖内容 | 依赖 |
|------|----------|------|
| `run_all.py` | 一键汇总以下全部 | — |
| `test_meeting_summary.py` | 纪要管道：JSON 提取 / 代码围栏 / 夹带解释文字 / 两次失败降级 / 重试成功 | 注入假 LLM |
| `test_llm_config_check.py` | LLM 配置体检：缺 key / 占位符 / 模型名笔误 / base 异常 | 纯函数 |
| `test_routing.py` | ASR 路由：语种覆盖 / 强制指定 / 环境变量优先级 / 容错 | 纯函数 |
| `test_summary_e2e_selfcontained.py` | **全链路**：多文件上传→串行队列→跨录音统一→合并→自动纪要→导出→删除 | 假 ASR + 假 LLM |
| `app/tests/frontend_verify.mjs` | 结构化解析 / 降级路径 / XSS 转义 / 时间格式化 | vite 转译 |

### 需要外部条件的测试

```bash
# 真实音频端到端（需后端已启动，会用 samples/ 的音频真跑一遍）
.venv\Scripts\python.exe backend\tests\acceptance_e2e.py

# 真实双段会议（需自备音频路径，见脚本内 SRC）
.venv\Scripts\python.exe backend\tests\real_meeting_two_parts.py

# LLM 真实连通性（填好 key 后跑，只发一次最小请求）
.venv\Scripts\python.exe backend\tests\check_llm_live.py
```

> `CCASR_LLM_FAKE=1` 可让后端使用**假 LLM 客户端**，仅用于验证纪要链路。
> 默认关闭，生产部署不受影响。

## 常见问题

**Q: 模型加载很慢？**
首次运行需从 ModelScope 下载模型（~1GB），后续走缓存。

**Q: 说话人分离不准 / 所有人都是同一个 SPEAKER？**
聚类失败时会降级为单一说话人，日志中出现 `声纹聚类失败`。
判据是**特征间隙（eigengap）**：样本过少或片段普遍过短时会判不准。
若持续出现，请附日志反馈。

**Q: 多段录音里同一个人被编成不同的 SPEAKER_x？**
正常情况下不应发生 —— 队列结束后会自动做**跨录音全局重聚类**。
若仍出现，检查各段录音是否有足够长的语音（< 1 秒的片段不参与全局聚类）。

**Q: 会议纪要没生成？**
先看 `GET /health` 的 `llm` 字段 —— 它会直接告诉你哪里配错了（不发网络请求）：

```json
"llm": {
  "ok": false,
  "problems": ["CCASR_LLM_API_KEY 仍是占位符，需填真实 key"],
  "warnings": ["模型名 'deepseek-flash' 不在 api.deepseek.com 的常见列表中…"]
}
```

常见原因：
- `CCASR_LLM_API_KEY` 未填或仍是占位符
- 模型名笔误（例如 DeepSeek 并没有 `deepseek-flash`，应为 `deepseek-chat`）

转录本身不需要 LLM，不受影响。

**Q: 纪要生成失败会影响转录结果吗？**
不会。转录是独立阶段，纪要在其后执行且失败被捕获，
项目状态会标记 `summary_state=failed`，转录与合并文档照常可用。
已生成转录的会议可在纪要 Tab 点「重新生成」，**不需要重跑转录**。

**Q: GPU 没被用上？**
`/health` 的 `device` 字段会显示实际设备。无 NVIDIA GPU 时自动回退 CPU（多核并行），
MPS 仅 macOS Apple Silicon 可用。

**Q: Debug 模式？**
```bash
# Windows
.venv\Scripts\python.exe run_server.py --debug
# macOS / Linux
.venv/bin/python run_server.py --debug
# 或设置环境变量
CCASR_DEBUG=1
```

**Q: 修改 .env 后不生效？**
`.env` 在后端启动时加载一次，修改后必须重启服务：`pm2 reload ccasr-backend` 或手动重启。

**Q: 参考材料有什么用？**
上传议程、参会名单等材料后，纪要生成时会把它们作为背景信息，
有助于正确理解人名、议题与专有名词。可在纪要 Tab 上传，然后点「重新生成」。
