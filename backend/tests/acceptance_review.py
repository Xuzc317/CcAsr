"""Real-server acceptance audit. Uses existing samples and real ASR/LLM.

Run from the repository root. Keeps the smoke and two-part meetings for UI review;
removes only the auxiliary meetings created by this script. Evidence stays in
backend/tests/_out/acceptance_review (ignored by Git).
"""
from contextlib import ExitStack
from pathlib import Path
from datetime import datetime
import json
import sys
import time
import wave

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "backend/tests/_out/acceptance_review"
BASE = "http://127.0.0.1:8000"
OUT.mkdir(parents=True, exist_ok=True)
results = {"started": datetime.now().astimezone().isoformat(), "checks": [], "projects": {}}


def save():
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


def check(name, ok, details=None):
    results["checks"].append({"name": name, "passed": bool(ok), "details": details})
    print(f"{'PASS' if ok else 'FAIL'} {name}: {details}", flush=True)
    save()


def get(path):
    r = requests.get(BASE + path, timeout=30)
    r.raise_for_status()
    return r.json()


def create(label, name=None):
    r = requests.post(BASE + "/api/projects", json={"name": name or f"QA-20261012-{label}"}, timeout=30)
    r.raise_for_status()
    proj = r.json()["project_id"]
    results["projects"][label] = proj
    save()
    return proj


def upload(proj, paths, start=True, names=None):
    with ExitStack() as stack:
        files = [("files", ((names or [p.name for p in paths])[i], stack.enter_context(p.open("rb")), "audio/wav"))
                 for i, p in enumerate(paths)]
        return requests.post(f"{BASE}/api/projects/{proj}/recordings", files=files,
                             data={"language": "zh", "start": str(start).lower()}, timeout=120)


def wait(proj, label, timeout=1200):
    began = time.monotonic()
    history, previous = [], None
    while time.monotonic() - began < timeout:
        p = get(f"/api/projects/{proj}")
        state = (p["state"], p["done_count"], p["summary_state"], tuple(r["state"] for r in p["recordings"]))
        if state != previous:
            event = {"seconds": round(time.monotonic() - began, 2), "state": state}
            history.append(event)
            print(label, event, flush=True)
            previous = state
        if p["state"] in ("completed", "failed") and p["summary_state"] != "processing":
            results[label + "_history"] = history
            results[label + "_elapsed_s"] = round(time.monotonic() - began, 2)
            (OUT / f"{label}_project.json").write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")
            save()
            return p
        time.sleep(1)
    raise TimeoutError(label)


def evidence(proj, label):
    tr = get(f"/api/projects/{proj}/transcript")
    sm = get(f"/api/projects/{proj}/summary")
    (OUT / f"{label}_transcript.json").write_text(json.dumps(tr, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / f"{label}_summary.md").write_text(sm.get("summary") or "", encoding="utf-8")
    results[label + "_metrics"] = {"segments": len(tr["segments"]), "speakers": tr["num_speakers"],
        "duration": tr["duration"], "recordings": tr["recordings"], "summary_state": sm["state"]}
    check(label + ": real summary", sm["state"] == "completed" and bool(sm.get("summary")), sm["state"])
    for fmt in ("txt", "json", "md"):
        r = requests.get(f"{BASE}/api/projects/{proj}/export", params={"fmt": fmt}, timeout=30)
        check(label + ": export " + fmt, r.status_code == 200 and bool(r.json().get("content")), r.status_code)
        if r.status_code == 200:
            (OUT / f"{label}_export.{fmt}").write_text(r.json()["content"], encoding="utf-8")
    return tr, sm


def remove(proj):
    r = requests.delete(f"{BASE}/api/projects/{proj}", timeout=30)
    check("auxiliary project cleanup", r.status_code == 200, proj)


def main():
    health = get("/health")
    results["health"] = health
    check("health and real LLM config", health["status"] == "ok" and health["llm"]["ok"]
          and health["llm"]["model"] == "deepseek-chat" and not health["llm_fake"], health["device"])
    short = ROOT / "samples/zh_sapi.wav"
    smoke = create("smoke")
    check("smoke upload", upload(smoke, [short]).status_code == 202)
    p = wait(smoke, "smoke")
    check("single-file completed", p["state"] == "completed" and p["done_count"] == 1, p["state"])
    evidence(smoke, "smoke")

    batch = create("batch", 'QA-测试：冒号/斜杠|竖线?问号*星号')
    for i in range(3):
        r = upload(batch, [short], start=False, names=[f"批{i+1}.wav"])
        p = get(f"/api/projects/{batch}")
        check(f"batch {i+1}: draft and count", r.status_code == 202 and p["state"] == "draft"
              and p["recording_count"] == i+1, {"http": r.status_code, "state": p["state"], "count": p["recording_count"]})
    r = requests.post(f"{BASE}/api/projects/{batch}/start", timeout=30)
    check("batch start", r.status_code == 202)
    time.sleep(0.5)
    r = upload(batch, [short])
    check("running upload guard", r.status_code == 409, {"http": r.status_code, "body": r.json()})
    p = wait(batch, "batch")
    check("batch all 3 completed", p["state"] == "completed" and p["done_count"] == 3, p["done_count"])
    for fmt in ("txt", "json", "md"):
        r = requests.get(f"{BASE}/api/projects/{batch}/export?fmt={fmt}", timeout=30)
        fn = r.json().get("filename", "")
        check("safe filename " + fmt, r.status_code == 200 and not (set(fn) & set('\\/:*?"<>|：')), fn)
    r1 = requests.post(f"{BASE}/api/projects/{batch}/summary/regenerate", timeout=30)
    r2 = requests.post(f"{BASE}/api/projects/{batch}/summary/regenerate", timeout=30)
    check("duplicate summary guard", [r1.status_code, r2.status_code] == [202, 409], [r1.status_code, r2.status_code])
    wait(batch, "batch_regenerate")
    remove(batch)

    bad = create("bad")
    check("bad file accepted for processing", upload(bad, [ROOT / "README.md"], names=["假的.wav"]).status_code == 202)
    p = wait(bad, "bad")
    error = p["recordings"][0].get("error", "")
    check("bad file fails without service crash", p["state"] == "failed" and p["recordings"][0]["state"] == "failed"
          and get("/health")["status"] == "ok", {"state": p["state"], "error": error[:300]})
    check("bad file error mentions ffmpeg", "ffmpeg" in error.lower(), error[:300])
    r = requests.post(f"{BASE}/api/projects/{bad}/start", timeout=30)
    check("retry failed item accepted", r.status_code == 202, {"http": r.status_code, "body": r.json()})
    if r.status_code == 202:
        wait(bad, "bad_retry")
    remove(bad)

    multi = create("multi")
    paths = sorted((ROOT / "samples/multi_meeting").glob("*.wav"))
    check("two-part samples", len(paths) == 2, [p.name for p in paths])
    check("two-part upload", upload(multi, paths).status_code == 202)
    p = wait(multi, "multi")
    check("two-part completed", p["state"] == "completed" and p["done_count"] == 2, p["state"])
    tr, sm = evidence(multi, "multi")
    starts = [s["start"] for s in tr["segments"]]
    check("global timeline monotonic", starts == sorted(starts))
    check("global/local timestamp mapping", all(abs(s["start"] - s["local_start"] - tr["recordings"][s["recording_index"]]["offset"]) < 0.005 for s in tr["segments"]))
    check("587 segments baseline", len(starts) == 587, len(starts))
    labels = sorted({s["speaker"] for s in tr["segments"]})
    per_rec = [sorted({s["speaker"] for s in tr["segments"] if s["recording_index"] == i}) for i in range(2)]
    check("2 global shared speaker labels", labels == ["SPEAKER_0", "SPEAKER_1"] and per_rec[0] == per_rec[1], per_rec)
    with wave.open(str(paths[0]), "rb") as w:
        physical_duration = w.getnframes() / w.getframerate()
    results["multi_physical_first_duration"] = physical_duration
    check("offset covers full first audio plus 1s gap", abs(tr["recordings"][1]["offset"] - physical_duration - 1.0) < 0.02,
          {"physical_duration": physical_duration, "expected_with_gap": physical_duration + 1.0,
           "offset": tr["recordings"][1]["offset"]})
    for rec in tr["recordings"]:
        r = requests.get(f"{BASE}/api/projects/{multi}/recordings/{rec['recording_id']}/audio",
                         headers={"Range": "bytes=0-63"}, timeout=30)
        check("range playback " + rec["filename"], r.status_code == 206 and len(r.content) == 64,
              {"http": r.status_code, "range": r.headers.get("Content-Range")})
    r = requests.get(f"{BASE}/api/projects/{multi}/recordings/not-a-member/audio", timeout=30)
    check("unknown recording 404", r.status_code == 404, r.status_code)
    for path in ("/meetings", f"/meeting/{multi}"):
        r = requests.get(BASE + path, timeout=30)
        check("SPA direct reload " + path, r.status_code == 200 and "<title>CcAsr</title>" in r.text, r.status_code)
    results["finished"] = datetime.now().astimezone().isoformat()
    save()
    print(f"Evidence: {OUT}", flush=True)


def inspect_existing():
    """Read-only checks after manually editing the retained meetings in the UI."""
    global results
    results = json.loads((OUT / "results.json").read_text(encoding="utf-8"))
    proj = results["projects"]["multi"]
    tr = get(f"/api/projects/{proj}/transcript")
    check("UI edits persisted after re-entry", tr.get("speaker_map") == {"SPEAKER_0": "张三", "SPEAKER_1": "李四"}
          and any(s["text"] == "【已校对】测试文本" for s in tr["segments"]), tr.get("speaker_map"))
    txt = get(f"/api/projects/{proj}/export?fmt=txt")["content"]
    check("TXT preserves corrected text", "【已校对】测试文本" in txt)
    check("TXT uses speaker display names", "张三:" in txt and "李四:" in txt,
          {"has_raw_id": "SPEAKER_0:" in txt, "has_display_name": "张三:" in txt})
    (OUT / "multi_edited_export.txt").write_text(txt, encoding="utf-8")
    for label in ("smoke", "multi"):
        summary = get(f"/api/projects/{results['projects'][label]}/summary")["summary"]
        body = summary.split("<!-- CCASR_STRUCTURED_SUMMARY", 1)[0]
        count = body.count("## 待办事项")
        check(label + ": one todo table in Markdown export", count <= 1, count)
        check(label + ": no legacy brand in generated summary", "winasr" not in summary.lower())
    smoke = results["projects"]["smoke"]
    r = requests.get(f"{BASE}/api/projects/{smoke}/recordings/{tr['recordings'][0]['recording_id']}/audio",
                     headers={"Range": "bytes=0-63"}, timeout=30)
    check("recording must belong to requested project", r.status_code == 404,
          {"http": r.status_code, "range": r.headers.get("Content-Range")})
    results["inspected"] = datetime.now().astimezone().isoformat()
    save()


if __name__ == "__main__":
    if "--inspect" in sys.argv:
        inspect_existing()
    else:
        main()
    passed = sum(c["passed"] for c in results["checks"])
    total = len(results["checks"])
    print(f"Acceptance checks: {passed}/{total} passed", flush=True)
    sys.exit(0 if passed == total else 1)
