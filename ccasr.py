#!/usr/bin/env python3
"""CcAsr CLI — 离线语音转文字 + 可选 AI 总结，免前台交互。"""

import os
import sys
import time
import json
import logging
from pathlib import Path

import click
from dotenv import load_dotenv

# 加载 .env（必须在 import torch 之前）
load_dotenv()

# 性能优化
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")


def _setup_logging(verbose: bool):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _find_reference(input_file: str) -> str | None:
    """自动查找与输入文件同名的参考材料（.md）"""
    base = os.path.splitext(input_file)[0]
    candidates = [
        f"{base}.md",
        f"{base}_intro.md",
        f"{base}_ref.md",
    ]
    for c in candidates:
        if os.path.exists(c) and c != input_file:
            return c
    return None


def _format_transcript(result_dict: dict) -> str:
    """将转录结果转为可读文本：[HH:MM:SS] SPEAKER: 文本"""
    lines = []
    for seg in result_dict.get("segments", []):
        speaker = seg.get("speaker", "UNKNOWN")
        start = seg.get("start", 0)
        text = seg.get("text", "").strip()
        if text:
            h = int(start // 3600)
            m = int((start % 3600) // 60)
            s = int(start % 60)
            lines.append(f"[{h:02d}:{m:02d}:{s:02d}] {speaker}: {text}")
    return "\n".join(lines)


@click.command()
@click.argument("audio", type=click.Path(exists=True))
@click.option("--language", "-l", default="zh", help="语种: auto/zh/en/yue/ja/ko (默认 zh)")
@click.option("--output", "-o", default=None, help="输出目录 (默认: 音频同目录)")
@click.option("--summarize", "-s", is_flag=True, default=False, help="转录后进行 AI 总结")
@click.option("--preset", "-p", default="podcast_polish",
              type=click.Choice(["podcast_polish", "meeting_summary"]),
              help="总结预设 (默认: podcast_polish)")
@click.option("--reference", "-r", default=None, type=click.Path(exists=True),
              help="参考材料文件 (默认: 自动查找同名 .md)")
@click.option("--no-intro", is_flag=True, default=False,
              help="不将参考材料作为节目介绍 (仅播客预设)")
@click.option("--no-text", is_flag=True, default=False,
              help="不输出纯文本转录文件 (.txt)")
@click.option("--device", "-d", default="auto", help="推理设备: auto/cpu/mps/cuda (默认 auto)")
@click.option("--verbose", "-v", is_flag=True, default=False, help="详细日志")
def cli(audio: str, language: str, output: str, summarize: bool, preset: str,
        reference: str, no_intro: bool, no_text: bool, device: str, verbose: bool):
    """CcAsr CLI — 离线语音转文字 + 可选 AI 总结。

    \b
    示例:
      ccasr input.m4a                       # 仅转录
      ccasr input.m4a -s                    # 转录 + AI 播客整理
      ccasr input.m4a -s -p meeting_summary # 转录 + 会议总结
      ccasr input.m4a -s -r intro.md        # 带参考材料
    """
    _setup_logging(verbose)
    logger = logging.getLogger("ccasr.cli")

    audio_path = Path(audio).resolve()
    audio_stem = audio_path.stem

    # 确定输出目录
    if output:
        out_dir = Path(output)
    else:
        out_dir = audio_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: 转录 ──────────────────────────────────────────
    click.echo(f"🎙  正在转录: {audio_path.name}  (语种: {language}, 设备: {device})")
    t0 = time.time()

    from backend.backends import get_backend
    pipeline = get_backend(device=device)
    result = pipeline.transcribe(audio_path=str(audio_path), language=language)

    elapsed = time.time() - t0
    n_seg = len(result.segments)
    duration = result.duration
    speakers = set(s.speaker for s in result.segments)
    rtf = elapsed / duration if duration > 0 else 0

    click.echo(f"✅  转录完成: {n_seg} 段, {len(speakers)} 个说话人, "
               f"时长 {duration:.0f}s, 耗时 {elapsed:.1f}s (RTF={rtf:.3f})")

    # 保存 JSON 结果
    json_path = out_dir / f"{audio_stem}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        f.write(result.to_json())
    click.echo(f"📄  JSON: {json_path}")

    # 保存纯文本转录（可选）
    if not no_text:
        transcript_text = _format_transcript(result.to_dict())
        txt_path = out_dir / f"{audio_stem}.txt"
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(transcript_text)
        click.echo(f"📄  TXT:  {txt_path}")

    # ── Step 2: AI 总结（可选）─────────────────────────────────
    if not summarize:
        click.echo("\n💡  提示: 加 -s 参数可自动进行 AI 总结")
        return

    click.echo(f"\n🤖  AI 总结中... (预设: {preset})")
    t1 = time.time()

    # 查找参考材料
    ref_content = None
    if reference:
        click.echo(f"📎  参考材料: {reference}")
        with open(reference, "r", encoding="utf-8") as f:
            ref_content = f.read()
    else:
        auto_ref = _find_reference(str(audio_path))
        if auto_ref:
            click.echo(f"📎  自动发现参考材料: {auto_ref}")
            with open(auto_ref, "r", encoding="utf-8") as f:
                ref_content = f.read()
        else:
            click.echo("📎  无参考材料")

    from backend.summarize import call_llm, get_client, estimate_tokens

    client = get_client()

    # 用已保存的 JSON 构建转录文本（与 summarize.py 一致的格式）
    with open(json_path, "r", encoding="utf-8") as f:
        result_dict = json.load(f)

    from backend.summarize import format_transcript
    transcript = format_transcript(result_dict)

    click.echo(f"📊  转录文本: {len(transcript)} 字符, ≈{estimate_tokens(transcript)} tokens")

    include_intro = not no_intro
    summary = call_llm(
        client=client,
        preset=preset,
        transcript=transcript,
        audio_title=audio_stem,
        reference=ref_content,
        include_intro=include_intro,
    )

    elapsed_s = time.time() - t1
    click.echo(f"✅  总结完成: {len(summary)} 字符, 耗时 {elapsed_s:.1f}s")

    # 保存总结结果
    summary_path = out_dir / f"{audio_stem}_asr.md"
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(summary)
    click.echo(f"📄  总结: {summary_path}")


if __name__ == "__main__":
    cli()
