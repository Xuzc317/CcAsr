# CcAsr

离线语音转文字 + 声纹识别 + 情绪识别 + Web 编辑器 + AI 总结

## 功能

- **语音转文字**：基于 FunASR SenseVoice 模型
- **声纹识别**：基于 CAM++ 模型 + 谱聚类
- **情绪/语种检测**：SenseVoice 自带情绪和语种标签
- **Web 编辑器**：波形可视化 + 在线校对 + 说话人改名 + 撤销/重做
- **AI 总结**：基于 LLM 的转录结果总结/整理（播客整理润色、会议总结两种预设）
- **多格式支持**：wav / mp3 / m4a / flac
- **文件去重**：MD5 哈希存储，相同文件不重复占用空间

## 技术架构

```
┌─────────────────────────────────────────────────┐
│  Frontend: React 19 + TypeScript + Vite          │
│  ┌──────┐  ┌──────────┐  ┌───────────────────┐  │
│  │Upload│→ │ TaskList │→ │ Workspace (编辑器)  │  │
│  └──────┘  └──────────┘  │ WaveSurfer 波形    │  │
│                          │ Virtuoso 虚拟滚动  │  │
│                          │ Zustand 状态管理   │  │
│                          └───────────────────┘  │
├─────────────────────────────────────────────────┤
│  Backend: FastAPI + Python                       │
│  ┌──────────────────────────────────────────┐   │
│  │ VAD → ASR(SenseVoice) + 声纹(CAM++) → 聚类│   │
│  │ ↓                                        │   │
│  │ FileStore(MD5去重) + TaskStore(内存)      │   │
│  │ ↓                                        │   │
│  │ Summarize(LLM总结) — OpenAI 兼容 API     │   │
│  └──────────────────────────────────────────┘   │
├─────────────────────────────────────────────────┤
│  Hardware: CUDA / MPS 自动检测, 无 GPU 回退 CPU    │
└─────────────────────────────────────────────────┘
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
pnpm install
pnpm run dev

# 推荐 pm2 方案管理，可逐个重启服务
pm2 reload all
```

Windows 用户也可直接双击 `start_backend.bat` / `start_frontend.bat`。

打开 `http://localhost:5173`，上传音频即可使用。

## CLI 命令行使用

除 Web 界面外，也可以直接用命令行完成转录和 AI 总结，适合批量处理或脚本集成。

```bash
cd CcAsr

# 以下以 Windows 为例；macOS/Linux 把 .venv\Scripts\python.exe 换成 .venv/bin/python

# 仅转录
.venv\Scripts\python.exe ccasr.py input.m4a

# 转录 + AI 总结（默认播客整理润色）
.venv\Scripts\python.exe ccasr.py input.m4a -s

# 转录 + 会议总结
.venv\Scripts\python.exe ccasr.py input.m4a -s -p meeting_summary

# 带参考材料
.venv\Scripts\python.exe ccasr.py input.m4a -s -r intro.md

# 指定语种 + 输出目录
.venv\Scripts\python.exe ccasr.py input.m4a -l en -o ./output
```

### 参数说明

| 参数 | 短写 | 说明 |
|------|------|------|
| `--language` | `-l` | 语种：`auto` / `zh` / `en` / `yue` / `ja` / `ko`（默认 `zh`） |
| `--output` | `-o` | 输出目录（默认：音频同目录） |
| `--summarize` | `-s` | 转录后进行 AI 总结 |
| `--preset` | `-p` | 总结预设：`podcast_polish` / `meeting_summary`（默认 `podcast_polish`） |
| `--reference` | `-r` | 参考材料文件（默认：自动查找同名 `.md`） |
| `--no-intro` | | 不将参考材料作为节目介绍（仅播客预设） |
| `--no-text` | | 不输出纯文本转录文件（`.txt`） |
| `--device` | `-d` | 推理设备：`auto` / `cpu` / `mps` / `cuda`（默认 `auto`） |
| `--verbose` | `-v` | 输出详细日志 |

### 输出文件

| 文件 | 内容 |
|------|------|
| `{name}.json` | 转录结构化结果（含时间戳、说话人、情绪等） |
| `{name}.txt` | 纯文本转录（`[HH:MM:SS] SPEAKER: 文本` 格式） |
| `{name}_asr.md` | AI 总结结果（仅 `-s` 时生成） |

> 参考材料自动发现：脚本会自动查找与音频同名的 `.md` 文件（如 `input.m4a` → `input.md`），无需手动指定。

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

### 转写

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建异步转写任务 |
| GET | `/api/tasks` | 列出所有任务 |
| GET | `/api/tasks/{id}` | 查询任务状态 |
| GET | `/api/tasks/{id}/result` | 获取转写结果 |
| GET | `/api/tasks/{id}/audio` | 获取音频文件 |
| POST | `/transcribe` | 同步转写（直接返回结果） |
| GET | `/api/files` | 列出所有文件记录 |
| GET | `/health` | 健康检查 |

### AI 总结

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/summarize/presets` | 列出可用预设 |
| POST | `/api/tasks/{id}/summarize` | 创建总结任务（multipart：preset、reference 可选） |
| GET | `/api/tasks/{id}/summarize` | 查询总结状态 |
| GET | `/api/tasks/{id}/summarize/result` | 获取总结结果（JSON） |
| GET | `/api/tasks/{id}/summarize/preview` | 预览总结结果（HTML 渲染页面） |

#### 预设

| 预设 | 说明 |
|------|------|
| `podcast_polish` | 播客整理润色 — 修正 ASR 错误、添加说话人标签、保留完整内容 |
| `meeting_summary` | 会议总结 — 提炼议题、决议、待办事项，生成结构化总结 |

### POST /api/tasks

```bash
curl -X POST http://localhost:8000/api/tasks \
  -F "file=@meeting.m4a" \
  -F "language=zh"
# 返回: {"task_id": "abc123", "state": "pending", ...}
```

### POST /transcribe

```bash
curl -X POST http://localhost:8000/transcribe \
  -F "file=@meeting.m4a" \
  -F "output_format=text"
```

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
│   ├── app.py           # FastAPI 服务入口
│   ├── config.py        # 配置解析（环境变量 + 输出目录迁移）
│   ├── backends.py      # ASR 后端分发（本地 / 豆包）
│   ├── pipeline.py      # 核心 Pipeline（VAD → ASR + 声纹 → 聚类）
│   ├── doubao_backend.py# 火山引擎豆包云端后端（可选）
│   ├── schema.py        # 数据模型定义
│   ├── file_store.py    # 文件管理（MD5 去重 + 元数据持久化）
│   ├── summarize.py     # AI 总结核心逻辑（LLM 调用 + 分段处理）
│   └── prompts/         # Prompt 模板（热更新，无需重启）
│       ├── podcast_polish/   # 播客整理润色预设
│       └── meeting_summary/  # 会议总结预设
├── app/                 # React 前端
│   ├── src/
│   │   ├── components/  # 页面组件
│   │   │   ├── SummarizeModal.tsx  # AI 总结弹窗
│   │   │   └── WorkspacePage.tsx   # 工作区主页面
│   │   ├── stores/      # Zustand 状态管理
│   │   ├── services/    # API 调用
│   │   └── types/       # TypeScript 类型
│   ├── vite.config.ts   # Vite 配置（含 API 代理）
│   └── package.json
├── output/              # 输出目录（默认 ~/CcAsr/output）
│   ├── files/           # 上传文件（MD5 命名，永久保存）
│   ├── *.json           # 转写结果
│   └── *_summary.md     # AI 总结结果
├── .env                 # 环境变量（不提交，从 .env.example 复制）
├── .env.example         # 环境变量模板
├── ccasr.py             # CLI（转录 + 可选 AI 总结）
├── run_server.py        # 启动脚本（支持 --debug）
├── start_backend.bat    # Windows 后端启动
├── start_frontend.bat   # Windows 前端启动
├── INSTALL.md           # 安装说明
└── pyproject.toml       # Python 依赖
```

## 常见问题

**Q: 模型加载很慢？**
首次运行需从 ModelScope 下载模型（~1GB），后续走缓存。

**Q: 说话人分离不准 / 所有人都是同一个 SPEAKER？**
光谱聚类失败时会降级为单一说话人，日志中会出现 `声纹聚类失败`。
常见原因是聚类样本过少（片段太短）。若持续出现，请附日志反馈。

**Q: GPU 没被用上？**
`/health` 的 `device` 字段会显示实际设备。无 NVIDIA GPU 时自动回退 CPU（多核并行），
MPS 仅 macOS Apple Silicon 可用。

**Q: 音频播放器 404？**
确保后端未重启（任务在内存中），或文件仍在 `output/files/` 目录下。

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

**Q: Prompt 模板如何修改？**
直接编辑 `backend/prompts/` 下的 `.md` 文件即可，无需重启服务，下次调用时自动生效。
