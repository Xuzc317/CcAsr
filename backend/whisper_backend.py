"""
faster-whisper 后端 —— 多语种兜底识别。

用途：SenseVoice 只覆盖 zh/yue/en/ja/ko，超出这 5 种语言时用 faster-whisper。

⚠️ 重要取舍
1. **中文请优先用 SenseVoice**。实测 faster-whisper 的 small/tiny 档中文明显更差
   （tiny 把"语音识别"听成"與因時別"），中文档位必须 large 级才有竞争力，
   而 large 在 CPU 上很慢。因此默认路由是"中文走 SenseVoice"。
2. **本后端不做说话人分离**。faster-whisper 本身不含 diarization，
   需要额外的 pyannote（gated 模型，商用条款未确认）。因此这里统一输出
   SPEAKER_0；若需要说话人分离，请用 SenseVoice 路径。
3. **依赖必须钉 `av<19`**。faster-whisper 的 requirements 只写 `av>=11` 无上界，
   而 av>=19 删除了 `metadata_errors` 参数，装了最新版会在转写时抛 TypeError。
   见 pyproject.toml 的依赖声明。

模型体积/速度参考（CPU int8）：
    tiny    ~75MB   最快，仅用于链路验证
    base    ~145MB
    small   ~480MB  多语种可用档
    medium  ~1.5GB
    large-v3 ~3GB   中文/多语种质量档，CPU 上最慢
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Optional, Union

from backend.config import env
from backend.schema import Segment, TranscriptionResult

logger = logging.getLogger("ccasr.whisper")

# 默认模型档位：small 在体积与多语种质量之间较平衡
DEFAULT_MODEL = "small"

# Whisper 语种码 → 本项目语种码（多数一致，仅个别需要转换）
_LANG_FROM_WHISPER = {
    "zh": "zh", "en": "en", "yue": "yue", "ja": "ja", "ko": "ko",
}

# 本项目语种码 → 传给 Whisper 的 language 参数；auto 表示交给它自动识别
_LANG_TO_WHISPER = {
    "zh": "zh", "en": "en", "yue": "yue", "ja": "ja", "ko": "ko",
    "auto": None,
}


class WhisperBackend:
    """faster-whisper（CTranslate2）本地多语种识别后端"""

    def __init__(self, model_size: Optional[str] = None,
                 device: Optional[str] = None):
        self.model_size = model_size or env("WHISPER_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL
        self.device = device or env("WHISPER_DEVICE", "cpu") or "cpu"
        self.compute_type = env("WHISPER_COMPUTE_TYPE", "int8") or "int8"
        self.cpu_threads = int(env("WHISPER_CPU_THREADS", "8") or "8")
        self._model = None

    # ── 生命周期 ──────────────────────────────────────────────

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        if self._model is not None:
            return
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError(
                "未安装 faster-whisper。请执行：\n"
                '  pip install "faster-whisper>=1.0" "av<19"\n'
                f"（原始错误：{e}）"
            ) from e

        logger.info("加载 faster-whisper 模型: %s (device=%s, compute=%s, threads=%d)",
                    self.model_size, self.device, self.compute_type, self.cpu_threads)
        t0 = time.time()
        self._model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
        )
        logger.info("faster-whisper 加载完成 (%.1fs)", time.time() - t0)

    # ── 转写 ──────────────────────────────────────────────────

    def transcribe(
        self,
        audio_path: Union[str, Path],
        language: str = "auto",
        **_,
    ) -> TranscriptionResult:
        self.load()
        audio_path = Path(audio_path)
        if not audio_path.exists():
            raise FileNotFoundError(f"音频文件不存在: {audio_path}")

        wl = _LANG_TO_WHISPER.get(language)
        logger.info("faster-whisper 转写: %s (language=%s)",
                    audio_path.name, wl or "auto")

        t0 = time.time()
        try:
            segments_iter, info = self._model.transcribe(
                str(audio_path),
                language=wl,              # None = 自动识别
                beam_size=5,
                vad_filter=True,          # 用内置 VAD 去掉静音，避免幻觉
                word_timestamps=True,
            )
            raw_segments = list(segments_iter)   # 生成器必须物化
        except TypeError as e:
            # av>=19 删除 metadata_errors 后的典型崩溃形态，给出可操作提示
            raise RuntimeError(
                "faster-whisper 调用失败（TypeError）。极可能是 av 版本过新：\n"
                '  请执行 pip install "av<19"\n'
                f"（原始错误：{e}）"
            ) from e

        elapsed = time.time() - t0
        detected = _LANG_FROM_WHISPER.get(info.language or "", info.language or "")

        segments: list[Segment] = []
        for s in raw_segments:
            text = (s.text or "").strip()
            if not text:
                continue
            segments.append(Segment(
                start=float(s.start),
                end=float(s.end),
                text=text,
                raw_text=text,
                # faster-whisper 不含说话人分离，统一 SPEAKER_0
                speaker="SPEAKER_0",
                emotion="",              # Whisper 不提供情绪标签
                language=detected,
                events=[],
            ))

        duration = float(getattr(info, "duration", 0.0) or 0.0)
        if not duration and segments:
            duration = segments[-1].end
        rtf = elapsed / duration if duration > 0 else 0.0

        logger.info(
            "faster-whisper 完成: %d 段, 语言=%s(%.3f), 时长=%.1fs, 耗时=%.1fs (RTF=%.3f)",
            len(segments), detected,
            float(getattr(info, "language_probability", 0.0) or 0.0),
            duration, elapsed, rtf,
        )

        return TranscriptionResult(
            audio_file=audio_path.name,
            duration=duration,
            num_speakers=1 if segments else 0,
            segments=segments,
            peaks=[],     # 云端/外语路径不生成波形，前端按空 peaks 降级
            model_info={
                "asr": f"faster-whisper-{self.model_size}",
                "vad": "whisper-builtin",
                "speaker": "none",          # 明确标注：未做说话人分离
                "engine": "faster-whisper",
                "detected_language": detected,
            },
        )


# ── 全局单例（按模型档位缓存）─────────────────────────────────

_instances: dict[str, WhisperBackend] = {}


def get_whisper_backend(model_size: Optional[str] = None) -> WhisperBackend:
    key = model_size or env("WHISPER_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL
    if key not in _instances:
        _instances[key] = WhisperBackend(model_size=key)
    return _instances[key]
