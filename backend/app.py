"""CcAsr FastAPI 服务"""

# ── 性能优化: 必须在 import torch 之前设置 ──
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import json
import sys
import uuid
import tempfile
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, BackgroundTasks, Form
from fastapi.responses import JSONResponse, PlainTextResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.backends import get_backend
from backend.schema import TranscriptionResult, TaskStatus, TaskState, SummarizeJob
from backend.file_store import get_file_store
from backend.config import env, get_output_dir
from backend.summarize import run_summarize, get_summary_filename, get_preset_list, PRESETS

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
MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500MB
MAX_TASKS_IN_MEMORY = 100            # 保留最近 N 条任务

app = FastAPI(
    title="CcAsr",
    description="离线语音转文字 + 声纹识别服务",
    version="0.2.0",
)


@app.on_event("startup")
async def startup_event():
    """启动时加载持久化的任务数据"""
    _load_tasks()
    logger.info("Startup: loaded %d tasks", len(task_store))
    _load_summarize_jobs()

# ── CORS 中间件 ──────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 输出目录（含旧版数据自动迁移）
OUTPUT_DIR = get_output_dir()

# ── 任务管理 (内存 dict + 持久化 + 自动清理) ──────────────────
TASKS_FILE = OUTPUT_DIR / "tasks.json"
task_store: Dict[str, TaskStatus] = {}


def _save_tasks():
    """持久化任务元数据到 tasks.json"""
    data = []
    for task in task_store.values():
        d = {
            "task_id": task.task_id,
            "state": task.state.value,
            "filename": task.filename,
            "progress": task.progress,
            "created_at": task.created_at,
            "completed_at": task.completed_at,
            "error": task.error,
        }
        data.append(d)
    data.sort(key=lambda t: t.get("created_at", ""), reverse=True)
    tmp = TASKS_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(str(tmp), str(TASKS_FILE))


def _load_tasks():
    """从 tasks.json 加载任务元数据（不含 result，结果从磁盘 JSON 按需加载）"""
    if not TASKS_FILE.exists():
        return
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        for d in data:
            task = TaskStatus(
                task_id=d["task_id"],
                state=TaskState(d["state"]),
                filename=d["filename"],
                progress=d.get("progress", 1.0),
                created_at=d.get("created_at"),
                completed_at=d.get("completed_at"),
                error=d.get("error"),
            )
            # 尝试从磁盘加载结果
            if task.state == TaskState.completed:
                result_file = OUTPUT_DIR / f"{task.task_id}.json"
                if result_file.exists():
                    task.result = {"_loaded": True}  # 标记有结果，按需加载
            task_store[task.task_id] = task
        logger.info("Loaded %d tasks from %s", len(task_store), TASKS_FILE)
    except Exception as e:
        logger.warning("Failed to load tasks: %s", e)


def _cleanup_old_tasks():
    """保留最近 MAX_TASKS_IN_MEMORY 条任务，清理旧的"""
    if len(task_store) <= MAX_TASKS_IN_MEMORY:
        return
    # 按 created_at 排序，删除最旧的
    sorted_ids = sorted(
        task_store.keys(),
        key=lambda tid: task_store[tid].created_at or "",
    )
    to_remove = sorted_ids[: len(sorted_ids) - MAX_TASKS_IN_MEMORY]
    for tid in to_remove:
        task = task_store.pop(tid, None)
        if task:
            logger.info("[task %s] Cleaned up (old task)", tid)
            # 清理结果 JSON
            result_file = OUTPUT_DIR / f"{tid}.json"
            if result_file.exists():
                result_file.unlink(missing_ok=True)
    _save_tasks()


def _process_task(task_id: str, file_path: str, filename: str, language: str) -> None:
    """后台任务: 执行转写并更新 task_store"""
    task = task_store.get(task_id)
    if task is None:
        logger.warning("[task %s] Not found in task_store, skipping", task_id)
        return

    task.state = TaskState.processing
    task.progress = 0.1
    logger.info("[task %s] Processing started: %s (lang=%s)", task_id, filename, language)
    if DEBUG:
        logger.debug("[task %s] file_path=%s, file_size=%s", task_id, file_path,
                     os.path.getsize(file_path) if os.path.exists(file_path) else "N/A")

    try:
        pipeline = get_backend()
        if DEBUG:
            logger.debug("[task %s] Pipeline loaded, device=%s", task_id, pipeline.device)

        result = pipeline.transcribe(audio_path=file_path, language=language)
        if DEBUG:
            logger.debug("[task %s] Transcription done: %d segments, %.1fs duration",
                         task_id, len(result.segments), result.duration)

        # 保存结果到文件
        output_file = OUTPUT_DIR / f"{task_id}.json"
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(result.to_json())

        now = datetime.now(timezone.utc).isoformat()
        task.state = TaskState.completed
        task.progress = 1.0
        task.completed_at = now
        # 不在内存中保留 result — get_task_result 已支持从磁盘 JSON 按需加载
        task.result = {"_loaded": True}
        _save_tasks()
        logger.info("[task %s] Completed: %s (%d segments)", task_id, filename, len(result.segments))

    except Exception as e:
        logger.exception("[task %s] Failed: %s", task_id, e)
        task.state = TaskState.failed
        task.error = str(e)
        _save_tasks()

    finally:
        # pipeline.transcribe() 内部已清理转码临时文件
        # 音频文件由 FileStore 管理，不在这里删除
        _cleanup_old_tasks()


# ── 端点 ──────────────────────────────────────────────────────

@app.get("/api")
async def root():
    return {
        "service": "CcAsr",
        "version": "0.2.0",
        "debug": DEBUG,
        "endpoints": {
            "POST /transcribe": "上传音频文件进行转写 (同步)",
            "POST /api/tasks": "创建异步转写任务",
            "GET /api/tasks": "列出所有任务",
            "GET /api/tasks/{task_id}": "查询任务状态",
            "GET /api/tasks/{task_id}/result": "获取转写结果",
            "GET /api/tasks/{task_id}/audio": "获取音频文件",
            "GET /api/summarize/presets": "列出 AI 总结预设",
            "POST /api/tasks/{task_id}/summarize": "创建 AI 总结任务",
            "GET /api/tasks/{task_id}/summarize": "查询总结状态",
            "GET /api/tasks/{task_id}/summarize/result": "获取总结结果",
            "GET /api/tasks/{task_id}/summarize/preview": "预览总结结果（HTML页面）",
            "GET /api/files": "列出所有文件记录",
            "GET /health": "健康检查",
        },
    }


@app.get("/health")
async def health():
    import torch
    pipeline = get_backend()
    # resource 模块仅 Unix 可用; Windows 下用 psutil 或跳过
    rss_mb = 0
    try:
        import resource
        ru = resource.getrusage(resource.RUSAGE_SELF)
        rss_mb = ru.ru_maxrss / 1024 / 1024  # macOS: bytes
        if sys.platform.startswith("linux"):
            rss_mb = ru.ru_maxrss / 1024  # Linux: KB
    except ImportError:
        try:
            import psutil
            rss_mb = psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024
        except ImportError:
            pass
    mps_alloc = 0
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        mps_alloc = torch.mps.current_allocated_memory() / 1024 / 1024
    # 诊断字段: 用于确认运行中的进程确实加载了当前代码（热重载后排查用）
    pipeline_cls = type(pipeline)
    has_eigengap = hasattr(pipeline_cls, "_estimate_speaker_count")
    return {
        "status": "ok",
        "model_loaded": pipeline.is_loaded,
        "device": pipeline.device,
        "debug": DEBUG,
        "code": {
            "pid": os.getpid(),
            "diarization": "nonnegative+eigengap" if has_eigengap else "legacy(affinity=cosine)",
        },
        "memory": {
            "rss_mb": round(rss_mb),
            "mps_allocated_mb": round(mps_alloc),
        },
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(description="音频文件 (wav/mp3/m4a/flac)"),
    language: str = Query(default="zh", description="语种: zh/auto/en/yue/ja/ko (默认中文)"),
    output_format: str = Query(default="json", description="输出格式: json/text"),
):
    """
    上传音频文件, 返回转写结果 (同步)
    """
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail=f"文件过大，最大支持 {MAX_UPLOAD_SIZE // 1024 // 1024}MB")

    filename = file.filename or "unknown.wav"
    # 保存到 FileStore（MD5 去重）
    file_path = get_file_store().save_file(content, filename, "sync_" + uuid.uuid4().hex[:8])

    try:
        pipeline = get_backend()
        result = pipeline.transcribe(audio_path=str(file_path), language=language)

        output_file = OUTPUT_DIR / f"{Path(filename).stem}.json"
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(result.to_json())

        if output_format == "text":
            return PlainTextResponse(result.to_plain_text())

        return JSONResponse(content=result.to_dict())

    except Exception as e:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── 异步任务 API ────────────────────────────────────────────

@app.post("/api/tasks")
async def create_task(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(description="音频文件 (wav/mp3/m4a/flac)"),
    language: str = Query(default="zh", description="语种: zh/auto/en/yue/ja/ko (默认中文)"),
):
    """
    创建异步转写任务: 上传文件 → 返回 task_id → 后台处理 → 前端轮询
    """
    content = await file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail=f"文件过大，最大支持 {MAX_UPLOAD_SIZE // 1024 // 1024}MB")

    task_id = uuid.uuid4().hex[:12]
    filename = file.filename or "unknown.wav"

    # 保存文件（MD5 去重，永久保存）
    file_path = get_file_store().save_file(content, filename, task_id)

    # 创建任务记录
    now = datetime.now(timezone.utc).isoformat()
    task = TaskStatus(
        task_id=task_id,
        state=TaskState.pending,
        filename=filename,
        progress=0.0,
        created_at=now,
    )
    task_store[task_id] = task
    _save_tasks()

    # 提交后台任务
    background_tasks.add_task(_process_task, task_id, str(file_path), filename, language)
    logger.info("[task %s] Created for file: %s (size=%d bytes, path=%s)",
                task_id, filename, len(content), file_path)

    return JSONResponse(status_code=202, content=task.to_dict())


@app.get("/api/tasks")
async def list_tasks():
    """列出所有任务"""
    _cleanup_old_tasks()
    tasks = [task.to_dict() for task in task_store.values()]
    tasks.sort(key=lambda t: t.get("created_at", ""), reverse=True)
    return JSONResponse(content=tasks)


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str):
    """查询单个任务状态"""
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")
    if DEBUG:
        logger.debug("[task %s] Status query: state=%s, progress=%.2f", task_id, task.state.value, task.progress)
    return JSONResponse(content=task.to_dict())


@app.get("/api/tasks/{task_id}/result")
async def get_task_result(task_id: str):
    """获取任务转写结果"""
    task = task_store.get(task_id)
    if task is None or task.state != TaskState.completed:
        # 直接从磁盘加载
        output_file = OUTPUT_DIR / f"{task_id}.json"
        if output_file.exists():
            with open(output_file, "r", encoding="utf-8") as f:
                return JSONResponse(content=json.load(f))
        if task is None:
            raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")
        raise HTTPException(status_code=400, detail=f"Task not completed (state={task.state.value})")

    # 优先从磁盘加载（result 可能是持久化标记或 None）
    output_file = OUTPUT_DIR / f"{task_id}.json"
    if output_file.exists():
        with open(output_file, "r", encoding="utf-8") as f:
            return JSONResponse(content=json.load(f))

    # 回退到内存中的 result
    if task.result and "_loaded" not in task.result:
        return JSONResponse(content=task.result)

    raise HTTPException(status_code=404, detail="Result file not found")


@app.get("/api/tasks/{task_id}/audio")
async def get_task_audio(task_id: str):
    """获取任务对应的音频文件（用于波形播放）"""
    file_path = get_file_store().get_file_path(task_id)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Audio file not found")

    original_name = get_file_store().get_original_name(task_id) or "audio"
    suffix = file_path.suffix.lower()
    media_type = "audio/wav"
    if suffix == ".mp3":
        media_type = "audio/mpeg"
    elif suffix == ".m4a":
        media_type = "audio/mp4"
    elif suffix == ".flac":
        media_type = "audio/flac"

    if DEBUG:
        logger.debug("[task %s] Serving audio: %s", task_id, file_path)
    return FileResponse(path=str(file_path), media_type=media_type, filename=original_name)


@app.get("/api/files")
async def list_files():
    """列出所有文件记录"""
    files = get_file_store().list_files()
    return JSONResponse(content=files)


# ── AI 总结 API ──────────────────────────────────────────────

# 总结任务存储 (task_id → SummarizeJob)，内存中只保留最新一个
summarize_store: Dict[str, SummarizeJob] = {}


def _save_summarize_meta(job: SummarizeJob):
    """持久化总结任务元数据到磁盘。"""
    meta_file = OUTPUT_DIR / f"{job.task_id}_summary_meta.json"
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(job.to_dict(), f, ensure_ascii=False)


def _load_summarize_jobs():
    """启动时从磁盘加载已完成的总结任务。"""
    for meta_file in OUTPUT_DIR.glob("*_summary_meta.json"):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            task_id = data.get("task_id", "")
            if not task_id:
                continue
            job = SummarizeJob(
                job_id=data.get("job_id", ""),
                task_id=task_id,
                preset=data.get("preset", "podcast_polish"),
                state=TaskState(data.get("state", "completed")),
                progress=data.get("progress", 1.0),
                has_reference=data.get("has_reference", False),
                include_intro=data.get("include_intro", True),
                error=data.get("error"),
                created_at=data.get("created_at"),
                completed_at=data.get("completed_at"),
            )
            summarize_store[task_id] = job
        except Exception as e:
            logger.warning("Failed to load summarize meta %s: %s", meta_file, e)
    logger.info("Loaded %d summarize jobs", len(summarize_store))


def _process_summarize(job: SummarizeJob, reference_content: str | None):
    """后台任务: 执行 AI 总结。"""
    try:
        job.state = TaskState.processing
        job.progress = 0.1
        _save_summarize_meta(job)
        logger.info("[summarize %s] Processing started: preset=%s", job.job_id, job.preset)

        def progress_cb(progress: float, message: str):
            job.progress = progress
            logger.debug("[summarize %s] %s (%.0f%%)", job.job_id, message, progress * 100)

        # 获取音频文件名作为总结标题
        task = task_store.get(job.task_id)
        audio_title = ""
        if task and task.filename:
            audio_title = task.filename.rsplit(".", 1)[0] if "." in task.filename else task.filename

        result = run_summarize(
            task_id=job.task_id,
            preset=job.preset,
            audio_title=audio_title,
            reference_content=reference_content,
            include_intro=job.include_intro,
            progress_callback=progress_cb,
        )

        now = datetime.now(timezone.utc).isoformat()
        job.state = TaskState.completed
        job.progress = 1.0
        job.completed_at = now
        _save_summarize_meta(job)
        logger.info("[summarize %s] Completed: %d chars", job.job_id, len(result))

    except Exception as e:
        logger.exception("[summarize %s] Failed: %s", job.job_id, e)
        job.state = TaskState.failed
        job.error = str(e)
        _save_summarize_meta(job)


@app.get("/api/summarize/presets")
async def list_summarize_presets():
    """列出可用的总结预设"""
    return JSONResponse(content=get_preset_list())


@app.post("/api/tasks/{task_id}/summarize")
async def create_summarize(
    task_id: str,
    background_tasks: BackgroundTasks,
    preset: str = Form(default="podcast_polish", description="预设: podcast_polish | meeting_summary"),
    include_intro: bool = Form(default=True, description="参考材料作为节目介绍（仅播客预设）"),
    reference: UploadFile | None = File(default=None, description="参考材料文件（可选）"),
):
    """创建 AI 总结任务（异步）"""
    # 检查转录任务是否存在
    task = task_store.get(task_id)
    if task is None:
        # 也检查磁盘
        result_file = OUTPUT_DIR / f"{task_id}.json"
        if not result_file.exists():
            raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    # 检查预设
    if preset not in PRESETS:
        raise HTTPException(status_code=400, detail=f"未知预设: {preset}. 可用: {list(PRESETS.keys())}")

    # 读取参考材料
    reference_content = None
    if reference:
        raw = await reference.read()
        try:
            reference_content = raw.decode("utf-8")
        except UnicodeDecodeError:
            reference_content = raw.decode("gbk", errors="replace")
        logger.info("[summarize] Reference loaded: %s (%d chars)", reference.filename, len(reference_content))

    # 创建总结任务（替换已有的）
    job_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    job = SummarizeJob(
        job_id=job_id,
        task_id=task_id,
        preset=preset,
        state=TaskState.pending,
        progress=0.0,
        has_reference=reference_content is not None,
        include_intro=include_intro,
        created_at=now,
    )
    summarize_store[task_id] = job
    _save_summarize_meta(job)

    # 提交后台任务
    background_tasks.add_task(_process_summarize, job, reference_content)
    logger.info("[summarize %s] Created for task %s: preset=%s", job_id, task_id, preset)

    return JSONResponse(status_code=202, content=job.to_dict())


@app.get("/api/tasks/{task_id}/summarize")
async def get_summarize_status(task_id: str):
    """查询 AI 总结任务状态"""
    job = summarize_store.get(task_id)
    if job is None:
        # 尝试从磁盘加载
        meta_file = OUTPUT_DIR / f"{task_id}_summary_meta.json"
        if meta_file.exists():
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                job = SummarizeJob(
                    job_id=data.get("job_id", ""),
                    task_id=task_id,
                    preset=data.get("preset", "podcast_polish"),
                    state=TaskState(data.get("state", "completed")),
                    progress=data.get("progress", 1.0),
                    has_reference=data.get("has_reference", False),
                    include_intro=data.get("include_intro", True),
                    error=data.get("error"),
                    created_at=data.get("created_at"),
                    completed_at=data.get("completed_at"),
                )
                summarize_store[task_id] = job
            except Exception:
                pass

    if job is None:
        raise HTTPException(status_code=404, detail=f"No summarize job for task: {task_id}")

    return JSONResponse(content=job.to_dict())


@app.get("/api/tasks/{task_id}/summarize/result")
async def get_summarize_result(task_id: str):
    """获取 AI 总结结果（markdown）"""
    job = summarize_store.get(task_id)
    if job is None or job.state != TaskState.completed:
        # 检查磁盘
        summary_file = OUTPUT_DIR / f"{task_id}_summary.md"
        if not summary_file.exists():
            if job is None:
                raise HTTPException(status_code=404, detail="No summarize job found")
            raise HTTPException(status_code=400, detail=f"Summarize not completed (state={job.state.value})")

    summary_file = OUTPUT_DIR / f"{task_id}_summary.md"
    if not summary_file.exists():
        raise HTTPException(status_code=404, detail="Summary file not found")

    # 获取原始文件名用于下载名
    task = task_store.get(task_id)
    filename = get_summary_filename(task.filename) if task else f"{task_id}_asr.md"

    with open(summary_file, "r", encoding="utf-8") as f:
        content = f.read()

    return JSONResponse(content={"summary": content, "filename": filename})


@app.get("/api/tasks/{task_id}/summarize/preview")
async def preview_summarize_result(task_id: str):
    """以 HTML 页面形式展示总结结果（Markdown 渲染）"""
    job = summarize_store.get(task_id)
    if job is None or job.state != TaskState.completed:
        summary_file = OUTPUT_DIR / f"{task_id}_summary.md"
        if not summary_file.exists():
            raise HTTPException(status_code=404, detail="No summarize result found")
        raise HTTPException(status_code=400, detail="Summarize not completed")

    summary_file = OUTPUT_DIR / f"{task_id}_summary.md"
    if not summary_file.exists():
        raise HTTPException(status_code=404, detail="Summary file not found")

    with open(summary_file, "r", encoding="utf-8") as f:
        content = f.read()

    # 获取音频文件名作为页面标题
    task = task_store.get(task_id)
    page_title = f"总结结果 — {task.filename}" if task else "AI 总结结果"

    # 使用 JSON 编码安全地将内容嵌入 HTML
    content_json = json.dumps(content, ensure_ascii=False)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{page_title}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px 20px; background: #0f0f0f; color: #e0e0e0; line-height: 1.7; }}
  h1 {{ color: #fff; border-bottom: 1px solid #333; padding-bottom: 12px; }}
  h2 {{ color: #c9d1d9; margin-top: 28px; }}
  h3 {{ color: #b0b8c4; }}
  a {{ color: #58a6ff; }}
  code {{ background: #1a1a2e; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }}
  pre {{ background: #1a1a2e; padding: 16px; border-radius: 8px; overflow-x: auto; }}
  pre code {{ background: none; padding: 0; }}
  blockquote {{ border-left: 3px solid #333; margin-left: 0; padding-left: 16px; color: #8b949e; }}
  hr {{ border: none; border-top: 1px solid #333; margin: 24px 0; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #333; padding: 8px 12px; text-align: left; }}
  th {{ background: #161b22; }}
  p {{ margin: 8px 0; }}
</style>
</head>
<body>
<div id="content"></div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
  const content = {content_json};
  document.getElementById('content').innerHTML = marked.parse(content);
</script>
</body>
</html>"""

    return HTMLResponse(content=html)


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
