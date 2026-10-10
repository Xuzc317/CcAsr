# CcAsr 修复方案（待 review，暂不改代码）

> 编制日期：2026-10-10
> 验证环境：Windows / Python 3.13.14 / torch 2.14.1+cpu / funasr 1.4.16 / scikit-learn 1.9.1 / scipy
> 验证语料：`wx交接1-文档.wav`（19 分 16 秒中文双人对话，实测 228 个 VAD 段 / 217 个有效声纹 embedding）
>
> 本文所有结论均来自**实测复现**，不是代码推断。文中标注了每项证据的来源。

---

## 0. 总览

| # | 问题 | 严重度 | 影响 | 修复量 |
|---|------|--------|------|--------|
| 1 | 声纹聚类恒失败，永远只出 1 个说话人 | 🔴 严重 | 核心卖点（说话人分离）完全失效 | 中（~60 行） |
| 2 | 会议总结预设参数被丢弃 | 🔴 严重 | 「会议总结」不可用，永远走播客润色 | 极小（2 行） |
| 3 | 豆包后端与 Web 上传链路不兼容 | 🟡 中 | 开启后每个任务都失败 | 大（需定方案） |
| 4 | 元数据/文档/PM2 配置漂移 | 🟢 低 | 误导、看不懂、跑不起来 | 小 |

建议顺序：**问题 2（2 分钟）→ 问题 1（核心）→ 问题 4 → 问题 3（需先决策）**。

---

## 1. 🔴 问题 1：声纹聚类恒失败，永远只输出 1 个说话人

### 1.1 现象

真实产物 `C:\Users\59892\CcAsr\output\e60aab06fa0e.json`：

```
num_speakers: 1
segments: 228
speaker dist: Counter({'SPEAKER_0': 228})    ← 228 段全部同一人
```

日志（`server.log`）中的真凶：

```
ccasr.pipeline WARNING Speaker clustering failed, defaulting to SPEAKER_0: Input contains NaN.
```

### 1.2 根因（已逐层复现，非推断）

**排除项**：CAM++ 模型本身没问题。我把全部 217 个 embedding 抽出来逐一检查：

```
embeddings: 217, shapes: {(1, 192)}, dtype=float32
NaN 行: 0   Inf: 0   零范数行: 0
```

**真正原因**在 `backend/pipeline.py:480` 使用的 `affinity="cosine"`：

```
第 1 环  cosine 相似度天然含负值          → 实测 3424 个负项，min = -0.2487
第 2 环  亲和矩阵非 PSD，"度"= 行和可为负  → 实测节点 208 度 = -2.74
                                              节点 213 度 = -12.94
第 3 环  scipy 归一化 Laplacian 需 1/sqrt(度) → 负数开方 = NaN
第 4 环  sklearn check_array 拦下          → ValueError: Input contains NaN
         (_spectral_embedding.py:372)
第 5 环  except Exception 静默吞掉          → 全部回落 SPEAKER_0，界面无任何报错
```

两个负度节点是**短片段/噪声的离群 embedding**（范数 8.8–9.7，显著低于正常 12–25，实为长尾）。

对照实验（同一份真实数据）：

| 方案 | k=2 结果 |
|------|----------|
| 现状（原始 embedding + `affinity='cosine'`） | ❌ ValueError: Input contains NaN |
| 仅 L2 归一化 + `affinity='cosine'` | ❌ 仍然 NaN（余弦照样有负值） |
| **`(cos+1)/2` 映射到 [0,1]** | ✅ 144 / 73 |
| `clip(cos, 0, 1)` | ✅ 162 / 55 |

**结论：`affinity='cosine'` 这个用法本身对声纹聚类不成立**，必须换成非负亲和矩阵。仅归一化 embedding 救不了。

### 1.3 说话人数判据也要改（附实测数据）

即使 NaN 修好，现有「`2..min(n,10)` 全扫、取轮廓系数最大」的启发式**会过分割**。在修复后的亲和矩阵上实测：

```
=== 归一化 Laplacian 特征值 ===
  λ0 = 0.000000   间隙 λ1-λ0 = 0.918274   ← 压倒性最大
  λ1 = 0.918274   间隙 λ2-λ1 = 0.044192
  λ2 = 0.962467   间隙 λ3-λ2 = 0.025339
  λ3 = 0.987806   ...（之后都在 0.001 量级）

=== 轮廓系数 ===
  k=2: sil=+0.2539  sizes=[144, 73]   最小簇占比=0.336
  k=3: sil=+0.2793  sizes=[134, 53, 30]   ← argmax，但只比 k=2 高 0.025
  k=4: sil=+0.1526  （断崖式下跌）

=== 特征间隙判据 ===
  => k = 2   ✅

=== k=2 的稳定性（5 个 random_state）===
  sizes 恒为 {144,73}，一致率 100%   ✅
```

三个关键发现：

1. **特征间隙（eigengap）给出干净的 k=2**：λ1−λ0 = 0.918 比其它所有间隙大一个数量级以上，这是谱聚类里最经典、最可靠的判据。
2. **轮廓系数偏好 k=3，但优势仅 +0.025（0.2793 vs 0.2539）**，属噪声范围；且 k=4 直接崩到 0.1526，说明 k=3 是过分割的起点而非真实结构。
3. **层次聚类（Agglomerative, cosine, average）明显更差**，k=2 时给出荒谬的 `[216, 1]`（把 1 个离群点当独立说话人），**不要换成层次聚类**。

> ⚠️ 我**没有听过音频**，无法断言这通对话「确实」是 2 人。但 λ1−λ0 的绝对优势 + 簇规模均衡（144/73）+ 跨随机种子 100% 稳定，三者一致指向 k=2。
> **建议你改动前先人工确认这段音频是不是 2 个人**——若确认是 2 人，上表就是回归验收基线；若是 3 人以上，需下调 eigengap 权重，我会改用「eigengap 主判 + 轮廓系数次判取交集」。

### 1.4 修复方案

#### Layer 1（必须）— 非负亲和矩阵，消除 NaN 崩溃

改写 `backend/pipeline.py` 的 `_cluster_speakers()`（当前 447–506 行）：

```python
# 1) L2 归一化：CAM++ 声纹标准做法，消除 embedding 幅度差异
norms = np.linalg.norm(X, axis=1, keepdims=True)
X = X / np.maximum(norms, 1e-12)

# 2) 余弦相似度 → [0,1] 非负亲和矩阵（关键修复）
#    不加这一步，负的"度"会让归一化 Laplacian 产生 NaN
from sklearn.metrics.pairwise import cosine_similarity
A = (cosine_similarity(X) + 1.0) / 2.0
np.fill_diagonal(A, 1.0)

# 3) 用 precomputed 传入，不再让 sklearn 自己算 cosine
clustering = SpectralClustering(
    n_clusters=k, affinity="precomputed", random_state=42
)
labels = clustering.fit_predict(A)
```

#### Layer 2（建议）— 过滤不可靠片段的参与权

保持现有 `MIN_SPK_DURATION_S = 0.5`，但**把过短/低能量的片段排除出聚类，之后用时间最近邻回填**（当前代码已有「无 embedding 则继承前一段」的回填逻辑，复用即可）。

原因：那两个负度节点就是这类噪声片段。把它们踢出聚类，比让它们投票更稳。

> 注意：**不要**用「embedding 范数」做过滤阈值。实测正常片段范数 8.8–25 连续分布，没有干净的分离点，设阈值会误杀。用**时长**过滤更可靠（建议新增 `MIN_CLUSTER_DURATION_S = 1.0`，仅用于聚类、不用于 ASR）。

#### Layer 3（建议）— 更换说话人数判据

用 **eigengap 主判 + 轮廓系数守卫**，替代现在的「轮廓系数 argmax」：

```
k_max = min(len(embeddings) // 4, 10)          # 每簇至少 4 段，防过分割
求归一化 Laplacian 前 k_max+1 个最小特征值
k_eg = argmax(λ[i+1] - λ[i])  (i 从 1 开始，跳过 λ1-λ0)
k_sil = 轮廓系数 argmax（限定 k ≤ 4）
若 k_sil == k_eg: 采用
否则采用 k_eg（特征间隙在谱聚类中更可靠）
```

保守起见也可先用更简单的版本：**轮廓系数扫描限定 `k ≤ 4`**，即可避免 k=5..10 的过分割（实测 k≥4 轮廓系数断崖下跌，限 k≤4 时 argmax 会给 k=3，仍偏多，所以还是推荐 eigengap）。

#### Layer 4（必须）— 别再静默吞异常

当前 `except Exception` 把 bug 藏了两周。改为：

```python
except Exception as e:
    logger.error("说话人聚类失败，降级为单一说话人: %s", e, exc_info=True)
```

并在 `TranscriptionResult` 增加一个降级标记（如 `diarization_failed: bool`），让前端能显示「说话人分离失败」而不是假装成功。

### 1.5 验收标准

| 项 | 期望 |
|----|------|
| `e60aab06fa0e.json` 重跑后 | `num_speakers == 2`，`SPEAKER_0`/`SPEAKER_1` 簇规模约 144/73 |
| 日志 | 不再出现 `Speaker clustering failed` / `Input contains NaN` |
| 跨运行稳定性 | 连续 3 次重跑，说话人数一致、分段归属一致 |
| 纯文本输出 | `[HH:MM:SS] SPEAKER_x:` 出现两种标签交替 |

---

## 2. 🔴 问题 2：会议总结预设被丢弃（2 行改动）

### 2.1 现象与根因

前端 `app/src/components/SummarizeModal.tsx` → `api.ts:100 createSummarize()` 把 `preset`、`include_intro` 放进 **FormData（请求体）**：

```ts
const formData = new FormData();
formData.append('preset', preset);              // ← 在 body 里
formData.append('include_intro', String(includeIntro));
```

但后端 `backend/app.py:493-499` 把这两个参数声明为 **Query 参数**：

```python
async def create_summarize(
    task_id: str,
    background_tasks: BackgroundTasks,
    preset: str = Query(default="podcast_polish", ...),      # ← 只从 query string 读
    include_intro: bool = Query(default=True, ...),
    reference: UploadFile | None = File(default=None),
):
```

FastAPI 只从 query string 取 `preset`，FormData 里的同名字段被**静默忽略**，永远落到 `default`。

### 2.2 端到端复现（TestClient，已实测）

```
场景 1（现状，preset 放 multipart body）：
  发送 preset=meeting_summary
  >>> 后端实际收到: preset='podcast_polish' include_intro=True
  HTTP 202  resp_preset='podcast_polish'
  → ✗ BUG：被忽略，落到默认值

场景 2（preset 放 query string）：
  发送 ?preset=meeting_summary&include_intro=false
  >>> 后端实际收到: preset='meeting_summary' include_intro=False
  HTTP 202  resp_preset='meeting_summary'
  → ✅ 正确
```

### 2.3 修复方案（二选一）

**方案 A（推荐，改动最小）**：后端改 `Form(...)`

```python
from fastapi import Form
preset: str = Form(default="podcast_polish"),
include_intro: bool = Form(default=True),
```

前端零改动。缺点：`GET /api/summarize/presets` 等其它调用不受影响，但 `preset` 从 URL 变成 body，不利于手工 curl 调试。

**方案 B**：前端改成 query string

```ts
const url = `${API_BASE}/tasks/${taskId}/summarize?preset=${encodeURIComponent(preset)}&include_intro=${includeIntro}`;
const response = await fetch(url, { method: 'POST', body: formData });
```

保留 curl 可调试性。两者任选其一，**不要两边都改**（会引入重复定义）。

### 2.4 验收标准

UI 选「会议总结」→ 提交 → `output/{task_id}_summary_meta.json` 中 `"preset": "meeting_summary"`；选「播客整理润色」→ 得到 `podcast_polish`。同时验证 `include_intro=false` 时参考材料不作为节目介绍章节。

---

## 3. 🟡 问题 3：豆包后端与 Web 上传链路不兼容

### 3.1 现状

代码质量本身没问题：submit/query 轮询、新旧版鉴权头、`X-Api-Status-Code` 判定、说话人 ID 归一化、`model_name`/`enable_speaker_info` 参数都符合火山文档；未配置密钥时不 import，对本地零影响——**这一点你的设计目标已达成**。

但存在**架构级断点**，一旦打开 `CCASR_BACKEND=doubao`，Web 端每个任务都会失败：

```
火山 API 只接受公网可访问 URL        (doubao_backend.py:107 明确拒绝本地路径)
        ✗ 不匹配
app.py:164 传给后端的是 FileStore 本地路径
app.py:308 get_file_store().save_file(...) → output/files/{md5}.wav

且前端 api.ts:65 uploadAudio() 只有文件上传入口，没有任何"提交 URL"的途径
```

即：**不是配置问题，是链路缺口**。

### 3.2 三个候选方案（需你决策）

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. 新增 URL 任务入口** | 新增 `POST /api/tasks/url`，body 传公网 URL；前端加「从 URL 导入」输入框 | 改动可控，不动现有上传链路 | 需用户自己先把音频传上对象存储，体验割裂 |
| **B. 集成火山 TOS** | 上传后自动传 TOS → 取签名 URL → 调豆包 | 体验最顺，真正端到端可用 | 工作量最大；引入 TOS SDK/密钥，且需处理签名过期、生命周期清理 |
| **C. 换流式 ASR 接口** | 改用 `openspeech.bytedance.com/api/v3/sauc/bigmodel`（双向流式，支持音频流直传） | 无需对象存储，最贴合「本地文件直接转写」 | 需重写为流式分片协议，说话人分离支持情况需重新对文档确认 |

> ⚠️ 方案 C 我**没有核对过**火山当前流式接口是否支持 `enable_speaker_info`。若要选 C，我需要先去查官方文档确认，再给实现方案。

**我的建议：方案 A 起步**（1 天内可验证端到端），确认云端识别质量满意后，再决定是否投入 B。

### 3.3 顺带修正

- `doubao_backend.py` 返回的 `TranscriptionResult` 中 `model_info` 仍是硬编码的 `SenseVoiceSmall`/`cam++`/`FunASR`（`schema.py:106`），云端模式会误导。建议按后端动态填充，或加 `engine: "doubao"` 标识。
- `peaks=[]` 已注释说明前端降级处理，属已知设计，可接受。

---

## 4. 🟢 问题 4：配置与文档漂移

| 位置 | 问题 | 修正 |
|------|------|------|
| `ecosystem.config.js` | `cwd`/`interpreter` 硬编码为某台 macOS 机器的绝对路径，其他机器上无法启动 | 改为 `__dirname` 自动定位 + 按平台选择解释器 ✅ 已修 |
| `README.md` 架构图 | 写「Apple Silicon MPS GPU 加速」，实际为 CPU-only Windows | 改为「CUDA / MPS 自动检测, 无 GPU 回退 CPU」✅ 已修 |
| `README.md`、`INSTALL.md` | 命令用 `~/CcAsr`、`.venv/bin/python`（Unix 路径） | 补 Windows 等价命令 ✅ 已修 |
| `INSTALL.md` | 安装步骤只有 Homebrew/nvm/zsh | 补 Windows 段落（winget + uv）✅ 已修 |
| `run_server.py:14` | 无条件设 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`，非 macOS 无效（无害，但易误解） | 加 `sys.platform == "darwin"` 判断 |
| `README.md:218-224` | FAQ 只提 MPS 报错，未提「说话人分离失败」 | 修复问题 1 后补充 |

---

## 5. 建议执行顺序与验证方式

```
① 问题 2（2 行）        → TestClient 复现脚本验证 preset 生效
② 问题 1 Layer 1（非负亲和，~10 行）
                        → 重跑 wx交接1-文档.wav，确认不再 NaN、且出 2 人
③ 问题 1 Layer 2+3+4   → 连续 3 次重跑比对稳定性
④ 问题 4               → 清理文档/PM2
⑤ 问题 3               → 先定方案再动手
```

**回归基线（务必保留）**：`e60aab06fa0e.json` 修复前是「228 段 / 1 说话人」。修复后应为「228 段 / 2 说话人，约 144:73」。这是判断问题 1 是否真修好的唯一硬指标。

**注意事项**：
- 后端当前**正在运行**（pid 36504，端口 8000），`run_server.py` 开了 `reload=True` 且 `reload_dirs=["backend"]`，改 `backend/` 下代码会**自动热重载**。改 `pipeline.py` 会触发模型重新加载（约 14 秒），属正常。
- 改 `pipeline.py` 后**必须重新上传音频**才能验证，已有任务的 JSON 是旧结果，不会自动重算（可删除 `output/e60aab06fa0e.json` 后重建任务，音频仍在 `output/files/` 下，MD5 去重会复用，不会重复占空间）。
- 调参（如聚类判据）时建议把 217 个 embedding 缓存成 `.npy`（我诊断时就是这么做的），可**跳过 15 秒模型加载 + 70 秒推理**，把单次实验压到 1 秒内。需要的话我把这个缓存脚本一并给你。

---

## 6. 待你确认的三个问题

1. **`wx交接1-文档.wav` 实际是几个说话人？** 我实测推断为 2 人（eigengap λ1−λ0=0.918 压倒性、簇规模 144:73 均衡、跨随机种子 100% 稳定），但没听过音频。这决定问题 1 的验收基线。
2. **问题 3 选 A / B / C？** 若选 C，我需要先核对火山流式接口是否支持说话人分离。
3. **问题 4 是否需要顺手做？** 属文档清理，不影响功能。
