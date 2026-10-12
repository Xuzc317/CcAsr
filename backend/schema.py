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


class ProjectState(str, Enum):
    """会议项目整体状态"""
    draft = "draft"              # 已建项目，尚未添加录音
    transcribing = "transcribing"  # 队列处理中（串行转录多段录音）
    summarizing = "summarizing"  # 全部转录完成，正在生成会议总结
    completed = "completed"      # 转录 + 总结均完成
    failed = "failed"            # 存在失败录音且无法继续


@dataclass
class Recording:
    """会议项目中的一段录音（对应一次转录任务）"""
    recording_id: str
    project_id: str
    filename: str                      # 原始文件名
    order: int = 0                     # 项目内顺序（决定拼接顺序）
    state: TaskState = TaskState.pending
    progress: float = 0.0
    duration: float = 0.0              # 音频时长（秒）
    language: str = "zh"
    error: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    has_embeddings: bool = False       # 是否已保存声纹向量（供项目级统一聚类）

    def to_dict(self) -> dict:
        d = {
            "recording_id": self.recording_id,
            "project_id": self.project_id,
            "filename": self.filename,
            "order": self.order,
            "state": self.state.value,
            "progress": self.progress,
            "duration": self.duration,
            "language": self.language,
        }
        if self.error:
            d["error"] = self.error
        if self.created_at:
            d["created_at"] = self.created_at
        if self.completed_at:
            d["completed_at"] = self.completed_at
        return d


@dataclass
class Project:
    """会议项目 — 一个文档（如「xx 会议」）可包含多段录音"""
    project_id: str
    name: str
    recordings: List[Recording] = field(default_factory=list)
    state: ProjectState = ProjectState.draft
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # 会议总结状态
    summary_state: TaskState = TaskState.pending   # 总结仅在全部转录完成后启动
    summary_progress: float = 0.0
    summary_error: Optional[str] = None
    summary_completed_at: Optional[str] = None
    # 提示词 / 参考材料
    reference_name: Optional[str] = None
    has_reference: bool = False
    # 转录在纪要生成之后又被编辑过 —— 提示用户「纪要待更新」
    summary_stale: bool = False

    @property
    def total_duration(self) -> float:
        return sum(r.duration for r in self.recordings)

    @property
    def done_count(self) -> int:
        return sum(1 for r in self.recordings
                   if r.state in (TaskState.completed, TaskState.failed))

    @property
    def failed_count(self) -> int:
        return sum(1 for r in self.recordings if r.state == TaskState.failed)

    @property
    def all_finished(self) -> bool:
        return bool(self.recordings) and all(
            r.state in (TaskState.completed, TaskState.failed)
            for r in self.recordings
        )

    @property
    def progress(self) -> float:
        """整体进度：各录音平均进度 + 总结阶段权重"""
        if not self.recordings:
            return 0.0
        base = sum(r.progress for r in self.recordings) / len(self.recordings)
        # 转录占总进度 80%，总结占 20%
        if self.summary_state == TaskState.completed:
            return 1.0
        if self.summary_state == TaskState.processing:
            return 0.8 + 0.2 * self.summary_progress
        return 0.8 * base

    def to_dict(self, include_recordings: bool = True) -> dict:
        d = {
            "project_id": self.project_id,
            "name": self.name,
            "state": self.state.value,
            "progress": round(self.progress, 4),
            "recording_count": len(self.recordings),
            "done_count": self.done_count,
            "failed_count": self.failed_count,
            "total_duration": round(self.total_duration, 2),
            "summary_state": self.summary_state.value,
            "summary_progress": round(self.summary_progress, 4),
            "has_summary": self.summary_state == TaskState.completed,
            "has_reference": self.has_reference,
            "summary_stale": self.summary_stale,
        }
        if self.reference_name:
            d["reference_name"] = self.reference_name
        if self.summary_error:
            d["summary_error"] = self.summary_error
        if self.created_at:
            d["created_at"] = self.created_at
        if self.updated_at:
            d["updated_at"] = self.updated_at
        if self.summary_completed_at:
            d["summary_completed_at"] = self.summary_completed_at
        if include_recordings:
            d["recordings"] = [r.to_dict() for r in self.recordings]
        return d


@dataclass
class TaskStatus:
    """API 任务状态模型（已被 Project/Recording 取代，保留以兼容旧数据读取）"""
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
