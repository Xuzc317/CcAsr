# CcAsr 安装说明

## 环境要求

| 依赖 | 版本要求 | 用途 |
|------|----------|------|
| Python | 3.12+ | 后端运行时 |
| Node.js | 20+ (LTS) | 前端构建 |
| pnpm | 9+ | 前端包管理 |
| uv | 最新版 | Python 依赖管理 |
| ffmpeg | 最新版 | 音频格式转码 |

**GPU 加速（可选）：**

| 平台 | GPU | 说明 |
|------|-----|------|
| macOS (Apple Silicon) | MPS | 自动检测，无需额外配置 |
| Windows/Linux (NVIDIA) | CUDA | 需安装 CUDA 版 PyTorch（见下方） |

## 1. 安装基础工具

### Windows

```powershell
# ffmpeg（任选其一）
winget install Gyan.FFmpeg
# 或 scoop install ffmpeg / choco install ffmpeg

# uv（Python 依赖管理）
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Node.js + pnpm
winget install OpenJS.NodeJS.LTS
npm install -g pnpm
```

### macOS（Homebrew）

```bash
# Homebrew（如未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# ffmpeg
brew install ffmpeg

# uv
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.zshrc   # 重新加载 shell

# nvm + Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.zshrc
nvm install --lts
nvm use --lts

# pnpm
npm install -g pnpm
```

### nvm + Node.js

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.zshrc
nvm install --lts
nvm use --lts
```

### pnpm

```bash
npm install -g pnpm
```

## 2. 获取代码

```bash
git clone git@github.com:Xuzc317/ASR.git CcAsr
cd CcAsr
```

## 3. 后端安装

```bash
uv sync
```

uv 会自动创建 `.venv` 并安装 Python 3.12 + 所有依赖。

验证 GPU：

```bash
# Windows
.venv\Scripts\python.exe -c "import torch; print('CUDA:', torch.cuda.is_available())"
# macOS / Linux
.venv/bin/python -c "import torch; print('CUDA:', torch.cuda.is_available(), 'MPS:', hasattr(torch.backends,'mps') and torch.backends.mps.is_available())"
```

### Windows + NVIDIA GPU（CUDA 加速）

默认安装的是 CPU 版 PyTorch。如需 CUDA 加速：

```bash
cd CcAsr
.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```

> 需要先安装 [NVIDIA CUDA Toolkit 12.1](https://developer.nvidia.com/cuda-12-1-0-download-archive) 和对应 cuDNN。

### macOS（MPS 加速）

macOS Apple Silicon 自动使用 MPS，无需额外配置。

## 4. 配置环境变量（AI 总结功能）

AI 总结功能需要配置 LLM API。复制模板并填写：

```bash
cd CcAsr
cp .env.example .env     # Windows: copy .env.example .env
```

编辑 `.env`：

```bash
# LLM API 配置（OpenAI 兼容接口）
CCASR_LLM_API_BASE=https://api.openai.com/v1    # API 地址
CCASR_LLM_API_KEY=sk-xxx                          # 你的 API Key
CCASR_LLM_MODEL=gpt-4o                            # 模型名称
CCASR_LLM_MAX_CONTEXT=1000000                     # 最大上下文长度（可选，默认 1M）
```

- 支持任何 OpenAI 兼容 API（如 DeepSeek、Moonshot、本地 Ollama 等）
- `.env` **仅在后端启动时加载**，修改后必须重启服务才生效
- Prompt 模板（`backend/prompts/`）则支持热更新，修改 `.md` 文件无需重启

> 如不需要 AI 总结功能，可跳过此步骤，不影响转写功能。

## 5. 前端安装

```bash
cd app
pnpm install
```

## 6. 启动服务

Windows 可直接双击 `start_backend.bat` / `start_frontend.bat`，或按下文手动启动。

**终端 1 — 后端（端口 8000）：**

```bash
cd CcAsr
# Windows
.venv\Scripts\python.exe run_server.py
# macOS / Linux
.venv/bin/python run_server.py
```

**Debug 模式**（输出详细日志）：

```bash
# Windows
.venv\Scripts\python.exe run_server.py --debug
# macOS / Linux
.venv/bin/python run_server.py --debug
```

**终端 2 — 前端（端口 5173）：**

```bash
cd CcAsr/app
pnpm run dev
```

打开浏览器访问 `http://localhost:5173`。

## 7. 构建生产版本

```bash
cd CcAsr/app
pnpm run build
```

构建产物输出到 `app/dist/`，后端 FastAPI 会自动托管（访问 `http://localhost:8000`）。

## 内网访问

Vite 已配置 `host: true`，前端自动监听 `0.0.0.0`。局域网内通过 `http://<本机IP>:5173` 访问。

## 文件管理

- 上传文件存储在 `~/CcAsr/output/files/`（Windows：`C:\Users\<你>\CcAsr\output\files\`），以 MD5 哈希命名（去重）
- 元数据记录在 `output/files/metadata.json`
- 文件永久保存，不会随任务清理而删除
- 可用 `CCASR_OUTPUT_DIR` 自定义输出目录

## 常见问题

### Q: `uv sync` 报 Python 版本不满足？

uv 会自动下载 Python 3.12，无需手动安装。如遇问题可指定版本：

```bash
uv python install 3.12
uv sync
```

### Q: GPU 没被用上 / 如何确认设备？

后端 `/health` 接口的 `device` 字段会显示实际使用的设备。

- 无独立显卡时自动回退 CPU，使用多核并行（不需要额外配置）
- NVIDIA 显卡需装 CUDA 版 PyTorch（见第 3 节）
- MPS 仅 macOS Apple Silicon 可用

### Q: 首次加载模型很慢？

首次运行需下载模型文件（~1GB），后续走本地缓存。可提前手动下载：

```bash
cd CcAsr
# Windows
.venv\Scripts\python.exe -c "from funasr import AutoModel; AutoModel(model='iic/SenseVoiceSmall')"
# macOS / Linux
.venv/bin/python -c "from funasr import AutoModel; AutoModel(model='iic/SenseVoiceSmall')"
```

### Q: 端口被占用？

```bash
# macOS / Linux
lsof -ti:8000 && kill $(lsof -ti:8000)
```

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Q: 后端重启后任务列表为空？

任务列表持久化在 `output/tasks.json`，重启后会自动加载；
转写结果（`output/*.json`）和音频文件（`output/files/`）同样持久保存在磁盘上。

### Q: 修改 .env 后 AI 总结不生效？

`.env` 在后端启动时加载一次，修改后必须重启服务：

```bash
# 如果用 pm2
pm2 reload ccasr-backend

# 如果手动启动：先 Ctrl+C 停止，再重新启动
```

> Prompt 模板（`backend/prompts/*.md`）支持热更新，修改后无需重启。
