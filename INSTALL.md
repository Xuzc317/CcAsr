# 安装与部署

[返回首页](README.md) · [使用指南](docs/USAGE.md) · [API 参考](docs/API.md)

## 环境要求

| 工具 | 要求 | 用途 |
| :--- | :--- | :--- |
| Python | 3.12+；仓库默认 3.12 | 后端与语音模型 |
| Node.js | 推荐 22.12+；Vite 8 也支持 20.19+ | 前端安装与构建 |
| uv | 可用的当前版本 | Python 依赖与虚拟环境 |
| ffmpeg | 可执行文件加入 PATH | 音频解码与转换 |
| Git | 可访问本仓库 | 获取代码 |

CPU 可以运行默认识别链路。CUDA 与 Apple Silicon MPS 为可选加速，取决于 PyTorch 安装和设备支持。

安装入口：[Python](https://www.python.org/downloads/)、[Node.js](https://nodejs.org/en/download)、[uv](https://docs.astral.sh/uv/getting-started/installation/)、[ffmpeg](https://ffmpeg.org/download.html)。

## 1. 获取代码与安装后端

```bash
git clone https://github.com/Xuzc317/CcAsr.git
cd CcAsr
uv sync
```

私有仓库需要有访问权限的 GitHub 账号认证。已配置 SSH 时也可使用 `git@github.com:Xuzc317/CcAsr.git`。

uv 创建 `.venv` 并安装依赖。首次转录下载 SenseVoice、VAD 与声纹模型；之后使用本地缓存。

<details>
<summary>使用已有 Python 环境与 pip</summary>

确保 Python 3.12+，创建虚拟环境：

```bash
python -m venv .venv
```

Windows PowerShell 激活命令：

```powershell
.\.venv\Scripts\Activate.ps1
```

macOS / Linux 激活命令：

```bash
source .venv/bin/activate
```

激活后执行：

```bash
python -m pip install -e .
python run_server.py
```

pip 不读取 `[tool.uv]` 的索引配置，PyTorch 版本按设备需求选择。

</details>

## 2. 配置纪要服务

只使用转录时可跳过。纪要需要一个 OpenAI 兼容的 Chat Completions 服务。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

编辑 `.env`，替换占位符：

```dotenv
CCASR_LLM_API_BASE=https://your-provider.example/v1
CCASR_LLM_API_KEY=REPLACE_WITH_YOUR_API_KEY
CCASR_LLM_MODEL=your-model-name
```

地址不含 `/chat/completions` 后缀，模型名以服务商实际名称为准。可连接云端或本地兼容服务；云端纪要会发送转录文本与参考材料，默认音频识别在本地完成。

`.env` 已被 Git 忽略。修改后需重启后端。

| 可选变量 | 默认值 / 行为 |
| :--- | :--- |
| `CCASR_OUTPUT_DIR` | 输出至 `~/CcAsr/output` |
| `CCASR_DEBUG` | `0`；设为 `1` 输出详细日志 |
| `CCASR_ASR_ROUTING` | `auto`；可强制 `sensevoice` 或 `whisper` |
| `CCASR_WHISPER_MODEL` | `small` |
| `CCASR_WHISPER_DEVICE` | `cpu` |
| `CCASR_WHISPER_COMPUTE_TYPE` | `int8` |

完整模板见 [.env.example](.env.example)。`CCASR_LLM_MAX_CONTEXT` 当前未用于纪要输入限制；实现使用固定的 120,000 字符上限截取转录。

旧版 `WINASR_*` 和 `CCASR_BACKEND` 仍有兼容逻辑，新配置建议使用 `CCASR_*` 与 `CCASR_ASR_ROUTING`。

## 3. 启动工作台

终端 1，在仓库根目录：

```bash
uv run python run_server.py
```

终端 2，在仓库的 `app/` 目录：

```bash
npm ci
npm run dev
```

打开 [localhost:5173](http://localhost:5173)。Vite 将 `/api` 转发至后端 8000 端口。

Windows 也可在依赖安装完成后双击 `start_backend.bat` 与 `start_frontend.bat`。

## 4. 构建部署

在 `app/` 中执行 `npm run build`，生成 `app/dist/`。从仓库根目录启动或重启后端：

```bash
uv run python run_server.py
```

访问 [localhost:8000](http://localhost:8000)，无需另开前端开发服务。后端在启动时检测构建目录，并支持 SPA 路由刷新。

进程托管可参考 [ecosystem.config.js](ecosystem.config.js)。其中前端条目为开发服务，使用已构建页面时只启动后端：

```bash
pm2 start ecosystem.config.js --only ccasr-backend
```

后端与 Vite 默认监听全部网络接口。当前应用没有账号鉴权，局域网或远程部署应由部署环境控制访问范围。

## 可选后端与 GPU

### faster-whisper

```bash
uv sync --extra whisper
```

`auto` 路由在语种超出中、粤、英、日、韩范围时使用 faster-whisper。网页只提供上述五种语种与自动检测，其他语种可通过 [上传 API](docs/API.md#上传录音) 指定；也可设 `CCASR_ASR_ROUTING=whisper` 强制使用。

此路径不做说话人分离。可选依赖约束 `av>=11,<19` 用于匹配现有 faster-whisper 调用。

### GPU 加速

uv 配置包含 CPU 版 PyTorch 索引。NVIDIA 环境需安装匹配的 CUDA 版 `torch` 与 `torchaudio`，按 [PyTorch 官方安装选择器](https://pytorch.org/get-started/locally/) 获取命令并安装到项目虚拟环境。

检查可用设备：

```bash
uv run python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('MPS:', hasattr(torch.backends, 'mps') and torch.backends.mps.is_available())"
```

手动替换后，`uv sync` 或自动同步可能重新解析依赖。确认环境后，可用 `uv run --no-sync python run_server.py` 启动。

## 常见问题

**首次转录很慢**

查看终端是否在下载或加载模型。首次运行依赖网络，后续复用缓存；确认 `ffmpeg -version` 可执行。

**有转录但没有纪要**

查看 [/health](http://localhost:8000/health) 中的 `llm` 字段。配置检查不发网络请求；真实连通性可用 `uv run python backend/tests/check_llm_live.py` 验证（发送一次请求）。修正配置、重启后端后重新生成纪要，无需重跑转录。

**说话人标签不准确**

短片段、噪声或重叠发言会影响聚类。可以改单句归属或批量改判；不足 1 秒的声纹片段不参与跨录音全局聚类。

**保存后纪要提示待更新**

纪要仍基于生成时的转录。保存修改后，在纪要页点击「重新生成」。

**重启后找不到会议**

确认运行账号与 `CCASR_OUTPUT_DIR` 未变化。数据默认在用户主目录下的 `CcAsr/output/`，不保存在代码仓库中。

**豆包云端能用吗**

相关接口要求公网音频 URL，当前上传链路未接入对象存储，不能直接使用。
