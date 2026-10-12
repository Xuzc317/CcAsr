# CcAsr 第二轮测试报告

日期：2026-10-12（北京时间）。版本：`103d8ec`。测试依据：更新后的 TESTING.md，重点覆盖新增的 4.1–4.5 编辑流程、纪要证据跳转与质量度量。测试前工作区干净。本轮仅新增测试报告与本地证据，未修改业务代码。

**结论：新版已具备全局改名、单句改判、正文校对、底部确认和撤销全部；批量改判有后端接口，尚无前端入口。保存与导出的数据链路已改善，但编辑状态同步和首次跨录音证据跳转仍阻碍完整验收。**

## 执行结果

环境：Windows、Python 3.13.14、已有 Node 24.19.0、CPU、本地真实 ASR/声纹模型、真实 DeepSeek `deepseek-chat`。未使用假 LLM 跑真实会议。未读取或记录 API key。PATH 中无 npm，使用 Node 执行项目已安装的同等脚本入口。

| 测试范围 | 实测结果 | 判定 |
|---|---|---|
| 后端自动回归 | 7/7 套件；174 项断言通过 | 通过；部分外部依赖为 mock |
| 前端验证/构建/lint | 24/24；TypeScript、Vite 构建成功；ESLint 0 错误 | 通过 |
| 真实冒烟 | 约 9.11 秒，转录、纪要及 TXT/JSON/MD 导出成功 | 通过 |
| 两段真实会议 | 约 155.69 秒；228+359=587 段，2 个全局说话人，时间连续，两段标签集相同 | 按指南通过 |
| 分批/队列保护 | 三次入队均 draft，数量 1→2→3；统一处理 3/3；运行中追加为 409 | 通过 |
| 坏音频/重试 | 假 WAV 失败，ffmpeg 错误可见，服务正常；重试返回 202、retried=1 并重新执行 | 通过 |
| 特殊文件名/重复生成 | 导出名净化；重复生成返回 202/409，纪要重新生成完成 | 通过 |
| 直接访问会议路由 | `/meetings` 与新会议详情均 200；浏览器刷新恢复正常 | 通过，上一轮 404 已修复 |
| 4.1 全局显示名 | SPEAKER_0→leader、SPEAKER_1→我；可见标签立即同步，保存后持久化 | 通过 |
| 4.2 单句归属 | 第一段第一句改归 SPEAKER_1；API 前后比较，仅 1 句 speaker 变化 | 通过 |
| 4.3 文本校对 | 双击修改、Esc 退出，黄底高亮；仅 1 句 text 变化 | 通过；双击也会触发播放 |
| 4.4 底部统计/撤销 | 文字 1 段+归属 1 段+姓名 2 个=4 处；撤销全部恢复三类变更 | 通过 |
| 4.5 保存/刷新/下载 | 刷新后保留文本、归属、姓名；实际 TXT 首行为「我: 【已校对】测试文本」，后续使用 leader | 数据通过；保存提示/Tab 同步失败 |
| 纪要导出 | 当前 MD 仅一份待办；实际转录有 2 人，本次自动纪要却列出 4 个录音前缀人物 | 版式修复，身份表达失败 |
| 新证据链 | 12 条引用均对应真实片段，4/5 blocks 带证据；首次直接跳第二段时定位错误 | 部分通过 |
| 批量改判接口 | from/to 校验正常；SPEAKER_0→SPEAKER_1 一次合并 355 句，总人数变为 1，目标姓名保留 | 后端通过；前端待实现 |

现有真实验收脚本 39/40 检查通过，唯一未通过项仍是“用完整文件时长累计全局时间”的额外需求检查。补充 API 检查 17/18 通过，未通过项为纪要参会人数。这些计数不包含全部浏览器问题，也不等同于整体验收通过率。

## 新发现问题

| 编号/优先级 | 复现与实际结果 | 原因及建议 |
|---|---|---|
| R2-01 / P1 | 保存 4 处修改后切到录音 Tab，再回合并转录，显示名、文本和归属都回到旧值；API/刷新仍是新值 | 父组件 transcript 未接收保存响应，工作区重新挂载使用旧缓存。统一编辑状态，保存响应同步父级基线；否则后续编辑可能把旧值再次写回 |
| R2-02 / P1 | 在已保存状态把 leader 临时改为「leader-未保存」，切换 Tab 后草稿无提示丢失 | 编辑状态仅在条件挂载的 TranscriptWorkspace 内。把草稿提升到会议页；离开会议时提示，Tab 切换保留 |
| R2-03 / P1 | 首次打开纪要直接点击第二段「▶18:18」，自动切 Tab，但播放器跳至 1082.239 秒末尾并停止，期望约 5.86 秒 | transcript 尚未加载，handleJumpToRef 将全局 1098.59 秒直接用作本地时间。证据引用携带 local_start/segment_id，或先加载元数据再换算；不能以全局时间兜底 |
| R2-04 / P2 | 底栏待保存 4 处，成功后提示「已保存 2 处」 | 后端 updated 只计 text/speaker，漏计 speaker_map。前后端采用相同的字段差异计数，并返回分类明细 |
| R2-05 / P2 | 自动纪要将同一场 2 人会议列为 R1 SPEAKER_0/1、R2 SPEAKER_0/1 共 4 个参会人；保存 leader/我后再次生成，仍无 leader | `_format_transcript` 忽略 speaker_map，并将录音编号与说话人混排。明确提供全局参与者表，录音只作为来源字段，生成及校验按稳定 speaker ID 关联 |
| R2-06 / P2 | quality_metrics 输出“峰值内存约 33.03 MB”；同期服务 `/health` RSS 约 1291 MB | 脚本 `_PROC=psutil.Process()` 测到的是自身客户端；度量已有会议的当前值也被标作峰值。采集服务 PID、注明采样区间；当前值和峰值分别输出 |

R2-01/02/04 在新会议 `68d1c29ba716` 实测；R2-03 在已有会议 `36bce6221b13` 首次加载状态下实测，仅播放，未修改其数据。R2-05 的四个参与者是首次真实输出，LLM 后续措辞可能变化；忽略 speaker_map 的输入问题由代码及重新生成结果共同确认。

R2-03 的转录列表还停留在第一段开头，未自动滚动到证据句。建议播放时同时传 segment_id，用虚拟列表的索引定位并高亮，便于核对上下文。当前证据校验保证时间点附近有片段，不能据此宣称章节结论已得到语义验证。

## 上一轮问题复核

已验证修复：会议路由 404、TXT 姓名导出、跨会议音频请求（现为 404）、失败项重试、Markdown 重复待办、lint 报错。Windows 服务 RSS 也已能返回非零数值，但新质量脚本的采集对象仍有上述问题。

完整录音时长定义仍待统一：第一段文件实长 1159.729 秒，结果 duration 为 1091.730 秒；第二段 offset=1092.730 秒。若定义为“完整文件时长+1 秒间隔”，差约 68 秒。当前指南采用语音结束边界，且 local_start 回放不受这个差异影响，故该项为需求定义偏差，不混同为时间轴重置。

TESTING.md 回归预期仍写 6/6，而现有 run_all.py 实际为 7 套件，建议同步文档。

## 质量边界与证据

两段原始音频总时长约 2241.968 秒，此轮端到端 RTF 约 0.0694（包括纪要）。证据覆盖率 80% 指本次输出的 4/5 blocks 带引用，不代表事实准确率。未测 CER/WER、DER，也未做逐句人工听辨或精确定位误差度量；缺少人工标注，不能自动声明达标。quality_metrics 的原始 33 MB 内存数值不采纳为服务峰值。

没有发现 WinASR 可见水印，页面/图标/生成产物品牌仍为 CcAsr；旧配置迁移引用保持兼容。

保留本轮会议：`306f9929f0a0`（冒烟）、`68d1c29ba716`（双段）。分批和坏文件辅助会议已清理。批量改判探针执行后恢复了修改前的全部转录，最终仍保留 leader/我、首句校对及单句改判。原有会议未修改。

原始资料：[真实验收结果](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/results.json)、[补充检查](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/supplement_results.json)、[原始质量度量](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/metrics.json)、[重新生成纪要](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/regenerated_summary.md)。这些本地证据被 Git 忽略。

![四处改动及底部确认](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/edit_four_changes.jpg)

![保存计数不一致](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/saved_count_mismatch.jpg)

![保存后切 Tab 显示旧缓存](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/stale_after_tab.jpg)

![刷新后真实保存内容](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/reload_persisted.jpg)

![首次证据跳转至末尾](D:/Project/CcAsr/backend/tests/_out/acceptance_review_r2/evidence_initial.jpg)
