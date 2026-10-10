"""
ASR 后端分发器 — 根据 CCASR_BACKEND 环境变量选择识别后端。

- sensevoice（默认）：本地 FunASR Pipeline（VAD + SenseVoice + CAM++ 声纹聚类）
- doubao：火山引擎豆包录音文件识别（云端，需在 .env 配置密钥）

默认路径完全走本地，未配置豆包时不会 import doubao 模块、不影响本地流程。
"""

import logging

from backend.config import env

logger = logging.getLogger("ccasr.backends")


def get_backend(device: str = "auto"):
    """返回当前配置的 ASR 后端（本地 Pipeline 或豆包云端）"""
    backend = (env("BACKEND", "sensevoice") or "sensevoice").strip().lower()

    if backend == "doubao":
        from backend.doubao_backend import get_doubao_backend
        logger.info("ASR backend: doubao (cloud)")
        return get_doubao_backend()

    if backend != "sensevoice":
        logger.warning("未知 CCASR_BACKEND=%r，回退到本地 sensevoice", backend)

    from backend.pipeline import get_pipeline
    return get_pipeline(device=device)
