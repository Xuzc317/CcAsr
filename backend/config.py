"""
CcAsr 配置解析 — 环境变量读取与输出目录管理。

统一收口环境变量读取，避免同一套逻辑散落在多个模块里。

环境变量前缀为 ``CCASR_``。为兼容旧版 ``WINASR_`` 前缀，
本模块会自动回退读取旧名并打印一次弃用警告；请尽快改为 ``CCASR_``。
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger("ccasr.config")

CURRENT_PREFIX = "CCASR_"
LEGACY_PREFIX = "WINASR_"

# 记录已警告过的旧变量名，避免重复刷日志
_warned: set[str] = set()


def env(name: str, default: str | None = None) -> str | None:
    """
    读取环境变量 ``CCASR_<name>``，缺失时回退到旧前缀 ``WINASR_<name>``。

    Args:
        name: 不含前缀的变量名，如 ``"BACKEND"`` / ``"LLM_API_KEY"``
        default: 两个前缀都不存在时的返回值

    Returns:
        变量值，或 default
    """
    key = CURRENT_PREFIX + name
    value = os.environ.get(key)
    if value:
        return value

    legacy_key = LEGACY_PREFIX + name
    legacy_value = os.environ.get(legacy_key)
    if legacy_value:
        if legacy_key not in _warned:
            _warned.add(legacy_key)
            logger.warning(
                "环境变量 %s 已弃用，请改用 %s（当前仍兼容读取）", legacy_key, key
            )
        return legacy_value

    return default


def _migrate_legacy_output_dir(target: Path) -> None:
    """
    一次性迁移：把旧版 ``~/WinASR/output`` 搬到 ``~/CcAsr/output``。

    仅在新目录不存在、且旧目录存在时执行；用重命名而非复制，失败则回退复制。
    迁移失败不会中断启动，只记录警告。
    """
    if target.exists():
        return

    legacy = Path.home() / "WinASR" / "output"
    if not legacy.is_dir():
        return

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            legacy.rename(target)          # 同盘：瞬间完成
        except OSError:
            # 跨盘或占用：退化为复制（copy2 保留元数据，含只读文件）
            shutil.copytree(legacy, target, copy_function=shutil.copy2)
            shutil.rmtree(legacy, ignore_errors=True)
        logger.info("已迁移历史输出目录: %s -> %s", legacy, target)
    except Exception as e:  # 迁移失败不影响使用，仅提示
        logger.warning("历史输出目录迁移失败（原目录保留）: %s -> %s: %s",
                       legacy, target, e)


def get_output_dir() -> Path:
    """
    返回输出目录（并确保存在）。

    优先使用 ``CCASR_OUTPUT_DIR``；否则用 ``~/CcAsr/output``，
    并自动迁移旧版 ``~/WinASR/output`` 中的数据。
    """
    override = env("OUTPUT_DIR")
    if override:
        out = Path(override)
        out.mkdir(parents=True, exist_ok=True)
        return out

    out = Path.home() / "CcAsr" / "output"
    _migrate_legacy_output_dir(out)
    out.mkdir(parents=True, exist_ok=True)
    return out
