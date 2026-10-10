"""真实会议测试：两份连续录音 → 串行转录 → 跨录音统一说话人 → 合并文档。

音频：微信目录里的 wx交接1-文档.wav (19.3min) + wx交接2-网站.wav (18.0min)
      —— 用户确认为**连着的同一场会议**，是跨录音说话人统一的真实用例。
"""
import time
from collections import Counter
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8000"
SRC = Path(r"C:\Users\59892\Documents\xwechat_files\wxid_26xjrug7t0ju22_6a0a\msg\file\2026-10")
FILES = [SRC / "wx交接1-文档.wav", SRC / "wx交接2-网站.wav"]

for f in FILES:
    if not f.exists():
        raise SystemExit(f"缺少音频: {f}")

total_mb = sum(f.stat().st_size for f in FILES) / 1024 / 1024
print(f"音频: {len(FILES)} 份, 合计 {total_mb:.1f} MB, "
      f"约 37 分钟（19.3 + 18.0）\n")

# ── 1. 建会议 ──────────────────────────────────────────────
r = requests.post(f"{BASE}/api/projects",
                  json={"name": "交接会议（文档+网站）"}, timeout=30)
r.raise_for_status()
pid = r.json()["project_id"]
print(f"1) 建会议 ✅  {pid}")

# ── 2. 一次上传两份 ────────────────────────────────────────
fhs = [("files", (f.name, open(f, "rb"), "audio/wav")) for f in FILES]
t_up = time.time()
r = requests.post(f"{BASE}/api/projects/{pid}/recordings", files=fhs,
                  data={"language": "zh", "start": "true"}, timeout=1800)
for _, (_, fh, _) in fhs:
    fh.close()
print(f"2) 上传 ✅  HTTP {r.status_code}, 耗时 {time.time()-t_up:.0f}s")
if r.status_code != 202:
    print("   ", r.text[:400]); raise SystemExit(1)
for rec in r.json()["added"]:
    print(f"     #{rec['order']} {rec['filename']}")

# ── 3. 等队列（串行）────────────────────────────────────────
print("\n3) 串行队列处理中（首次会加载模型）…")
t0 = time.time()
last = None
while True:
    time.sleep(10)
    p = requests.get(f"{BASE}/api/projects/{pid}", timeout=60).json()
    key = (p["state"], p["done_count"], p["summary_state"])
    if key != last:
        el = time.time() - t0
        states = " ".join(f"#{x['order']}={x['state'][:4]}" for x in p["recordings"])
        print(f"   [{el:6.1f}s] {p['state']:13s} 完成 {p['done_count']}/{p['recording_count']}"
              f"  纪要={p['summary_state']:9s} {states}")
        last = key
    if p["state"] in ("completed", "failed") and p["summary_state"] in ("completed", "failed"):
        break
    if time.time() - t0 > 3600:
        print("   超时"); break
elapsed = time.time() - t0

# ── 4. 各录音结果 ──────────────────────────────────────────
print(f"\n4) 队列结束，总耗时 {elapsed:.0f}s")
for rec in p["recordings"]:
    print(f"     #{rec['order']} {rec['filename']:20s} {rec['state']:10s} "
          f"{rec['duration']:7.1f}s"
          + (f"  err={rec['error'][:70]}" if rec.get("error") else ""))

# ── 5. 合并文档 ────────────────────────────────────────────
print("\n5) 合并文档")
r = requests.get(f"{BASE}/api/projects/{pid}/transcript", timeout=300)
if r.status_code != 200:
    print(f"   ❌ HTTP {r.status_code}: {r.text[:200]}")
    raise SystemExit(1)
tr = r.json()
segs = tr["segments"]
print(f"   段数={len(segs)}  说话人={tr['num_speakers']}  总时长={tr['duration']:.0f}s")
for rm in tr["recordings"]:
    print(f"     录音#{rm['order']} {rm['filename']:20s} offset={rm['offset']:8.1f}s "
          f"segs={rm['segment_count']:4d} spk={rm['num_speakers']}")

starts = [s["start"] for s in segs]
mono = starts == sorted(starts)
print(f"   时间轴单调递增: {mono}")

# ── 6. 跨录音说话人一致性（核心验收点）─────────────────────
print("\n6) 跨录音说话人统一（核心验收点）")
by_rec = {}
for s in segs:
    by_rec.setdefault(s["recording_index"], Counter())[s["speaker"]] += 1
for idx in sorted(by_rec):
    print(f"     录音#{idx} 说话人分布: {dict(by_rec[idx])}")
allspk = sorted({s["speaker"] for s in segs})
print(f"     全局说话人标签: {allspk}")

# 两段录音应共用同一套编号（而不是各自从 SPEAKER_0 重新编号）
per_rec_sets = [set(by_rec[i].keys()) for i in sorted(by_rec)]
shared = set.intersection(*per_rec_sets) if len(per_rec_sets) > 1 else set()
print(f"     两段录音共用的标签: {sorted(shared)}")

# ── 7. 纪要 ────────────────────────────────────────────────
sm = requests.get(f"{BASE}/api/projects/{pid}/summary", timeout=120).json()
print(f"\n7) 会议纪要: state={sm['state']}  has_summary={sm['has_summary']}")
if sm.get("error"):
    print(f"     {sm['error'][:110]}")

# ── 8. 抽样看内容 ──────────────────────────────────────────
print("\n8) 内容抽样")
print("   —— 录音1 开头 ——")
for s in segs[:3]:
    print(f"     [{s['start']:7.1f}] {s['speaker']} {s['text'][:56]}")
print("   —— 跨到录音2 的边界 ——")
for s in segs:
    if s["recording_index"] == 1 and s["local_start"] < 0.5:
        print(f"     [{s['start']:7.1f}] {s['speaker']} {s['text'][:56]}")
        break
print("   —— 结尾 ——")
for s in segs[-2:]:
    print(f"     [{s['start']:7.1f}] {s['speaker']} {s['text'][:56]}")

# ── 9. 导出 ────────────────────────────────────────────────
print("\n9) 导出")
for fmt in ("txt", "json"):
    r = requests.get(f"{BASE}/api/projects/{pid}/export?fmt={fmt}", timeout=180)
    print(f"     {fmt}: HTTP {r.status_code}"
          + (f"  {r.json()['filename']}  {len(r.json()['content'])} 字符"
             if r.status_code == 200 else f"  {r.text[:80]}"))

print(f"\n{'='*64}")
print(f"会议保留在 GUI 中: project_id = {pid}")
print(f"  （未删除，可打开 http://localhost:8000 查看）")
print("=" * 64)
