"""
ASR 后端分发器 —— 按语言/场景选择识别后端。

后端：
  - sensevoice（默认）：本地 FunASR Pipeline
        VAD(fsmn-vad) + ASR(SenseVoiceSmall) + 声纹(CAM++ 谱聚类)
        覆盖 zh / yue / en / ja / ko，**带说话人分离**
  - doubao：火山引擎豆包录音文件识别（云端，需 .env 配置密钥）
  - whisper：faster-whisper 本地多语种兜底（**不带说话人分离**）

路由（可用 CCASR_ASR_ROUTING 覆盖，默认 auto）：
  * auto：
      - 语种属于 SenseVoice 覆盖范围（zh/yue/en/ja/ko）→ sensevoice
      - 超出覆盖范围 → whisper（多语种兜底）
  * 也可强制指定：
      CCASR_ASR_ROUTING=sensevoice / whisper / doubao

设计依据（见 docs/ 调研与 CHANGELOG）：
  - 实测 faster-whisper 的 small/tiny 档中文明显弱于 SenseVoice
    （tiny 把"语音识别"听成"與因時別"），所以中文默认不走 whisper。
  - faster-whisper 无 diarization，走它会丢失说话人分离，故仅在
    SenseVoice 不支持的语种上启用；这一点会记录 info 提示用户。

兼容：旧的 CCASR_BACKEND 仍然生效（值为 doubao/whisper 时等价于强制路由）。
"""

from __future__ import annotations

import logging

from backend.config import env

logger = logging.getLogger("ccasr.backends")

# SenseVoiceSmall 官方发布的语种（官方 README 明示 zh/yue/en/ja/ko）
SENSEVOICE_LANGUAGES = {"zh", "yue", "en", "ja", "ko"}

VALID_ROUTING = {"auto", "sensevoice", "doubao", "whisper"}


def _resolve_routing() -> str:
    """
    决定路由策略。

    优先级：CCASR_ASR_ROUTING > CCASR_BACKEND > auto
    （保留 CCASR_BACKEND 是为了兼容旧配置，避免升级后静默失效）
    """
    raw = (env("ASR_ROUTING", "") or "").strip().lower()
    if not raw:
        raw = (env("BACKEND", "") or "").strip().lower()
    if not raw:
        return "auto"
    if raw not in VALID_ROUTING:
        logger.warning("未知 ASR 路由 %r，回退 auto（可选：%s）",
                       raw, "/".join(sorted(VALID_ROUTING)))
        return "auto"
    return raw


def choose_backend_name(language: str = "zh", routing: str | None = None) -> str:
    """
    决定用哪个后端（纯函数，便于测试）。

    Args:
        language: 本项目语种码（zh/en/yue/ja/ko/auto/其它）
        routing: 显式路由策略；None 时读环境变量

    Returns:
        "sensevoice" | "doubao" | "whisper"
    """
    mode = (routing or _resolve_routing()).strip().lower()
    if mode in ("sensevoice", "doubao", "whisper"):
        return mode

    # mode == "auto"
    lang = (language or "zh").strip().lower()
    if lang in SENSEVOICE_LANGUAGES or lang == "auto":
        return "sensevoice"

    logger.info(
        "语种 %r 不在 SenseVoice 覆盖范围（zh/yue/en/ja/ko），改用 faster-whisper；"
        "注意该路径不做说话人分离", lang,
    )
    return "whisper"


def get_backend(device: str = "auto", language: str = "zh"):
    """
    返回当前配置的 ASR 后端实例。

    Args:
        device: 推理设备（仅本地后端使用）
        language: 目标语种，用于 auto 路由
    """
    name = choose_backend_name(language)

    if name == "doubao":
        from backend.doubao_backend import get_doubao_backend
        logger.info("ASR backend: doubao (cloud)")
        return get_doubao_backend()

    if name == "whisper":
        from backend.whisper_backend import get_whisper_backend
        logger.info("ASR backend: faster-whisper (local, multilingual, no diarization)")
        return get_whisper_backend()

    from backend.pipeline import get_pipeline
    logger.info("ASR backend: sensevoice (local, with diarization)")
    return get_pipeline(device=device)


def describe_routing() -> dict:
    """给 /health 与调试用的路由说明。"""
    mode = _resolve_routing()
    return {
        "mode": mode,
        "sensevoice_languages": sorted(SENSEVOICE_LANGUAGES),
        "whisper_model": env("WHISPER_MODEL", "small") or "small",
    }
