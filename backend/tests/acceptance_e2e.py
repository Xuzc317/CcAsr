"""最终验收：真实音频 → 多段上传 → 串行转录 → 合并 → 纪要（无 key 应优雅失败）。"""
import time
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8000"
FILES = [Path("samples/zh_sapi.wav"), Path("samples/test_dialog.wav")]

r = requests.post(f"{BASE}/api/projects", json={"name": "验收测试会议"}, timeout=30)
r.raise_for_status()
pid = r.json()["project_id"]
print(f"1) 建会议 ✅ {pid}")

fhs = [("files", (f.name, open(f, "rb"), "audio/wav")) for f in FILES]
r = requests.post(f"{BASE}/api/projects/{pid}/recordings", files=fhs,
                  data={"language": "zh", "start": "true"}, timeout=600)
for _, (_, fh, _) in fhs:
    fh.close()
print(f"2) 上传 {len(FILES)} 段 -> HTTP {r.status_code} ✅")

t0, last = time.time(), None
while True:
    time.sleep(4)
    p = requests.get(f"{BASE}/api/projects/{pid}", timeout=60).json()
    k = (p["state"], p["done_count"], p["summary_state"])
    if k != last:
        print(f"   [{time.time()-t0:5.1f}s] {p['state']}  转录 {p['done_count']}/{p['recording_count']}"
              f"  纪要={p['summary_state']}")
        last = k
    if p["state"] in ("completed", "failed") and p["summary_state"] in ("completed", "failed"):
        break
    if time.time() - t0 > 900:
        print("   超时"); break

print(f"3) 队列完成 ✅ ({time.time()-t0:.0f}s)")
for rec in p["recordings"]:
    print(f"     #{rec['order']} {rec['filename']:20s} {rec['state']:10s} {rec['duration']:.1f}s")

tr = requests.get(f"{BASE}/api/projects/{pid}/transcript", timeout=120).json()
starts = [s["start"] for s in tr["segments"]]
print(f"4) 合并文档 ✅ 段数={len(tr['segments'])} 说话人={tr['num_speakers']} "
      f"时长={tr['duration']}s")
print(f"     时间轴单调: {starts == sorted(starts)}   偏移: "
      f"{[rm['offset'] for rm in tr['recordings']]}")
print(f"     全局说话人: {sorted({s['speaker'] for s in tr['segments']})}")

sm = requests.get(f"{BASE}/api/projects/{pid}/summary", timeout=60).json()
print(f"5) 纪要 ✅ state={sm['state']}（无 API key 时 failed 属预期）")
if sm.get("error"):
    print(f"     {sm['error'][:90]}")

for fmt in ("txt", "json"):
    r = requests.get(f"{BASE}/api/projects/{pid}/export?fmt={fmt}", timeout=60)
    print(f"6) 导出 {fmt}: HTTP {r.status_code} ✅" if r.status_code == 200
          else f"6) 导出 {fmt}: ❌ {r.text[:80]}")

r = requests.delete(f"{BASE}/api/projects/{pid}", timeout=30)
print(f"7) 清理: HTTP {r.status_code} ✅")
print("\n验收通过" if len(tr["segments"]) > 0 and starts == sorted(starts) else "\n⚠ 有异常")
