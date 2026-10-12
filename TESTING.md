# CcAsr 测试指南

> 面向测试人员。按顺序做即可，每步都给了**确切路径**和**预期结果**。
> 预计总耗时：约 **30 分钟**（其中 3 分钟是机器在跑，不用盯着）。

---

## 一、测试前准备（约 5 分钟）

### 1.1 确认服务在跑

打开浏览器访问：

```
http://localhost:8000
```

- **预期**：看到标题为 `CcAsr` 的页面，顶部有「我的会议」字样
- **看不到** → 见 [第六节 服务起不来](#六服务起不来怎么办)

### 1.2 确认配置正确

浏览器访问：

```
http://localhost:8000/health
```

看 `llm` 这一段，**必须是**：

```json
"llm": {
  "ok": true,
  "problems": [],
  "warnings": [],
  "model": "deepseek-chat",
  "key_set": true
}
```

- `ok` 为 `false` → `problems` 里会写明原因，按提示修 `.env` 后重启服务
- 顺便确认 `"diarization": "nonnegative+eigengap"`（说话人分离已修复的标志）

### 1.3 测试用音频位置

| 用例 | 完整路径 | 时长 |
|------|----------|------|
| **会议 A（两段连续录音）** | `D:\Project\CcAsr\samples\multi_meeting\会议A-第1段-文档.wav` | 19.3 分钟 |
| | `D:\Project\CcAsr\samples\multi_meeting\会议A-第2段-网站.wav` | 18.0 分钟 |
| 短音频（快速冒烟） | `D:\Project\CcAsr\samples\zh_sapi.wav` | 30 秒 |
| 短对话（测说话人） | `D:\Project\CcAsr\samples\test_dialog.wav` | 18 秒 |
| 双人样本 | `D:\Project\CcAsr\samples\test_two_speakers.wav` | — |

> 会议 A 是**同一场会议被切成两段**，专门用来验证「多段录音合成一份文档」。

---

## 二、核心用例（必测）

### 用例 1：快速冒烟 —— 单文件转录（约 1 分钟）

1. 打开 `http://localhost:8000`
2. 在「我的会议」输入框填：`测试1-冒烟`
3. 点「＋ 新建会议」→ 进入会议页
4. 点中间虚线框「点击或拖拽音频到此处」
5. 选择 `D:\Project\CcAsr\samples\zh_sapi.wav`
6. 点蓝色按钮「开始转录（1 段）」

**预期**：

- 顶部出现进度条，文案「正在转录 0/1 段…」
- 约 30 秒后变成「正在生成会议纪要…」
- 再等约 15 秒，进度条消失
- 切到「📝 会议纪要」Tab，能看到带标题、摘要、分栏卡片的纪要
- `http://localhost:8000/api/projects` 里该项目 `state` 为 `completed`

> ⏱ 首次运行会加载模型，可能多花 20–40 秒，属正常。

---

### 用例 2：核心功能 —— 两段录音合成一份文档（约 5 分钟）

**这是本工具的关键能力，请重点验证。**

1. 新建会议：`测试2-多段会议`
2. **一次性选中两个文件**：
   - 在文件选择框里按住 `Ctrl` 同时选中
   - `会议A-第1段-文档.wav`
   - `会议A-第2段-网站.wav`

   （路径：`D:\Project\CcAsr\samples\multi_meeting\`）
3. 确认下方出现排队列表，**顺序为**：
   ```
   1  会议A-第1段-文档.wav   35.4 MB
   2  会议A-第2段-网站.wav   33.0 MB
   ```
4. 点「开始转录（2 段）」

**预期**：

- 进度显示「正在转录 0/2」→「1/2」→「2/2」，**串行执行**（不会两个同时跑）
- 全程约 **3 分钟**
- 转到「📄 合并转录」Tab：
  - 顶部统计：**587 段 · 2 位说话人**
  - 列表中出现横向分隔条「`录音 1` 会议A-第1段-文档.wav」和「`录音 2` 会议A-第2段-网站.wav」
  - **全局时间连续**：第 1 段结束处约 `18:12`，第 2 段从约 `18:15` 接着往下，**不是从 0 重新开始**
- **两段共用同一套说话人编号**：整篇只出现 `SPEAKER_0` 和 `SPEAKER_1`，不应出现 `SPEAKER_2` 或更多

**判定要点**：如果第 2 段的时间戳从 `00:00` 重新开始，或出现 `SPEAKER_2`/`SPEAKER_3`，即为**失败**，请记录并反馈。

---

### 用例 3：播放跳转 —— 验证跨录音定位（约 2 分钟）

接着用例 2 的会议：

1. 在「📄 合并转录」里，随便找一段**属于录音 2** 的文字（在「录音 2」分隔条下方）
2. 点这一行右侧的 ▶ 按钮

**预期**：

- 下方播放器自动开始播放
- 播放器右侧显示「当前：会议A-第2段-网站.wav」
- 播放内容与所选文字**大致对应**（可能前后差 1–2 秒，属正常）

3. 再找一段**属于录音 1** 的文字，点 ▶

**预期**：播放器切换到「当前：会议A-第1段-文档.wav」

> 这一步验证的是"点击结论能跳回原声"，是本工具的核心体验之一。

---

### 用例 4：校对与说话人改名（约 3 分钟）

仍在用例 2 的会议：

1. **改文本**：双击任意一行文字 → 变成输入框 → 改成 `【已校对】测试文本` → 点页面别处失焦
2. **说话人改名**：在顶部「说话人」区域，把 `SPEAKER_0` 右侧输入框填成 `张三`，`SPEAKER_1` 填成 `李四`
3. 点右上角蓝色按钮「保存修改」

**预期**：

- 按钮变为「已保存」，旁边短暂出现绿色「已保存」
- 刷新页面（F5）后：
  - 改过的文字**仍是** `【已校对】测试文本`
  - 说话人标签显示为 **张三** / **李四**
- 点「⬇ TXT」下载，打开文件：
  - 能看到 `【已校对】测试文本`
  - 说话人显示为 `张三`/`李四`

**判定要点**：如果下载的 TXT 里文字**变回了原始内容**，即为**失败**（这是曾经修过的一个 bug）。

---

### 用例 5：会议纪要质量（约 3 分钟）

切到「📝 会议纪要」Tab。

**预期看到的版式**：

- 大标题（会议主题）
- `👥` 开头的参会人标签
- 左边框引用的**摘要**段落
- 若干个章节，每章是以下**版式组件**之一：
  - **分栏色块**：2–4 个并列小卡片，各带独立颜色和 `01`/`02` 编号
  - **三线表格**：上下粗线、中间细线
  - **垂直时间轴**：左侧圆点 + 竖线，配 `HH:MM`
  - **流程条**：`01 02 03` 编号卡片
  - **要点列表**：`• **加粗标签**：内容`
- **待办表格**：列头为「事项 / 责任人 / 截止时间」

**质量判定**：
- 内容应与会议主题相关（本场是"文档与网站交接"），能看出分支版本、工具、待办等实质内容
- **不应**是空话套话、也不应编造会议里没提的东西

**操作**：
1. 点「⬇ 导出纪要」下载 `.md` 文件，确认能打开、内容完整
2. 点「↻ 重新生成」→ 等约 20 秒 → 确认重新生成成功（内容可能略有不同，属正常）

---

## 三、补充用例（建议测）

### 用例 6：分批上传（约 2 分钟）

验证"先攒素材、再统一开跑"：

1. 新建会议 `测试6-分批`
2. 拖入 `zh_sapi.wav` → **不要点开始**（此用例要用「只入队不启动」的方式）
   - 说明：界面上的「开始转录」会同时入队并启动；若要测分批，请改用下面的 API 方式
3. 用命令行分批入队并统一启动：

```powershell
cd D:\Project\CcAsr

# 建会议（注意：PowerShell 的 $pid 是内置只读变量，这里用 $projId）
$p = Invoke-RestMethod -Method Post http://localhost:8000/api/projects `
      -ContentType 'application/json' -Body '{"name":"测试6-分批"}'
$projId = $p.project_id
Write-Host "会议 ID: $projId"

# 分三次入队，都不启动（start=false）
foreach ($n in 1..3) {
  curl.exe -s -X POST "http://localhost:8000/api/projects/$projId/recordings" `
    -F "files=@samples/zh_sapi.wav;filename=批$n.wav" -F "language=zh" -F "start=false" | Out-Null
  $s = Invoke-RestMethod "http://localhost:8000/api/projects/$projId"
  Write-Host "  入队第 $n 个 -> 项目状态=$($s.state)  录音数=$($s.recording_count)"
}

# 统一启动，并最多等 2 分钟
Invoke-RestMethod -Method Post "http://localhost:8000/api/projects/$projId/start" | Out-Null
Write-Host "已启动队列，等待完成…"
$n = 0
do { Start-Sleep 3; $s = Invoke-RestMethod "http://localhost:8000/api/projects/$projId"; $n++ }
while ($s.state -notin @('completed','failed') -and $n -lt 40)
Write-Host "完成: 处理 $($s.done_count)/$($s.recording_count) 段，状态=$($s.state)"
```

**预期**：

- 三次入队**都成功**，状态一直是 `draft`，录音数 1→2→3
- 启动后**三段全部**被处理，最终 `处理 3/3 段`

**判定要点**：如果第 2 次入队就报 `409 该项目队列正在运行`，即为**失败**（这是曾经修过的一个 bug）。

---

### 用例 7：队列占用保护（约 1 分钟）

1. 用用例 6 的会议，在队列**正在跑**的时候，再往同一个会议上传一个文件

**预期**：界面/接口返回错误 `该项目队列正在运行，请等待完成后再添加`（HTTP 409）

> 这是**正确行为**：防止多段录音并发抢占 CPU 导致两边都变慢。

---

### 用例 8：异常输入（约 3 分钟）

**8.1 非音频文件**

1. 新建会议 `测试8-坏文件`
2. 上传任意一个非音频文件（例如把 `README.md` 改名为 `假的.wav` 后上传）
3. 观察「🎧 录音」Tab

**预期**：该段显示红色「失败」，鼠标悬停/点击能看到错误信息（含 `ffmpeg` 字样）。
**服务不能崩溃**，页面其它功能仍可用。

**8.2 特殊文件名**

1. 新建会议，名字里带特殊字符：`测试：冒号/斜杠|竖线?问号*星号`
2. 上传 `zh_sapi.wav`
3. 等转录完成后点导出

**预期**：导出的文件名里**不含** `\ / : * ? " < > |` 这些字符（会被自动去掉），下载正常。

**8.3 队列中重复点击「重新生成」**

1. 打开一个已完成的会议，在纪要 Tab 连点两次「↻ 重新生成」

**预期**：第二次返回提示「纪要正在生成中」（HTTP 409），不会生成两份或报错崩溃。

---

### 用例 9：多语种路由（可选，约 1 分钟）

只验证路由判定，不需要真跑非中文音频：

```powershell
cd D:\Project\CcAsr
.\.venv\Scripts\python.exe backend\tests\test_routing.py
```

**预期**：末行显示 `路由验证: 29 通过, 0 失败`

---

## 四、回归测试（一键，约 2 分钟）

改完代码或想确认整体没退化时跑这个：

```powershell
cd D:\Project\CcAsr
.\.venv\Scripts\python.exe backend\tests\run_all.py
```

**预期**：

```
  6/6 套件通过
```

前端：

```powershell
cd D:\Project\CcAsr\app
npm run test:fe
```

**预期**：`前端验证: 24 通过, 0 失败`

> 这两组测试**不需要 API key、不需要手动启动服务**，可反复跑。

---

## 五、LLM 连通性自检（可选，约 10 秒）

```powershell
cd D:\Project\CcAsr
.\.venv\Scripts\python.exe backend\tests\check_llm_live.py
```

**预期**：

```
  ✅ 调用成功（x.xs）
     模型回复: '正常'
 配置可用，可以生成会议纪要了。
```

---

## 六、服务起不来怎么办

### 6.1 启动后端

```powershell
cd D:\Project\CcAsr
.\.venv\Scripts\python.exe run_server.py
```

或双击 `D:\Project\CcAsr\start_backend.bat`

### 6.2 端口被占用

```powershell
# 看谁占着 8000
Get-NetTCPConnection -LocalPort 8000 -State Listen

# 杀掉
Get-NetTCPConnection -LocalPort 8000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 6.3 确认健康

```powershell
Invoke-RestMethod http://localhost:8000/health | ConvertTo-Json -Depth 5
```

`status` 应为 `ok`，`llm.ok` 应为 `true`。

### 6.4 看日志

```
D:\Project\CcAsr\server.log        （正常输出）
D:\Project\CcAsr\server.err.log    （含错误堆栈）
```

### 6.5 首次运行很慢

首次会从 ModelScope 下载模型（约 1GB），期间看起来像"卡住"。等它跑完，后续走缓存。

---

## 七、安全注意事项（重要）

1. **不要提交 `.env`**
   里面有 DeepSeek API key。该文件已配置为被 git 忽略，但仍请勿手动 `git add -f`。
   验证方法：
   ```powershell
   cd D:\Project\CcAsr
   git status --porcelain | Select-String "\.env$"    # 应无输出
   ```

2. **不要在截图/日志里暴露 key**
   `.env` 第 9 行是 key。若要截图，请先遮挡。

3. **测试产生的会议是否需要清理**
   界面右上角每张会议卡片有 `✕` 可删除。删除会一并清掉该会议的转录与纪要。
   **注意：`测试2-多段会议` 如果删了，音频文件仍会保留**（MD5 去重存储），
   重新上传同一文件不会重复占空间。

---

## 八、问题反馈模板

发现问题时请提供：

```
【用例编号】用例 2
【操作步骤】上传两段录音后，切到「合并转录」Tab
【预期结果】整篇只有 SPEAKER_0 / SPEAKER_1
【实际结果】出现了 SPEAKER_0 / 1 / 2 / 3
【复现频率】必现 / 偶发（约 3 次出现 1 次）
【会议 ID】在浏览器地址栏 /meeting/ 后面那串，例如 7902032329d9
【截图】
【日志】server.err.log 里对应时间段的片段
```

> **会议 ID 很重要** —— 有了它可以直接查该会议的转录结果与状态。

---

## 九、已知限制（不算 bug）

| 限制 | 说明 |
|------|------|
| 台语/闽南语 | 不支持。主流模型均无此语种，当前只覆盖 中/粤/英/日/韩 + faster-whisper 的其它语种 |
| 非中英日韩粤语种 | 会自动切到 faster-whisper，但**该路径不做说话人分离**（统一为 SPEAKER_0） |
| 豆包云端后端 | 接口已实现但**当前流程不可用** —— 火山只接受公网音频 URL，与"上传录音"流程不兼容。不要开启 `CCASR_ASR_ROUTING=doubao` |
| 说话人数量 | 自动判定（特征间隙法），最多 10 人。人数极多或片段极短时可能不准 |
| 并发 | 同一会议的队列**串行**执行；队列运行中不能追加录音 |
| 波形图 | 合并转录视图不显示波形（跨多个音频文件），但可正常播放与定位 |
