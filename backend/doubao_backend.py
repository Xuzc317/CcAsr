"""
豆包（火山引擎）录音文件识别后端 — 可选云端后端，默认不启用。

启用方式（.env 配置，二选一）：
    CCASR_BACKEND=doubao
    DOUBAO_ASR_API_KEY=xxx            # 新版控制台 APP Key（推荐）
    # 或旧版控制台：
    DOUBAO_ASR_APP_ID=xxx
    DOUBAO_ASR_ACCESS_TOKEN=xxx

可选配置：
    DOUBAO_ASR_RESOURCE_ID=volc.seedasr.auc   # 豆包录音文件识别模型2.0（默认）
                                              # 1.0 为 volc.bigasr.auc
    DOUBAO_ASR_POLL_TIMEOUT=1800              # 轮询超时（秒）

重要限制：火山 API 只接受**公网可访问的音频 URL**，不接受文件直传。
本地文件需要先自行上传到对象存储（如火山 TOS）拿到 URL 后再调用。
transcribe() 传入本地路径时会给出明确报错，不会静默失败。

未启用时（CCASR_BACKEND 缺省或=sensevoice），本模块不会被 import，
对本地 SenseVoice 流程零影响。
"""

import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional, Union
from urllib.parse import urlparse

from backend.schema import Segment, TranscriptionResult

logger = logging.getLogger("ccasr.doubao")

SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"

# CcAsr 语种 → 火山语种码；auto 表示不指定（火山自动支持中英文及方言）
_LANGUAGE_MAP = {
    "zh": "zh-CN",
    "en": "en-US",
    "yue": "yue-CN",
    "ja": "ja-JP",
    "ko": "ko-KR",
}

# 火山标准版支持的容器格式
_SUPPORTED_FORMATS = {"wav", "mp3", "ogg"}


def is_configured() -> bool:
    """检查豆包后端是否已配置密钥"""
    if os.getenv("DOUBAO_ASR_API_KEY"):
        return True
    return bool(os.getenv("DOUBAO_ASR_APP_ID") and os.getenv("DOUBAO_ASR_ACCESS_TOKEN"))


def _build_headers(task_id: str) -> dict:
    """按新版/旧版控制台构造鉴权头"""
    resource_id = os.getenv("DOUBAO_ASR_RESOURCE_ID", "volc.seedasr.auc")
    headers = {
        "X-Api-Resource-Id": resource_id,
        "X-Api-Request-Id": task_id,
    }
    api_key = os.getenv("DOUBAO_ASR_API_KEY")
    if api_key:
        headers["X-Api-Key"] = api_key
    else:
        headers["X-Api-App-Key"] = os.getenv("DOUBAO_ASR_APP_ID", "")
        headers["X-Api-Access-Key"] = os.getenv("DOUBAO_ASR_ACCESS_TOKEN", "")
    return headers


class DoubaoBackend:
    """火山引擎豆包录音文件识别（说话人分离由云端原生支持，10 人以内效果较好）"""

    def __init__(self):
        self.device = "cloud"

    @property
    def is_loaded(self) -> bool:
        return is_configured()

    def load(self) -> None:
        if not is_configured():
            raise RuntimeError(
                "豆包后端未配置密钥。请在 .env 中设置 DOUBAO_ASR_API_KEY（新版控制台）"
                "或 DOUBAO_ASR_APP_ID + DOUBAO_ASR_ACCESS_TOKEN（旧版控制台），"
                "或将 CCASR_BACKEND 改回 sensevoice 使用本地识别。"
            )

    def transcribe(
        self,
        audio_path: Union[str, Path],
        language: str = "zh",
        **_: object,
    ) -> TranscriptionResult:
        """
        转写音频，返回与本地 Pipeline 一致的 TranscriptionResult。

        audio_path 必须是公网可访问的 http(s) URL（火山 API 限制）。
        """
        self.load()

        audio_str = str(audio_path)
        if not audio_str.startswith(("http://", "https://")):
            raise RuntimeError(
                f"豆包后端仅支持公网音频 URL，收到本地路径: {audio_str}\n"
                "请先将音频上传到对象存储（如火山引擎 TOS）获取 URL，"
                "或改用本地后端（CCASR_BACKEND=sensevoice）。"
            )

        suffix = Path(urlparse(audio_str).path).suffix.lstrip(".").lower()
        if suffix not in _SUPPORTED_FORMATS:
            raise RuntimeError(
                f"豆包标准版仅支持 wav/mp3/ogg 格式，当前为 .{suffix}。"
                "请先转码（ffmpeg -i input.xxx -ar 16000 -ac 1 output.wav）。"
            )

        task_id = uuid.uuid4().hex
        self._submit(task_id, audio_str, suffix, language)
        result_json = self._poll(task_id)
        return self._to_result(audio_str, result_json)

    # ── 内部方法 ──────────────────────────────────────────────

    def _submit(self, task_id: str, url: str, fmt: str, language: str) -> None:
        import requests

        headers = _build_headers(task_id)
        headers["X-Api-Sequence"] = "-1"

        request_cfg = {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "enable_speaker_info": True,   # 说话人分离（10 人以内效果较好）
            "show_utterances": True,       # 返回分句（含时间戳/说话人）
        }
        lang_code = _LANGUAGE_MAP.get(language)
        audio_cfg = {"url": url, "format": fmt}
        if lang_code:
            audio_cfg["language"] = lang_code

        body = {
            "user": {"uid": "ccasr"},
            "audio": audio_cfg,
            "request": request_cfg,
        }

        logger.info("[doubao %s] Submitting: %s", task_id[:8], url)
        resp = requests.post(SUBMIT_URL, headers=headers, json=body, timeout=30)
        status = resp.headers.get("X-Api-Status-Code", "")
        message = resp.headers.get("X-Api-Message", "")
        if status != "20000000":
            raise RuntimeError(f"豆包任务提交失败: {status} {message}")
        logger.info("[doubao %s] Submitted OK", task_id[:8])

    def _poll(self, task_id: str) -> dict:
        import requests

        timeout_s = int(os.getenv("DOUBAO_ASR_POLL_TIMEOUT", "1800"))
        headers = _build_headers(task_id)
        t0 = time.time()

        while True:
            resp = requests.post(QUERY_URL, headers=headers, json={}, timeout=30)
            status = resp.headers.get("X-Api-Status-Code", "")
            message = resp.headers.get("X-Api-Message", "")

            if status == "20000000":
                return resp.json()
            if status in ("20000001", "20000002"):  # 处理中 / 排队中
                if time.time() - t0 > timeout_s:
                    raise TimeoutError(f"豆包任务超时（>{timeout_s}s）: {task_id}")
                time.sleep(2)
                continue
            raise RuntimeError(f"豆包识别失败: {status} {message}")

    @staticmethod
    def _to_result(audio_url: str, data: dict) -> TranscriptionResult:
        """火山响应 → TranscriptionResult（说话人 ID 归一化为 SPEAKER_0/1/...）"""
        result = data.get("result", {})
        utterances = result.get("utterances", [])
        duration_ms = data.get("audio_info", {}).get("duration", 0)

        speaker_map: dict[str, str] = {}
        segments = []
        for utt in utterances:
            text = (utt.get("text") or "").strip()
            if not text:
                continue
            additions = utt.get("additions") or {}
            spk_raw = str(additions.get("speaker") or utt.get("speaker") or "0")
            if spk_raw not in speaker_map:
                speaker_map[spk_raw] = f"SPEAKER_{len(speaker_map)}"
            segments.append(Segment(
                start=utt.get("start_time", 0) / 1000.0,
                end=utt.get("end_time", 0) / 1000.0,
                text=text,
                raw_text=text,
                speaker=speaker_map[spk_raw],
                emotion="",
                language="",
                events=[],
            ))

        speakers = {s.speaker for s in segments}
        duration = duration_ms / 1000.0 if duration_ms else (segments[-1].end if segments else 0.0)
        logger.info("[doubao] Done: %d segments, %d speakers", len(segments), len(speakers))

        return TranscriptionResult(
            audio_file=Path(urlparse(audio_url).path).name or "remote_audio",
            duration=duration,
            num_speakers=len(speakers),
            segments=segments,
            peaks=[],  # 云端模式无本地波形数据，前端按空 peaks 降级处理
        )


# 全局单例
_backend: Optional[DoubaoBackend] = None


def get_doubao_backend() -> DoubaoBackend:
    global _backend
    if _backend is None:
        _backend = DoubaoBackend()
    return _backend
