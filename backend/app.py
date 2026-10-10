"""
CcAsr FastAPI 服务

架构：**会议项目制**
    项目（文档，如「xx 会议」）
      └── 多段录音（按 order 串行转录）
            └── 全部完成后：跨录音统一说话人 → 合并转录 → 自动生成会议纪要

旧的「单文件任务」流程已移除（见 CHANGELOG）。
"""

# ── 性能优化: 必须在 import torch 之前设置 ──
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi import (
    FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Form,
)
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.backends import get_backend
from backend.schema import TaskState, ProjectState
from backend.file_store import get_file_store
from backend.project_store import get_project_store
from backend.config import env, get_output_dir

# ── Debug 模式 ───────────────────────────────────────────────
DEBUG = (env("DEBUG", "0") or "0").lower() in ("1", "true", "yes")

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("ccasr.app")
if DEBUG:
    logger.setLevel(logging.DEBUG)
    logger.debug("Debug mode enabled (CCASR_DEBUG=1)")

# ── 常量 ──────────────────────────────────────────────────────
MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 单文件 500MB

# 测试用：把 LLM 换成假客户端，仅当 CCASR_LLM_FAKE=1 时生效
# （用于在没有真实 API key 的情况下验证纪要全链路，绝不影响正常部署）
LLM_FAKE = False
try:
    from backend.fake_llm import enable_if_requested as _enable_fake_llm
    LLM_FAKE = _enable_fake_llm()
except Exception as _e:  # 假客户端不可用不应影响服务启动
    logger.warning("加载假 LLM 客户端失败（忽略）: %s", _e)
if LLM_FAKE:
    logger.warning("⚠ 已启用假 LLM 客户端（CCASR_LLM_FAKE=1）—— 仅用于测试！")

app = FastAPI(
    title="CcAsr",
    description="离线语音转文字 + 声纹识别 + 会议纪要",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api")
async def root():
    return {
        "service": "CcAsr",
        "version": "0.3.0",
        "debug": DEBUG,
        "model": "会议项目制（多段录音串行转录 + 自动纪要）",
        "endpoints": {
            "POST   /api/projects": "创建会议项目",
            "GET    /api/projects": "列出会议项目",
            "GET    /api/projects/{id}": "项目详情（含录音队列状态）",
            "PATCH  /api/projects/{id}": "重命名项目",
            "DELETE /api/projects/{id}": "删除项目",
            "POST   /api/projects/{id}/recordings": "一次上传多个录音（入队）",
            "POST   /api/projects/{id}/start": "启动/继续转录队列",
            "GET    /api/projects/{id}/transcript": "合并转录文档",
            "GET    /api/projects/{id}/summary": "会议纪要（自动生成）",
            "POST   /api/projects/{id}/reference": "上传参考材料",
            "GET    /api/projects/{id}/recordings/{rid}/audio": "单段录音音频",
            "GET    /health": "健康检查",
        },
    }


@app.get("/health")
async def health():
    import torch
    from backend.backends import describe_routing
    pipeline = get_backend()
    rss_mb = 0
    try:
        import resource
        ru = resource.getrusage(resource.RUSAGE_SELF)
        rss_mb = ru.ru_maxrss / 1024 / 1024  # macOS: bytes
        if sys.platform.startswith("linux"):
            rss_mb = ru.ru_maxrss / 1024      # Linux: KB
    except ImportError:
        try:
            import psutil
            rss_mb = psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
        except ImportError:
            pass

    mps_alloc = 0
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        mps_alloc = torch.mps.current_allocated_memory() / 1024 / 1024

    pipeline_cls = type(pipeline)
    has_eigengap = hasattr(pipeline_cls, "_estimate_speaker_count")
    return {
        "status": "ok",
        "model_loaded": pipeline.is_loaded,
        "device": pipeline.device,
        "debug": DEBUG,
        "code": {
            "pid": os.getpid(),
            "diarization": "nonnegative+eigengap" if has_eigengap
                           else "legacy(affinity=cosine)",
        },
        "asr_routing": describe_routing(),
        "llm_fake": LLM_FAKE,
        "memory": {"rss_mb": round(rss_mb), "mps_allocated_mb": round(mps_alloc)},
    }


# ══════════════════════════════════════════════════════════════
# 会议项目 API
# ══════════════════════════════════════════════════════════════

def _run_project_queue(project_id: str) -> None:
    """
    后台任务：**串行**处理项目队列中的所有录音。

    用单个后台任务 + while 循环，而不是每段录音各提交一个后台任务 ——
    后者会让多段录音并发抢 CPU/GPU。这里严格按 order 顺序逐段转录。

    全部录音结束后：
      1) 跨录音统一说话人（消除分段录音导致的身份不一致）
      2) 生成合并转录文档
      3) 自动生成会议纪要
    """
    store = get_project_store()
    proj = store.get(project_id)
    if proj is None:
        logger.warning("[project %s] 队列启动时项目已不存在", project_id)
        return

    logger.info("[project %s] 开始串行转录队列（共 %d 段）",
                project_id, len(proj.recordings))

    while True:
        rec = store.next_pending(project_id)
        if rec is None:
            break

        rec.state = TaskState.processing
        rec.progress = 0.05
        store.update_state(project_id)

        audio_path = get_file_store().get_file_path(rec.recording_id)
        if audio_path is None:
            rec.state = TaskState.failed
            rec.error = "音频文件未找到（可能已被清理）"
            store.update_state(project_id)
            logger.error("[rec %s] 音频缺失，跳过", rec.recording_id)
            continue

        try:
            logger.info("[project %s] 转写第 %d 段: %s",
                        project_id, rec.order + 1, rec.filename)
            pipeline = get_backend(language=rec.language)
            result = pipeline.transcribe(
                audio_path=str(audio_path),
                language=rec.language,
                return_embeddings=True,
            )

            store.save_recording_result(
                project_id, rec.recording_id, result.to_dict(),
                embeddings=getattr(pipeline, "last_embeddings", None),
                durations=getattr(pipeline, "last_segment_durations", None),
            )
            rec.duration = result.duration
            rec.state = TaskState.completed
            rec.progress = 1.0
            rec.completed_at = datetime.now(timezone.utc).isoformat()
            rec.has_embeddings = bool(getattr(pipeline, "last_embeddings", None))
            logger.info("[project %s] 第 %d 段完成: %d 段文本, %d 说话人",
                        project_id, rec.order + 1, len(result.segments),
                        result.num_speakers)

        except Exception as e:
            logger.exception("[rec %s] 转写失败", rec.recording_id)
            rec.state = TaskState.failed
            rec.error = str(e)
            rec.progress = 1.0

        store.update_state(project_id)

    # ── 队列结束：统一说话人 → 合并文档 → 自动纪要 ──
    try:
        store.unify_speakers(project_id)
    except Exception:
        logger.exception("[project %s] 跨录音说话人统一失败（不影响后续）", project_id)

    try:
        transcript = store.build_transcript(project_id)
        store.save_transcript(project_id, transcript)
        logger.info("[project %s] 合并文档已生成: %d 段, %d 说话人, %.1fs",
                    project_id, len(transcript["segments"]),
                    transcript["num_speakers"], transcript["duration"])
    except Exception:
        logger.exception("[project %s] 合并文档生成失败", project_id)
        store.update_state(project_id)
        return

    try:
        _run_project_summary(project_id)
    except Exception as e:
        logger.exception("[project %s] 自动会议纪要失败", project_id)
        p = store.get(project_id)
        if p:
            p.summary_state = TaskState.failed
            p.summary_error = str(e)
    finally:
        store.update_state(project_id)


def _run_project_summary(project_id: str) -> None:
    """生成会议纪要（在队列后台线程内串行执行）。"""
    store = get_project_store()
    proj = store.get(project_id)
    if proj is None:
        return

    if not any(r.state == TaskState.completed for r in proj.recordings):
        logger.warning("[project %s] 无成功转录的录音，跳过会议纪要", project_id)
        proj.summary_state = TaskState.failed
        proj.summary_error = "没有成功转录的录音"
        return

    from backend.meeting_summary import generate_meeting_summary

    # 测试用假客户端：在这里再确认一次。uvicorn 热重载会重新导入
    # meeting_summary，把模块级工厂重置回 OpenAI，仅靠启动时注入会失效。
    try:
        from backend.fake_llm import enable_if_requested as _fake
        _fake()
    except Exception:
        pass

    proj.summary_state = TaskState.processing
    proj.summary_progress = 0.05
    proj.summary_error = None
    store.update_state(project_id)

    def progress_cb(p: float, msg: str) -> None:
        proj.summary_progress = max(0.0, min(1.0, p))
        logger.debug("[project %s] 纪要 %s (%.0f%%)", project_id, msg, p * 100)

    transcript = store.build_transcript(project_id)
    summary_md = generate_meeting_summary(
        project=proj,
        transcript=transcript,
        reference_content=store.get_reference(project_id),
        progress_callback=progress_cb,
    )

    store.summary_path(project_id).write_text(summary_md, encoding="utf-8")
    proj.summary_state = TaskState.completed
    proj.summary_progress = 1.0
    proj.summary_completed_at = datetime.now(timezone.utc).isoformat()
    logger.info("[project %s] 会议纪要完成: %d 字符", project_id, len(summary_md))


def _require_project(store, project_id: str):
    proj = store.get(project_id)
    if proj is None:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return proj


@app.post("/api/projects")
async def create_project(payload: dict):
    """创建会议项目（文档），如「xx 会议」"""
    try:
        proj = get_project_store().create_project((payload or {}).get("name", ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(status_code=201, content=proj.to_dict())


@app.get("/api/projects")
async def list_projects():
    """列出所有会议项目"""
    store = get_project_store()
    return JSONResponse(content=[p.to_dict(include_recordings=False)
                                 for p in store.list_projects()])


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    """查询项目详情（含录音队列状态）"""
    store = get_project_store()
    return JSONResponse(content=_require_project(store, project_id).to_dict())


@app.patch("/api/projects/{project_id}")
async def rename_project(project_id: str, payload: dict):
    """重命名项目"""
    try:
        proj = get_project_store().rename(project_id, (payload or {}).get("name", ""))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content=proj.to_dict())


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    """删除项目及其全部产物"""
    try:
        get_project_store().delete(project_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    return JSONResponse(content={"deleted": project_id})


@app.post("/api/projects/{project_id}/recordings")
async def add_recordings(
    project_id: str,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(description="一个或多个音频文件"),
    language: str = Form(default="zh", description="语种，作用于本批全部录音"),
    start: bool = Form(default=True, description="是否立即启动串行队列"),
):
    """
    一次上传多个录音到项目队列。

    多个文件按上传顺序排队，后台**串行**转录，全部完成后自动生成会议纪要。
    队列运行中再次上传会返回 409，避免并发争抢。
    """
    store = get_project_store()
    proj = _require_project(store, project_id)
    if not files:
        raise HTTPException(status_code=400, detail="未收到任何音频文件")
    if proj.state in (ProjectState.transcribing, ProjectState.summarizing):
        raise HTTPException(status_code=409,
                            detail="该项目队列正在运行，请等待完成后再添加")

    created = []
    for f in files:
        content = await f.read()
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"{f.filename} 过大，单文件最大 {MAX_UPLOAD_SIZE // 1024 // 1024}MB")
        filename = f.filename or "unknown.wav"
        rec = store.add_recording(project_id, filename, language)
        # 音频用 recording_id 作为 FileStore 的 task_id，便于按录音取回音频
        get_file_store().save_file(content, filename, rec.recording_id)
        created.append(rec)
        logger.info("[project %s] 入队: %s (%.1f MB)",
                    project_id, filename, len(content) / 1024 / 1024)

    store.update_state(project_id)

    if start and any(r.state == TaskState.pending for r in proj.recordings):
        background_tasks.add_task(_run_project_queue, project_id)
        logger.info("[project %s] 串行队列已提交（%d 段）", project_id, len(created))

    return JSONResponse(
        status_code=202,
        content={"project": proj.to_dict(include_recordings=False),
                 "added": [r.to_dict() for r in created]},
    )


@app.post("/api/projects/{project_id}/start")
async def start_project_queue(project_id: str, background_tasks: BackgroundTasks):
    """启动/继续该项目队列（用于失败重试或分批上传后统一启动）"""
    store = get_project_store()
    proj = _require_project(store, project_id)
    if not any(r.state == TaskState.pending for r in proj.recordings):
        raise HTTPException(status_code=400, detail="没有待处理的录音")
    background_tasks.add_task(_run_project_queue, project_id)
    return JSONResponse(status_code=202,
                        content=proj.to_dict(include_recordings=False))


@app.get("/api/projects/{project_id}/recordings/{recording_id}/audio")
async def get_recording_audio(project_id: str, recording_id: str):
    """获取某段录音的音频（用于回放定位到具体片段）"""
    store = get_project_store()
    _require_project(store, project_id)
    path = get_file_store().get_file_path(recording_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Audio file not found")
    name = get_file_store().get_original_name(recording_id) or "audio"
    suffix = path.suffix.lower()
    media = {".mp3": "audio/mpeg", ".m4a": "audio/mp4",
             ".flac": "audio/flac"}.get(suffix, "audio/wav")
    return FileResponse(path=str(path), media_type=media, filename=name)


@app.get("/api/projects/{project_id}/recordings/{recording_id}/transcript")
async def get_recording_transcript(project_id: str, recording_id: str):
    """获取单段录音的原始转录（本地时间轴，用于单文件回放）"""
    store = get_project_store()
    _require_project(store, project_id)
    result = store.load_recording_result(project_id, recording_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Recording result not found")
    return JSONResponse(content=result)


@app.get("/api/projects/{project_id}/transcript")
async def get_project_transcript(project_id: str):
    """获取合并后的会议转录文档（跨录音统一时间轴）"""
    store = get_project_store()
    _require_project(store, project_id)

    p = store._project_dir(project_id) / "transcript.json"
    if not p.exists():
        transcript = store.build_transcript(project_id)
        if not transcript["segments"]:
            raise HTTPException(status_code=400, detail="尚无已完成的录音")
        store.save_transcript(project_id, transcript)
        return JSONResponse(content=transcript)

    with open(p, "r", encoding="utf-8") as f:
        return JSONResponse(content=json.load(f))


@app.patch("/api/projects/{project_id}/transcript")
async def update_project_transcript(project_id: str, payload: dict):
    """
    保存对合并文档的编辑（校对文本、说话人改名）。

    接受 ``{"segments":[{"id":..., "text":..., "speaker":...}], "speaker_map":{...}}``，
    只更新传入的字段，未提及的段落保持原样。
    """
    store = get_project_store()
    proj = _require_project(store, project_id)

    p = store._project_dir(project_id) / "transcript.json"
    if not p.exists():
        raise HTTPException(status_code=400, detail="合并文档尚未生成")

    with open(p, "r", encoding="utf-8") as f:
        transcript = json.load(f)

    edits = {s.get("id"): s for s in (payload or {}).get("segments", [])
             if isinstance(s, dict) and s.get("id")}

    updated = 0
    for seg in transcript.get("segments", []):
        e = edits.get(seg.get("id"))
        if not e:
            continue
        for field in ("text", "speaker"):
            if field in e and e[field] != seg.get(field):
                seg[field] = e[field]
                updated += 1

    speaker_map = (payload or {}).get("speaker_map")
    if isinstance(speaker_map, dict):
        transcript["speaker_map"] = speaker_map

    store.save_transcript(project_id, transcript)
    logger.info("[project %s] 合并文档已更新 %d 处", project_id, updated)
    return JSONResponse(content={"updated": updated, "transcript": transcript})


@app.get("/api/projects/{project_id}/summary")
async def get_project_summary(project_id: str):
    """获取会议纪要（Markdown + 状态）"""
    store = get_project_store()
    proj = _require_project(store, project_id)
    content = store.get_summary(project_id)
    return JSONResponse(content={
        "project_id": project_id,
        "state": proj.summary_state.value,
        "progress": proj.summary_progress,
        "error": proj.summary_error,
        "summary": content,
        "has_summary": content is not None,
    })


@app.post("/api/projects/{project_id}/summary/regenerate")
async def regenerate_project_summary(project_id: str, background_tasks: BackgroundTasks):
    """重新生成会议纪要（改了参考材料或对转录校对后使用）"""
    store = get_project_store()
    proj = _require_project(store, project_id)
    if not any(r.state == TaskState.completed for r in proj.recordings):
        raise HTTPException(status_code=400, detail="没有已完成的录音")
    if proj.summary_state == TaskState.processing:
        raise HTTPException(status_code=409, detail="纪要正在生成中")

    def _job() -> None:
        try:
            _run_project_summary(project_id)
        except Exception as e:
            logger.exception("[project %s] 重新生成纪要失败", project_id)
            p = store.get(project_id)
            if p:
                p.summary_state = TaskState.failed
                p.summary_error = str(e)
        finally:
            store.update_state(project_id)

    background_tasks.add_task(_job)
    return JSONResponse(status_code=202,
                        content={"project_id": project_id, "state": "processing"})


@app.post("/api/projects/{project_id}/reference")
async def upload_project_reference(project_id: str, reference: UploadFile = File(...)):
    """上传参考材料（议程、参会名单等），供会议纪要使用"""
    store = get_project_store()
    _require_project(store, project_id)

    raw = await reference.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    store.save_reference(project_id, reference.filename or "reference.md", text)
    return JSONResponse(content={"saved": True, "chars": len(text),
                                 "name": reference.filename})


@app.get("/api/projects/{project_id}/export")
async def export_project(project_id: str, fmt: str = "md"):
    """
    导出会议成果。

    fmt=md  → 会议纪要 Markdown
    fmt=txt → 纯文本转录（[时间] 说话人: 内容）
    fmt=json→ 合并转录 JSON
    """
    store = get_project_store()
    proj = _require_project(store, project_id)
    # 去掉文件系统非法字符（含全角冒号，中文会议名里很常见）
    bad = r'\/:*?"<>|：＊？＂＜＞｜'
    safe_name = "".join(c for c in proj.name if c not in bad).strip() or "meeting"

    if fmt == "md":
        content = store.get_summary(project_id)
        if content is None:
            raise HTTPException(status_code=404, detail="会议纪要尚未生成")
        return JSONResponse(content={"filename": f"{safe_name}_纪要.md",
                                     "content": content})
    if fmt == "json":
        transcript = store.build_transcript(project_id)
        return JSONResponse(content={"filename": f"{safe_name}_转录.json",
                                     "content": json.dumps(transcript,
                                                           ensure_ascii=False, indent=2)})
    if fmt == "txt":
        transcript = store.build_transcript(project_id)
        lines = []
        for seg in transcript.get("segments", []):
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            s = seg.get("start", 0)
            h, m, sec = int(s // 3600), int((s % 3600) // 60), int(s % 60)
            lines.append(f"[{h:02d}:{m:02d}:{sec:02d}] {seg.get('speaker', '')}: {text}")
        return JSONResponse(content={"filename": f"{safe_name}_转录.txt",
                                     "content": "\n".join(lines)})

    raise HTTPException(status_code=400, detail=f"不支持的导出格式: {fmt}")


# ── 静态文件服务 (前端 SPA) ──────────────────────────────────
_dist_dir = Path(__file__).parent.parent / "app" / "dist"
if _dist_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist_dir), html=True), name="static")
    logger.info("Serving static files from: %s", _dist_dir)
else:
    logger.warning("Static files directory not found: %s (frontend not built yet)", _dist_dir)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
