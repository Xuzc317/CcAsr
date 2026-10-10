"""faster-whisper 在本环境（Windows / Py3.13 / CPU）的冒烟测试。

重点验证：
  1. 能否加载模型（首次会从 HuggingFace 下载）
  2. 能否转写真实音频并给出词级时间戳
  3. av 版本是否踩到 `metadata_errors` 崩溃（av>=19 的已知问题）
  4. 语言自动识别（LID）是否可用
"""
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import time
from pathlib import Path

print("=" * 62)
print("faster-whisper 冒烟测试")
print("=" * 62)

import av
import ctranslate2
import faster_whisper
print(f"  av              : {av.__version__}")
print(f"  ctranslate2     : {ctranslate2.__version__}")
print(f"  faster_whisper  : {faster_whisper.__version__}")
print(f"  CPU 线程        : {ctranslate2.get_cuda_device_count()} 个 CUDA 设备")

WAV = Path("samples/zh_sapi.wav")
if not WAV.exists():
    raise SystemExit(f"缺少测试音频: {WAV}")

MODEL = os.environ.get("FW_MODEL", "tiny")   # 用 tiny 快速验证链路
print(f"\n=== 加载模型: {MODEL} (int8, CPU) ===")
t0 = time.time()
try:
    model = faster_whisper.WhisperModel(
        MODEL, device="cpu", compute_type="int8", cpu_threads=8,
    )
except Exception as e:
    print(f"  ❌ 模型加载失败: {type(e).__name__}: {e}")
    raise SystemExit(1)
print(f"  ✅ 加载成功 ({time.time()-t0:.1f}s)")

print(f"\n=== 转写: {WAV.name} ===")
t0 = time.time()
try:
    segments, info = model.transcribe(
        str(WAV),
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
    )
except TypeError as e:
    # 这是 av>=19 删除 metadata_errors 后的典型崩溃形态
    print(f"  ❌ 转写抛 TypeError（很可能就是 av 版本问题）: {e}")
    raise SystemExit(1)
except Exception as e:
    print(f"  ❌ 转写失败: {type(e).__name__}: {e}")
    raise SystemExit(1)

seg_list = list(segments)      # 生成器，必须物化
elapsed = time.time() - t0

print(f"  ✅ 转写完成，耗时 {elapsed:.1f}s")
print(f"     识别语言      : {info.language} (置信度 {info.language_probability:.3f})")
print(f"     音频时长      : {info.duration:.1f}s")
print(f"     实时率 RTF    : {elapsed / info.duration:.3f}" if info.duration else "")
print(f"     片段数        : {len(seg_list)}")

print("\n=== 前 5 段（含词级时间戳示例）===")
for i, s in enumerate(seg_list[:5]):
    print(f"  [{s.start:6.2f}-{s.end:6.2f}] {s.text.strip()}")
    if i == 0 and s.words:
        w = s.words[0]
        print(f"        首词: {w.word!r} @ {w.start:.2f}-{w.end:.2f} "
              f"(prob={getattr(w,'probability',float('nan')):.3f})")

print("\n=== 语言自动识别能力（不指定语言）===")
print(f"  检测为 {info.language!r}；Whisper 支持 {len(model.supported_languages)} 种语言")
for lang in ("zh", "en", "ja", "ko", "yue"):
    mark = "✅" if lang in model.supported_languages else "❌"
    print(f"    {mark} {lang}")
print(f"    {'❌'} nan (台语/闽南语) —— Whisper 语言表不含")

print(f"\n{'='*62}")
print("✅ faster-whisper 在本环境可用")
print("=" * 62)
