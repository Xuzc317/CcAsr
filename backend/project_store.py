"""
CcAsr 会议项目存储 — 文档化管理 + 多段录音串行队列。

数据布局（均在输出目录下）::

    projects.json                     # 全部项目元数据
    projects/{project_id}/
        recordings/{recording_id}.json    # 单段转录结果（含 peaks 的原始产物）
        recordings/{recording_id}.emb.npy # 声纹向量（供跨录音统一聚类）
        recordings/{recording_id}.embmeta.json
        transcript.json                   # 合并后的会议转录（跨录音统一时间轴）
        summary.md                        # 会议总结（自动生成）

设计要点：
- 一个项目 = 一个文档（如「xx 会议」），可导入多段录音
- 队列**串行**执行，避免多个大模型任务并发抢 CPU/GPU
- 全部录音转录完成后，先做**跨录音说话人统一**，再自动生成会议总结
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from backend.config import get_output_dir
from backend.schema import Project, ProjectState, Recording, TaskState

logger = logging.getLogger("ccasr.projects")

# 声纹向量最小片段时长：低于此值不参与项目级统一聚类
MIN_CLUSTER_DURATION_S = 1.0

# 合并转录时的空档兜底（秒）：用于给跨录音的时间轴留出间隔
DEFAULT_GAP_S = 1.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectStore:
    """会议项目管理器（JSON 持久化 + 串行转录队列）"""

    def __init__(self, output_dir: Optional[Path] = None):
        self.output_dir = output_dir or get_output_dir()
        self.projects_dir = self.output_dir / "projects"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.index_file = self.output_dir / "projects.json"

        self._projects: dict[str, Project] = {}
        # 项目级锁：保证同一项目的队列串行执行
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

        self._load()

    # ── 持久化 ────────────────────────────────────────────────

    def _load(self) -> None:
        if not self.index_file.exists():
            return
        try:
            data = json.loads(self.index_file.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("项目索引读取失败: %s", e)
            return

        for d in data.get("projects", []):
            try:
                recs = [
                    Recording(
                        recording_id=r["recording_id"],
                        project_id=r["project_id"],
                        filename=r["filename"],
                        order=r.get("order", 0),
                        state=TaskState(r.get("state", "pending")),
                        progress=r.get("progress", 0.0),
                        duration=r.get("duration", 0.0),
                        language=r.get("language", "zh"),
                        error=r.get("error"),
                        created_at=r.get("created_at"),
                        completed_at=r.get("completed_at"),
                    )
                    for r in d.get("recordings", [])
                ]
                proj = Project(
                    project_id=d["project_id"],
                    name=d["name"],
                    recordings=recs,
                    state=ProjectState(d.get("state", "draft")),
                    created_at=d.get("created_at"),
                    updated_at=d.get("updated_at"),
                    summary_state=TaskState(d.get("summary_state", "pending")),
                    summary_progress=d.get("summary_progress", 0.0),
                    summary_error=d.get("summary_error"),
                    summary_completed_at=d.get("summary_completed_at"),
                    reference_name=d.get("reference_name"),
                    has_reference=d.get("has_reference", False),
                )
                # 重启后把中断的任务标记为失败，避免永远卡在 processing
                for r in proj.recordings:
                    if r.state in (TaskState.pending, TaskState.processing):
                        r.state = TaskState.failed
                        r.error = "服务重启导致任务中断，请重新提交"
                if proj.state in (ProjectState.transcribing, ProjectState.summarizing):
                    proj.state = ProjectState.draft
                self._projects[proj.project_id] = proj
            except Exception as e:
                logger.warning("跳过损坏的项目记录: %s", e)

        logger.info("Loaded %d projects", len(self._projects))

    def save(self) -> None:
        """原子写入项目索引"""
        data = {
            "updated_at": _now(),
            "projects": [p.to_dict(include_recordings=True)
                         for p in self._projects.values()],
        }
        tmp = self.index_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(str(tmp), str(self.index_file))

    def _project_dir(self, project_id: str) -> Path:
        d = self.projects_dir / project_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _rec_dir(self, project_id: str) -> Path:
        d = self._project_dir(project_id) / "recordings"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _lock_for(self, project_id: str) -> threading.Lock:
        with self._locks_guard:
            if project_id not in self._locks:
                self._locks[project_id] = threading.Lock()
            return self._locks[project_id]

    # ── 项目 CRUD ─────────────────────────────────────────────

    def create_project(self, name: str) -> Project:
        name = (name or "").strip()
        if not name:
            raise ValueError("项目名称不能为空")
        pid = uuid.uuid4().hex[:12]
        proj = Project(
            project_id=pid,
            name=name,
            created_at=_now(),
            updated_at=_now(),
        )
        self._projects[pid] = proj
        self._project_dir(pid)
        self.save()
        logger.info("[project %s] 已创建: %s", pid, name)
        return proj

    def get(self, project_id: str) -> Optional[Project]:
        return self._projects.get(project_id)

    def list_projects(self) -> list[Project]:
        return sorted(self._projects.values(),
                      key=lambda p: p.updated_at or "", reverse=True)

    def rename(self, project_id: str, name: str) -> Project:
        proj = self._require(project_id)
        name = (name or "").strip()
        if not name:
            raise ValueError("项目名称不能为空")
        proj.name = name
        proj.updated_at = _now()
        self.save()
        return proj

    def delete(self, project_id: str) -> None:
        proj = self._require(project_id)
        self._projects.pop(project_id, None)
        self.save()
        d = self.projects_dir / project_id
        if d.exists():
            import shutil
            shutil.rmtree(d, ignore_errors=True)
        logger.info("[project %s] 已删除: %s", project_id, proj.name)

    def _require(self, project_id: str) -> Project:
        proj = self._projects.get(project_id)
        if proj is None:
            raise KeyError(project_id)
        return proj

    # ── 录音管理 ──────────────────────────────────────────────

    def add_recording(self, project_id: str, filename: str,
                      language: str = "zh") -> Recording:
        """把一个录音登记进项目队列（文件本身由 FileStore 保存）"""
        proj = self._require(project_id)
        rid = uuid.uuid4().hex[:12]
        rec = Recording(
            recording_id=rid,
            project_id=project_id,
            filename=filename,
            order=len(proj.recordings),
            language=language,
            created_at=_now(),
        )
        proj.recordings.append(rec)
        proj.updated_at = _now()
        if proj.state == ProjectState.draft:
            proj.state = ProjectState.transcribing
        self.save()
        return rec

    def get_recording(self, project_id: str, recording_id: str) -> Optional[Recording]:
        proj = self._projects.get(project_id)
        if not proj:
            return None
        for r in proj.recordings:
            if r.recording_id == recording_id:
                return r
        return None

    def recording_paths(self, project_id: str, recording_id: str) -> dict:
        d = self._rec_dir(project_id)
        return {
            "result": d / f"{recording_id}.json",
            "emb": d / f"{recording_id}.emb.npy",
            "emb_meta": d / f"{recording_id}.embmeta.json",
        }

    def save_recording_result(self, project_id: str, recording_id: str,
                              result_dict: dict, embeddings=None,
                              durations=None) -> None:
        """保存单段转录结果与声纹向量"""
        paths = self.recording_paths(project_id, recording_id)
        paths["result"].write_text(
            json.dumps(result_dict, ensure_ascii=False), encoding="utf-8")

        if embeddings:
            X = np.vstack([np.asarray(e).reshape(-1) for e in embeddings])
            np.save(paths["emb"], X.astype(np.float32))
            paths["emb_meta"].write_text(
                json.dumps({"durations": durations or []}, ensure_ascii=False),
                encoding="utf-8")
            logger.debug("[rec %s] 已保存 %d 个声纹向量", recording_id, len(embeddings))

    def load_recording_result(self, project_id: str,
                              recording_id: str) -> Optional[dict]:
        p = self.recording_paths(project_id, recording_id)["result"]
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("[rec %s] 结果读取失败: %s", recording_id, e)
            return None

    # ── 队列状态 ──────────────────────────────────────────────

    def update_state(self, project_id: str) -> None:
        """依据各录音状态推导项目状态并落盘"""
        proj = self._projects.get(project_id)
        if not proj:
            return
        proj.updated_at = _now()

        if not proj.all_finished:
            proj.state = ProjectState.transcribing
        elif proj.summary_state == TaskState.processing:
            proj.state = ProjectState.summarizing
        elif all(r.state == TaskState.failed for r in proj.recordings):
            proj.state = ProjectState.failed
        elif proj.summary_state == TaskState.completed:
            proj.state = ProjectState.completed
        else:
            # 转录完成、总结尚未开始/失败
            proj.state = ProjectState.completed
        self.save()

    def next_pending(self, project_id: str) -> Optional[Recording]:
        """取下一个待处理录音（按 order 顺序，实现串行队列）"""
        proj = self._projects.get(project_id)
        if not proj:
            return None
        for r in sorted(proj.recordings, key=lambda x: x.order):
            if r.state == TaskState.pending:
                return r
        return None

    # ── 跨录音说话人统一 + 合并转录 ────────────────────────────

    def unify_speakers(self, project_id: str) -> bool:
        """
        跨录音统一说话人 ID。

        各段录音独立聚类时，同一个人的声纹会被编成不同的 SPEAKER_x。
        这里把所有录音的声纹向量汇总后**重新全局聚类**，使整个会议
        共用一套说话人编号。

        Returns:
            是否成功执行统一（False 表示数据不足，保留原样）
        """
        proj = self._projects.get(project_id)
        if not proj:
            return False

        all_embs: list[np.ndarray] = []
        owners: list[tuple[str, int]] = []   # (recording_id, 段内索引)

        for rec in sorted(proj.recordings, key=lambda x: x.order):
            if rec.state != TaskState.completed:
                continue
            paths = self.recording_paths(project_id, rec.recording_id)
            if not paths["emb"].exists():
                continue
            try:
                X = np.load(paths["emb"])
                meta = json.loads(paths["emb_meta"].read_text(encoding="utf-8"))
                durs = meta.get("durations", [])
            except Exception as e:
                logger.warning("[rec %s] 声纹读取失败，跳过: %s", rec.recording_id, e)
                continue

            for i in range(X.shape[0]):
                d = durs[i] if i < len(durs) else 999.0
                # 过短片段的声纹不可靠，不参与全局聚类（但仍会回填标签）
                if d < MIN_CLUSTER_DURATION_S:
                    continue
                all_embs.append(X[i])
                owners.append((rec.recording_id, i))
        if len(all_embs) < 2:
            logger.info("[project %s] 有效声纹不足，跳过统一聚类", project_id)
            return False

        # 全局聚类：复用 pipeline 已修好的非负亲和 + eigengap 实现
        from backend.pipeline import ASRPipeline

        fake_segments = [{"emb_idx": i, "duration_s": 999.0}
                         for i in range(len(all_embs))]
        labels = ASRPipeline._cluster_speakers_static(
            all_embs, len(all_embs), fake_segments)

        # 建立 (recording_id, emb_idx) -> 全局标签 的映射
        mapping: dict[tuple[str, int], str] = {}
        for (rid, idx), lab in zip(owners, labels):
            mapping[(rid, idx)] = lab

        # 按全局标签回填每段录音的 segments，并重写结果文件。
        #
        # 关键：emb_idx 必须与 pipeline 保存声纹时的编号口径一致 ——
        # pipeline 只对 duration >= MIN_SPK_DURATION_S 的片段抽取声纹,
        # 因此这里必须**跳过过短片段**再计数，否则一个短片段就会让
        # 之后所有段落的编号错位，把说话人标签贴到错误的段落上。
        from backend.pipeline import MIN_SPK_DURATION_S

        unified_count = 0
        for rec in proj.recordings:
            if rec.state != TaskState.completed:
                continue
            result = self.load_recording_result(project_id, rec.recording_id)
            if not result:
                continue

            emb_i = 0
            changed = False
            for seg in result.get("segments", []):
                dur = float(seg.get("end", 0.0)) - float(seg.get("start", 0.0))
                if dur < MIN_SPK_DURATION_S - 1e-9:
                    # 该片段没有声纹，保持 pipeline 内继承的前一段标签
                    continue
                key = (rec.recording_id, emb_i)
                if key in mapping and seg.get("speaker") != mapping[key]:
                    seg["speaker"] = mapping[key]
                    changed = True
                emb_i += 1

            # 更新该录音的说话人数（无论是否改写都要重算）
            result["num_speakers"] = len({s.get("speaker") for s in result.get("segments", [])})
            self.recording_paths(project_id, rec.recording_id)["result"].write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8")
            if changed:
                unified_count += 1

        logger.info("[project %s] 跨录音说话人统一完成: %d 个全局说话人, 更新 %d 段录音",
                    project_id, len(set(mapping.values())), unified_count)
        return True

    def build_transcript(self, project_id: str) -> dict:
        """
        合并项目内所有录音为一份会议转录文档。

        时间轴策略：按 order 顺序首尾相接，每段之间保留真实间隔，
        同时记录该段在整个会议中的**全局起始偏移**（offset），
        便于前端定位与「第 N 段录音」标注。
        """
        proj = self._require(project_id)
        merged_segments: list[dict] = []
        recordings_meta: list[dict] = []
        offset = 0.0
        speaker_set: set[str] = set()

        for rec in sorted(proj.recordings, key=lambda x: x.order):
            if rec.state != TaskState.completed:
                continue
            result = self.load_recording_result(project_id, rec.recording_id)
            if not result:
                continue

            segs = result.get("segments", [])
            rec_dur = result.get("duration") or (segs[-1]["end"] if segs else 0.0)

            for seg in segs:
                merged_segments.append({
                    **seg,
                    "id": f"{rec.recording_id[:6]}-{seg.get('id', '')}",
                    # 全局时间 = 该段录音的偏移 + 段内时间
                    "start": round(offset + seg.get("start", 0.0), 3),
                    "end": round(offset + seg.get("end", 0.0), 3),
                    # 保留段内本地时间，便于回放定位到具体音频文件
                    "local_start": seg.get("start", 0.0),
                    "local_end": seg.get("end", 0.0),
                    "recording_id": rec.recording_id,
                    "recording_index": rec.order,
                })
                if seg.get("speaker"):
                    speaker_set.add(seg["speaker"])

            recordings_meta.append({
                "recording_id": rec.recording_id,
                "filename": rec.filename,
                "order": rec.order,
                "duration": round(rec_dur, 3),
                "offset": round(offset, 3),
                "segment_count": len(segs),
                "num_speakers": result.get("num_speakers", 0),
                "language": rec.language,
            })
            offset += rec_dur + DEFAULT_GAP_S

        total_duration = merged_segments[-1]["end"] if merged_segments else 0.0

        return {
            "project_id": proj.project_id,
            "name": proj.name,
            "duration": round(total_duration, 3),
            "num_speakers": len(speaker_set),
            "segments": merged_segments,
            "recordings": recordings_meta,
            # 合并文档没有单一波形，前端按录音分段加载
            "peaks": [],
            "merged": True,
        }

    def save_transcript(self, project_id: str, transcript: dict) -> Path:
        p = self._project_dir(project_id) / "transcript.json"
        p.write_text(json.dumps(transcript, ensure_ascii=False), encoding="utf-8")
        return p

    # ── 参考材料 ──────────────────────────────────────────────

    def reference_path(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "reference.md"

    def save_reference(self, project_id: str, filename: str, text: str) -> None:
        """保存会议参考材料（议程、参会名单等），供总结使用"""
        proj = self._require(project_id)
        self.reference_path(project_id).write_text(text, encoding="utf-8")
        proj.reference_name = filename
        proj.has_reference = bool(text.strip())
        proj.updated_at = _now()
        self.save()

    def get_reference(self, project_id: str) -> Optional[str]:
        p = self.reference_path(project_id)
        if not p.exists():
            return None
        try:
            return p.read_text(encoding="utf-8")
        except Exception:
            return None

    # ── 会议总结 ──────────────────────────────────────────────

    def summary_path(self, project_id: str) -> Path:
        return self._project_dir(project_id) / "summary.md"

    def get_summary(self, project_id: str) -> Optional[str]:
        p = self.summary_path(project_id)
        if not p.exists():
            return None
        try:
            return p.read_text(encoding="utf-8")
        except Exception:
            return None


# ── 全局单例 ──────────────────────────────────────────────────

_store: Optional[ProjectStore] = None


def get_project_store() -> ProjectStore:
    global _store
    if _store is None:
        _store = ProjectStore()
    return _store
