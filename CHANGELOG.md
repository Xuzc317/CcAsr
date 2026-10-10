# 更新日志

## [未发布]

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
