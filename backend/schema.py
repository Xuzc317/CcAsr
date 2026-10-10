"""CcAsr 输出 JSON Schema 定义"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import List, Optional
from enum import Enum
import json
import re
import uuid


class TaskState(str, Enum):
    """任务状态"""
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


@dataclass
class SummarizeJob:
    """AI 总结任务"""
    job_id: str
    task_id: str                          # 关联的转录任务 ID
    preset: str                           # 预设 key: "podcast_polish" | "meeting_summary"
    state: TaskState = TaskState.pending
    progress: float = 0.0
    has_reference: bool = False           # 是否上传了参考材料
    include_intro: bool = True            # 参考材料是否作为节目介绍（仅播客预设）
    error: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    # 结果存储在磁盘 output/{task_id}_summary.md，不存内存

    def to_dict(self) -> dict:
        d = {
            "job_id": self.job_id,
            "task_id": self.task_id,
            "preset": self.preset,
            "state": self.state.value,
            "progress": self.progress,
            "has_reference": self.has_reference,
            "has_result": self.state == TaskState.completed,
        }
        if self.error:
            d["error"] = self.error
        if self.created_at:
            d["created_at"] = self.created_at
        if self.completed_at:
            d["completed_at"] = self.completed_at
        return d


@dataclass
class TaskStatus:
    """API 任务状态模型"""
    task_id: str
    state: TaskState
    filename: str
    progress: float = 0.0          # 0.0 ~ 1.0
    result: Optional[dict] = None  # TranscriptionResult dict when completed
    error: Optional[str] = None    # 错误信息 when failed
    created_at: Optional[str] = None
    completed_at: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "task_id": self.task_id,
            "state": self.state.value,
            "filename": self.filename,
            "progress": self.progress,
        }
        if self.result is not None:
            d["result"] = self.result
        if self.error is not None:
            d["error"] = self.error
        if self.created_at is not None:
            d["created_at"] = self.created_at
        if self.completed_at is not None:
            d["completed_at"] = self.completed_at
        return d


@dataclass
class Segment:
    """单个语音片段"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    start: float = 0.0        # 起始时间 (秒)
    end: float = 0.0          # 结束时间 (秒)
    text: str = ""            # 识别文本 (已清洗标签)
    raw_text: str = ""        # 原始文本 (含 SenseVoice 标签)
    speaker: str = ""         # 说话人 ID, 如 "SPEAKER_0"
    emotion: str = ""         # 情绪标签: HAPPY/SAD/ANGRY/NEUTRAL/UNKNOWN
    language: str = ""        # 语种标签: zh/en/yue/ja/ko
    events: List[str] = field(default_factory=list)  # 声音事件: Speech/BGM/Applause 等


@dataclass
class TranscriptionResult:
    """完整转写结果"""
    audio_file: str                        # 源文件名
    duration: float                        # 音频总时长 (秒)
    num_speakers: int                      # 识别到的说话人数量
    segments: List[Segment]                # 所有语音片段
    peaks: List[float] = field(default_factory=list)  # 波形峰值 (flat array)
    model_info: dict = field(default_factory=lambda: {
        "asr": "SenseVoiceSmall",
        "vad": "fsmn-vad",
        "speaker": "cam++",
        "engine": "FunASR",
    })

    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)

    def to_plain_text(self) -> str:
        """输出纯文本格式 (带说话人标记)"""
        lines = []
        for seg in self.segments:
            ts = f"[{format_time(seg.start)} --> {format_time(seg.end)}]"
            lines.append(f"{ts} {seg.speaker}: {seg.text}")
        return "\n".join(lines)


def format_time(seconds: float) -> str:
    """秒数格式化为 HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


# SenseVoice 标签解析正则
_EMOTION_RE = re.compile(r"<\|(HAPPY|SAD|ANGRY|NEUTRAL|DISGUSTED|FEARFUL|SURPRISED|UNKNOWN)\|>")
_LANG_RE = re.compile(r"<\|(zh|en|yue|ja|ko|nospeech)\|>")
_EVENT_RE = re.compile(r"<\|(Speech|BGM|Applause|Laughter|Cry|Noise|Cough|Other)\|>")
_TAG_RE = re.compile(r"<\|.*?\|>")


def parse_sensevoice_tags(raw_text: str) -> dict:
    """从 SenseVoice 原始输出中解析情绪/语种/事件标签"""
    emotions = _EMOTION_RE.findall(raw_text)
    languages = _LANG_RE.findall(raw_text)
    events = _EVENT_RE.findall(raw_text)
    clean_text = _TAG_RE.sub("", raw_text).strip()

    return {
        "text": clean_text,
        "raw_text": raw_text,
        "emotion": emotions[0] if emotions else "UNKNOWN",
        "language": languages[0] if languages else "unknown",
        "events": events,
    }
