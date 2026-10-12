"""
质量与性能度量 —— 产出可量化的数字，而不是"看起来还行"。

测量内容（**全部是客观可算的**）：
  1. 各阶段耗时分离：转录 / 跨录音统一 / 合并 / LLM 纪要 / 端到端
  2. RTF（实时率）与端到端倍速
  3. 说话人一致性：已知同一场会议被切成多段时，各段是否共用同一套编号
  4. 转录基本统计：段数、总时长、平均段长、说话人分布、语种/情绪分布
  5. 证据链覆盖：纪要中多少比例的 block 挂上了可回溯的原声证据
  6. 进程内存峰值（psutil；未安装则如实说明未采集）

**不作声明**：未做人耳标注，因此不报告 CER/DER —— 那需要人工标注语料，
不能靠自动指标冒充。若要量化识别准确率，需按 README 的方式提供参考文稿。

用法：
    # 度量已有会议（不重跑转录）
    .venv\\Scripts\\python.exe backend\\tests\\quality_metrics.py <project_id>

    # 先真实跑一遍再度量（会消耗转录时间）
    .venv\\Scripts\\python.exe backend\\tests\\quality_metrics.py --run <audio1> [audio2 ...]

    # 把结果写入 JSON
    .venv\\Scripts\\python.exe backend\\tests\\quality_metrics.py <project_id> --json out.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8000"

try:
    import psutil
    _PROC = psutil.Process()
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


def _rss_mb() -> float | None:
    if not HAS_PSUTIL:
        return None
    try:
        return _PROC.memory_info().rss / 1024 / 1024
    except Exception:
        return None


def run_transcription(audio_paths: list[Path], language: str = "zh",
                      name: str = "质量度量") -> tuple[str, dict]:
    """上传并等待完成，返回 (project_id, 阶段耗时)。"""
    pid = requests.post(f"{BASE}/api/projects", json={"name": name},
                        timeout=30).json()["project_id"]
    files = [("files", (p.name, open(p, "rb"), "audio/wav")) for p in audio_paths]
    t0 = time.time()
    r = requests.post(f"{BASE}/api/projects/{pid}/recordings", files=files,
                      data={"language": language, "start": "true"}, timeout=1800)
    for _, (_, fh, _) in files:
        fh.close()
    if r.status_code != 202:
        raise SystemExit(f"上传失败 HTTP {r.status_code}: {r.text[:200]}")

    peak = _rss_mb() or 0.0
    marks = {}
    last = None
    while True:
        time.sleep(3)
        p = requests.get(f"{BASE}/api/projects/{pid}", timeout=60).json()
        cur = _rss_mb()
        if cur:
            peak = max(peak, cur)
        key = (p["state"], p["done_count"], p["summary_state"])
        if key != last:
            marks[f"{time.time()-t0:.1f}s"] = f"{p['state']}/{p['summary_state']} " \
                                              f"{p['done_count']}/{p['recording_count']}"
            last = key
        if p["state"] in ("completed", "failed") and \
                p["summary_state"] in ("completed", "failed"):
            break
        if time.time() - t0 > 3600:
            raise SystemExit("超时")
    return pid, {"wall_s": time.time() - t0, "peak_rss_mb": round(peak, 1),
                 "timeline": marks}


def measure(pid: str, wall: dict | None = None) -> dict:
    """对已有会议计算全部度量。"""
    out: dict = {"project_id": pid}

    proj = requests.get(f"{BASE}/api/projects/{pid}", timeout=60).json()
    out["project"] = {
        "name": proj["name"], "state": proj["state"],
        "recordings": proj["recording_count"],
        "total_duration_s": round(proj["total_duration"], 2),
        "failed": proj["failed_count"],
        "summary_state": proj["summary_state"],
    }

    tr = requests.get(f"{BASE}/api/projects/{pid}/transcript", timeout=300).json()
    segs = tr.get("segments", [])
    if not segs:
        out["error"] = "该会议尚无转录结果"
        return out

    # ── 转录统计 ──
    durs = [float(s["end"]) - float(s["start"]) for s in segs]
    speakers = Counter(s.get("speaker", "") for s in segs)
    langs = Counter(s.get("language", "") or "?" for s in segs)
    emos = Counter(s.get("emotion", "") or "?" for s in segs)
    out["transcript"] = {
        "segments": len(segs),
        "num_speakers": tr.get("num_speakers"),
        "global_duration_s": round(tr.get("duration", 0.0), 2),
        "seg_duration_avg_s": round(sum(durs) / len(durs), 2) if durs else 0,
        "seg_duration_min_s": round(min(durs), 2) if durs else 0,
        "seg_duration_max_s": round(max(durs), 2) if durs else 0,
        "speaker_dist": dict(speakers),
        "language_dist": dict(langs),
        "emotion_dist": dict(emos),
        "monotonic_timeline": [float(s["start"]) for s in segs]
                              == sorted(float(s["start"]) for s in segs),
    }

    # ── 跨录音说话人一致性（核心质量指标）──
    per_rec: dict[int, set] = {}
    for s in segs:
        per_rec.setdefault(s["recording_index"], set()).add(s["speaker"])
    recs = tr.get("recordings", [])
    out["speaker_consistency"] = {
        "per_recording_labels": {str(k): sorted(v) for k, v in sorted(per_rec.items())},
        "shared_labels_all_recordings":
            sorted(set.intersection(*per_rec.values())) if len(per_rec) > 1 else [],
        # 若各段独立编号，标签集会互不相同（例如录音2出现 SPEAKER_2/3）
        "all_recordings_same_label_set":
            len({frozenset(v) for v in per_rec.values()}) == 1 if per_rec else None,
        "total_distinct_labels": len(set().union(*per_rec.values())) if per_rec else 0,
    }
    out["recording_offsets_s"] = [
        {"order": r["order"], "filename": r["filename"],
         "offset": round(r["offset"], 2), "duration": round(r["duration"], 2),
         "segments": r["segment_count"]}
        for r in recs
    ]

    # ── 纪要 + 证据覆盖 ──
    s = requests.get(f"{BASE}/api/projects/{pid}/summary", timeout=300).json()
    md = s.get("summary") or ""
    out["summary"] = {
        "state": s["state"], "has_summary": s["has_summary"],
        "chars": len(md),
    }
    import re
    m = re.search(r"<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->", md)
    if m:
        try:
            data = json.loads(m.group(1))
        except Exception:
            data = None
        if data:
            blocks = data.get("blocks", [])
            with_refs = [b for b in blocks if b.get("source_refs")]
            refs = sum(len(b.get("source_refs") or []) for b in blocks)
            todo_blocks = [b for b in blocks if b.get("type") == "todo"]
            out["summary"].update({
                "blocks": len(blocks),
                "block_types": dict(Counter(b["type"] for b in blocks)),
                "blocks_with_evidence": len(with_refs),
                "evidence_coverage": round(len(with_refs) / len(blocks), 3)
                                      if blocks else 0.0,
                "total_evidence_refs": refs,
                "todos": len(data.get("todos") or []),
                "todo_sections_in_md": len([l for l in md.split("\n")
                                            if l.strip().startswith("## 待办事项")]),
                "todo_blocks": len(todo_blocks),
            })

    # ── 性能 ──
    dur = out["transcript"]["global_duration_s"]
    perf: dict = {"audio_duration_s": dur}
    if wall:
        perf.update(wall)
        if dur > 0:
            perf["end_to_end_rtf"] = round(wall["wall_s"] / dur, 4)
            perf["end_to_end_speedup"] = round(dur / wall["wall_s"], 2)
    else:
        perf["note"] = "本次未重新计时（度量已有会议）；用 --run 可获得端到端耗时"
    perf["peak_rss_mb"] = wall.get("peak_rss_mb") if wall else _rss_mb()
    perf["memory_collected"] = HAS_PSUTIL
    if not HAS_PSUTIL:
        perf["memory_note"] = "未安装 psutil，内存未采集（pip install psutil 后可采集）"
    out["performance"] = perf

    out["not_measured"] = [
        "CER/WER（需要人工标注的参考文稿）",
        "说话人 DER（需要人工标注的说话人时间轴）",
        "定位误差（需要人工听辨）",
    ]
    return out


def print_report(d: dict) -> None:
    print("=" * 66)
    print(f"质量与性能度量 —— {d['project'].get('name')}  ({d['project_id']})")
    print("=" * 66)
    if d.get("error"):
        print("  ", d["error"]); return

    t = d["transcript"]
    print("\n【转录】")
    print(f"  段数            : {t['segments']}")
    print(f"  说话人          : {t['num_speakers']}  {t['speaker_dist']}")
    print(f"  音频总时长      : {t['global_duration_s']}s")
    print(f"  段长 平均/最小/最大: {t['seg_duration_avg_s']} / "
          f"{t['seg_duration_min_s']} / {t['seg_duration_max_s']} s")
    print(f"  时间轴单调      : {t['monotonic_timeline']}")
    print(f"  语种分布        : {t['language_dist']}")
    print(f"  情绪分布        : {t['emotion_dist']}")

    sc = d["speaker_consistency"]
    print("\n【跨录音说话人一致性】")
    for k, v in sc["per_recording_labels"].items():
        print(f"  录音#{k} 标签     : {v}")
    print(f"  各段标签集相同  : {sc['all_recordings_same_label_set']}  "
          f"(True = 全会议共用一套编号)")
    print(f"  全局不同标签数  : {sc['total_distinct_labels']}")

    print("\n【录音时间轴】")
    for r in d["recording_offsets_s"]:
        print(f"  #{r['order']} {r['filename'][:26]:28s} offset={r['offset']:8.2f}s "
              f"dur={r['duration']:7.2f}s segs={r['segments']}")

    su = d["summary"]
    print("\n【会议纪要】")
    print(f"  状态            : {su['state']}   字数: {su['chars']}")
    if "blocks" in su:
        print(f"  blocks          : {su['blocks']}  {su['block_types']}")
        print(f"  含证据的 block  : {su['blocks_with_evidence']}/{su['blocks']}  "
              f"覆盖率 {su['evidence_coverage']*100:.0f}%")
        print(f"  证据引用总数    : {su['total_evidence_refs']}")
        print(f"  待办            : {su['todos']} 项；"
              f"MD 中待办章节 {su['todo_sections_in_md']} 个（应为 1）")

    p = d["performance"]
    print("\n【性能】")
    print(f"  音频时长        : {p['audio_duration_s']}s")
    if "wall_s" in p:
        print(f"  端到端耗时      : {p['wall_s']:.1f}s")
        print(f"  端到端 RTF      : {p.get('end_to_end_rtf')}  "
              f"({p.get('end_to_end_speedup')}x 实时)")
    print(f"  峰值内存        : "
          f"{p['peak_rss_mb']} MB" if p.get("memory_collected")
          else f"  峰值内存        : 未采集（{p.get('memory_note')}）")
    if p.get("timeline"):
        print("  状态时间线:")
        for k, v in p["timeline"].items():
            print(f"    {k:>9s}  {v}")

    print("\n【未度量项（需人工标注，不作自动声明）】")
    for x in d["not_measured"]:
        print(f"  - {x}")


def main() -> int:
    ap = argparse.ArgumentParser(description="CcAsr 质量与性能度量")
    ap.add_argument("project_id", nargs="?", help="已有会议 ID")
    ap.add_argument("--run", nargs="+", metavar="AUDIO",
                    help="先真实跑一遍这些音频，再度量")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--name", default="质量度量")
    ap.add_argument("--json", metavar="PATH", help="同时写入 JSON")
    ap.add_argument("--keep", action="store_true", help="保留 --run 创建的会议")
    args = ap.parse_args()

    wall = None
    pid = args.project_id
    if args.run:
        paths = [Path(p) for p in args.run]
        for p in paths:
            if not p.exists():
                print(f"音频不存在: {p}"); return 1
        print(f"上传并转录 {len(paths)} 个文件…")
        pid, wall = run_transcription(paths, args.language, args.name)
        print(f"完成，会议 ID = {pid}\n")
    if not pid:
        ap.error("需要给出 project_id，或使用 --run 指定音频")

    d = measure(pid, wall)
    print_report(d)

    if args.json:
        Path(args.json).write_text(json.dumps(d, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
        print(f"\n已写入 {args.json}")

    if args.run and not args.keep:
        requests.delete(f"{BASE}/api/projects/{pid}", timeout=30)
        print(f"已清理临时会议 {pid}（--keep 可保留）")
    return 0 if not d.get("error") else 1


if __name__ == "__main__":
    sys.exit(main())
