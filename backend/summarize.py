"""AI 总结模块 — 使用 OpenAI 兼容 API 对转录结果进行 LLM 总结/整理。"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

from openai import OpenAI

from backend.config import env, get_output_dir

logger = logging.getLogger("ccasr.summarize")

# ── 配置 ──────────────────────────────────────────────────────

BACKEND_DIR = Path(__file__).parent
PROMPT_DIR = BACKEND_DIR / "prompts"
OUTPUT_DIR = get_output_dir()


def _get_llm_config() -> dict:
    """从环境变量读取 LLM 配置。"""
    api_base = env("LLM_API_BASE", "")
    api_key = env("LLM_API_KEY", "")
    model = env("LLM_MODEL", "gpt-4o")
    max_context = int(env("LLM_MAX_CONTEXT", "1000000") or "1000000")

    if not api_base or not api_key:
        raise ValueError(
            "LLM 配置缺失，请在 .env 文件中设置 CCASR_LLM_API_BASE、CCASR_LLM_API_KEY、CCASR_LLM_MODEL\n"
            "参考 .env.example"
        )

    return {
        "api_base": api_base,
        "api_key": api_key,
        "model": model,
        "max_context": max_context,
    }


def get_client() -> OpenAI:
    """创建 OpenAI 兼容客户端。"""
    config = _get_llm_config()
    return OpenAI(api_key=config["api_key"], base_url=config["api_base"])


# ── 预设管理 ──────────────────────────────────────────────────

PRESETS = {
    "podcast_polish": {
        "label": "播客整理润色",
        "description": "整理全文、修正ASR错误、添加说话人标签、保留完整内容",
        "prompt_dir": "podcast_polish",
        "has_intro_option": True,  # 是否支持"参考材料作为节目介绍"选项
    },
    "meeting_summary": {
        "label": "会议总结",
        "description": "提炼议题、决议、待办事项，生成结构化会议总结",
        "prompt_dir": "meeting_summary",
        "has_intro_option": False,
    },
}


def get_preset_list() -> list[dict]:
    """返回预设列表（给前端展示用）。"""
    return [
        {"key": k, "label": v["label"], "description": v["description"]}
        for k, v in PRESETS.items()
    ]


def _load_prompt(preset: str, filename: str) -> str:
    """加载预设的 prompt 模板。"""
    preset_info = PRESETS.get(preset)
    if not preset_info:
        raise ValueError(f"未知预设: {preset}")

    path = PROMPT_DIR / preset_info["prompt_dir"] / filename
    if not path.exists():
        raise FileNotFoundError(f"Prompt 文件不存在: {path}")
    return path.read_text(encoding="utf-8").strip()


# ── 转录文本格式化 ────────────────────────────────────────────

def format_transcript(result: dict) -> str:
    """将转录结果 JSON 转换为文本格式（供 LLM 处理）。

    格式：
    [00:00:00] SPEAKER_0: 文本内容
    [00:00:05] SPEAKER_1: 文本内容
    """
    lines = []
    for seg in result.get("segments", []):
        speaker = seg.get("speaker", "UNKNOWN")
        start = seg.get("start", 0)
        text = seg.get("text", "").strip()
        if text:
            ts = _format_timestamp(start)
            lines.append(f"[{ts}] {speaker}: {text}")
    return "\n".join(lines)


def _format_timestamp(seconds: float) -> str:
    """秒数格式化为 HH:MM:SS"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# ── Token 估算与分段 ──────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """粗略估算 token 数量。

    中文约 1.5 token/字，英文约 0.25 token/字符（4字符≈1token）。
    """
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - cjk
    return int(cjk * 1.5 + other * 0.25)


def split_transcript(text: str, max_tokens: int) -> list[str]:
    """将转录文本按段落分割，使每段不超过 max_tokens。

    按行分割（每行是一个说话人片段），累积到接近上限后切分。
    """
    if estimate_tokens(text) <= max_tokens:
        return [text]

    lines = text.split("\n")
    chunks = []
    current_lines = []
    current_tokens = 0

    for line in lines:
        line_tokens = estimate_tokens(line)
        if current_tokens + line_tokens > max_tokens and current_lines:
            chunks.append("\n".join(current_lines))
            current_lines = []
            current_tokens = 0
        current_lines.append(line)
        current_tokens += line_tokens

    if current_lines:
        chunks.append("\n".join(current_lines))

    logger.info("转录文本分段: %d 段 (max_tokens=%d)", len(chunks), max_tokens)
    return chunks


# ── Prompt 构建 ───────────────────────────────────────────────

def build_user_prompt(
    preset: str,
    transcript: str,
    audio_title: str = "",
    reference: Optional[str] = None,
    include_intro: bool = True,
) -> str:
    """构建 user prompt。"""
    template = _load_prompt(preset, "user.md")

    # 构建参考材料部分
    reference_section = ""
    if reference:
        preset_info = PRESETS[preset]
        if preset_info["has_intro_option"] and include_intro:
            ref_template = _load_prompt(preset, "reference_with_intro.md")
        elif preset_info["has_intro_option"]:
            ref_template = _load_prompt(preset, "reference_without_intro.md")
        else:
            # 会议总结等不区分 intro 的预设
            ref_path = PROMPT_DIR / preset_info["prompt_dir"] / "reference.md"
            if ref_path.exists():
                ref_template = ref_path.read_text(encoding="utf-8").strip()
            else:
                ref_template = "## 参考材料\n\n{reference}\n\n---\n"
        reference_section = ref_template.format(reference=reference)

    # 时间戳指令（播客整理特有）
    if preset == "podcast_polish":
        timestamp_instruction = "请去除所有时间戳。"
    else:
        timestamp_instruction = ""

    return template.format(
        audio_title=audio_title,
        reference_section=reference_section,
        transcript=transcript,
        timestamp_instruction=timestamp_instruction,
    )


# ── LLM 调用 ─────────────────────────────────────────────────

def call_llm(
    client: OpenAI,
    preset: str,
    transcript: str,
    audio_title: str = "",
    reference: Optional[str] = None,
    include_intro: bool = True,
) -> str:
    """调用 LLM 进行总结/整理。

    如果转录文本超过上下文长度，自动分段处理后合并。
    """
    config = _get_llm_config()
    max_context = config["max_context"]

    # 留出空间给 prompt 模板 + 参考材料 + 输出（预留 30% 给输出）
    effective_limit = int(max_context * 0.7)

    chunks = split_transcript(transcript, effective_limit)
    system_prompt = _load_prompt(preset, "system.md")

    if len(chunks) == 1:
        # 单段处理
        user_prompt = build_user_prompt(preset, transcript, audio_title, reference, include_intro)
        logger.info("LLM 调用 (单段): preset=%s, model=%s, tokens≈%d",
                     preset, config["model"], estimate_tokens(user_prompt))
        return _call_llm_single(client, config["model"], system_prompt, user_prompt)

    # 多段处理
    logger.info("多段处理: %d 段", len(chunks))
    partial_results = []

    for i, chunk in enumerate(chunks):
        # 参考材料只在第一段传入
        ref = reference if i == 0 else None
        user_prompt = build_user_prompt(preset, chunk, audio_title, ref, include_intro)

        # 多段时添加上下文提示
        if i > 0:
            user_prompt = f"（接上文，第 {i+1}/{len(chunks)} 段）\n\n{user_prompt}"

        logger.info("LLM 调用 (段 %d/%d): tokens≈%d",
                     i + 1, len(chunks), estimate_tokens(user_prompt))
        result = _call_llm_single(client, config["model"], system_prompt, user_prompt)
        partial_results.append(result)

    # 合并结果
    if preset == "podcast_polish":
        # 播客整理：直接拼接
        return "\n\n".join(partial_results)
    else:
        # 会议总结：做一次最终合并
        logger.info("合并 %d 段部分总结", len(partial_results))
        merged_text = "\n\n---\n\n".join(partial_results)
        merge_prompt = _build_merge_prompt(preset, merged_text)
        return _call_llm_single(client, config["model"], system_prompt, merge_prompt)


def _call_llm_single(
    client: OpenAI,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> str:
    """单次 LLM 调用。"""
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
        max_tokens=32000,
    )

    result = response.choices[0].message.content

    if response.choices[0].finish_reason == "length":
        logger.warning("LLM 输出被截断 (finish_reason=length)")

    return result or ""


def _build_merge_prompt(preset: str, partial_summaries: str) -> str:
    """构建合并 prompt（用于多段会议总结的最终合并）。"""
    return f"""以下是分段生成的会议总结，请将它们合并为一份完整、连贯的会议总结。

要求：
1. 去除重复内容
2. 合并相同议题
3. 统一格式
4. 确保逻辑连贯

## 分段总结

{partial_summaries}

请输出合并后的完整会议总结。
"""


# ── 任务执行 ──────────────────────────────────────────────────

def run_summarize(
    task_id: str,
    preset: str,
    audio_title: str = "",
    reference_content: Optional[str] = None,
    include_intro: bool = True,
    progress_callback=None,
) -> str:
    """执行 AI 总结任务（在后台线程中调用）。

    Args:
        task_id: 关联的转录任务 ID
        preset: 预设 key ("podcast_polish" | "meeting_summary")
        audio_title: 音频文件名（不含扩展名），用作总结标题
        reference_content: 参考材料文本（可选）
        include_intro: 是否将参考材料作为节目介绍（仅播客预设有效）
        progress_callback: 进度回调 fn(progress: float, message: str)

    Returns:
        总结结果 markdown 文本
    """
    if progress_callback:
        progress_callback(0.1, "正在加载 LLM 配置...")

    # 获取 LLM 配置
    config = _get_llm_config()
    client = get_client()

    if progress_callback:
        progress_callback(0.2, "正在加载转录结果...")

    # 加载转录结果
    result_file = OUTPUT_DIR / f"{task_id}.json"
    if not result_file.exists():
        raise FileNotFoundError(f"转录结果文件不存在: {result_file}")

    with open(result_file, "r", encoding="utf-8") as f:
        result = json.load(f)

    # 格式化转录文本
    transcript = format_transcript(result)
    logger.info("转录文本: %d 字符, ≈%d tokens",
                len(transcript), estimate_tokens(transcript))

    if progress_callback:
        progress_callback(0.3, f"正在调用 LLM ({config['model']})...")

    # 调用 LLM
    summary = call_llm(
        client=client,
        preset=preset,
        transcript=transcript,
        audio_title=audio_title,
        reference=reference_content,
        include_intro=include_intro,
    )

    if progress_callback:
        progress_callback(0.9, "正在保存结果...")

    # 保存结果到磁盘
    summary_file = OUTPUT_DIR / f"{task_id}_summary.md"
    with open(summary_file, "w", encoding="utf-8") as f:
        f.write(summary)

    if progress_callback:
        progress_callback(1.0, "完成")

    logger.info("总结完成: %s (%d 字符)", summary_file, len(summary))
    return summary


def get_summary_filename(task_filename: str) -> str:
    """生成总结文件下载名：{音频文件名}_asr.md"""
    base = task_filename.rsplit(".", 1)[0] if "." in task_filename else task_filename
    return f"{base}_asr.md"
