# README 配图

这些图片是 **CcAsr 真实界面**的截图，不是设计稿。

| 文件 | 内容 |
|------|------|
| `01-meeting-list.png` | 我的会议（一个会议 = 一份文档） |
| `03-summary.png` | 会议纪要（章节与版式组件） |
| `03b-evidence.png` | 会议纪要 + **证据链徽章**（README 首图） |
| `04-transcript.png` | 合并转录（跨录音统一时间轴、说话人改名） |
| `05-recordings.png` | 录音队列状态 |
| `demo-evidence-jump.gif` | 演示：点证据徽章 → 跳到合并转录并播放 |

## 重新生成

需要后端已在 `http://localhost:8000` 运行，且库里有**至少一个已生成纪要的会议**。

### 1. 静态截图

```bash
node app/scripts/capture-readme-shots.mjs
```

脚本会自动挑一个「有纪要且录音数 ≥ 2」的会议作为素材，
用 Chrome DevTools Protocol 以 2x 缩放截取 1440×900 视口。

### 2. 演示 GIF

先抓帧：

```bash
node app/scripts/capture-demo-frames.mjs
```

会在 `_frames/` 下产出 9 张 PNG（含点击证据徽章前后的对比）。
再用 ffmpeg 合成（`_frames` 里的文件名带括号，**用 PowerShell 而非 .cmd**，
否则 cmd 会把括号当成命令分隔符）：

```powershell
cd docs\images
$ff = "ffmpeg"   # 或 ffmpeg 的完整路径
$frames = @(
  @{f='f000-summary-evidence.png';    d=0.9},
  @{f='f001-summary-evidence-2.png';  d=0.7},
  @{f='f002-chip-highlight.png';      d=0.5},
  @{f='f003-chip-highlight-2.png';    d=0.9},
  @{f='f004-jumped-transcript.png';   d=1.3},
  @{f='f005-jumped-transcript-2.png'; d=0.7},
  @{f='f006-transcript-scroll.png';   d=0.7},
  @{f='f007-transcript-scroll-2.png'; d=0.7},
  @{f='f008-transcript-scroll-3.png'; d=1.6},
  @{f='f008-transcript-scroll-3.png'; d=0.1}
)
$lines = @('ffconcat version 1.0')
foreach ($x in $frames) { $lines += "file '_frames/$($x.f)'"; $lines += "duration $($x.d)" }
$lines | Set-Content frames.txt -Encoding ASCII

& $ff -y -f concat -safe 0 -i frames.txt -vf "fps=10,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" _palette.png
& $ff -y -f concat -safe 0 -i frames.txt -i _palette.png -lavfi "fps=10,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 demo-evidence-jump.gif

Remove-Item _palette.png, frames.txt
```

> `_frames/` 与 `_palette.png` 是中间产物，可以随时删除；
> 最终只保留本目录下的 5 张 PNG + 1 个 GIF（合计约 1.2 MB）。

## 注意

- 截图里的会议名是测试数据（`QA-20261012-multi`）。若换成真实会议名，
  注意别把客户名、参会人姓名带进公开仓库。
- 说话人显示名（张三/李四）是演示用的改名结果，非真实姓名。
