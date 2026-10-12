"""
保存协议验证 —— 修订号 / 并发锁 / 计数口径 / 原子写 / 纪要待更新。

对应 QA 报告第二轮的问题：
  - R2-04 底栏「待保存 4 处」而后端报「已保存 2 处」（计数口径不一致）
  - R2-01/02 旧页面可覆盖新修改（无并发保护）
  - 纪要忽略 speaker_map、把录音编号当身份（R2-05）

自包含：假 ASR + 假 LLM，无需 key、无需启动服务。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path

import numpy as np

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        ROOT = _c
        sys.path.insert(0, str(ROOT))
        break

TMP = Path(tempfile.mkdtemp(prefix="ccasr_state_"))
os.environ["CCASR_OUTPUT_DIR"] = str(TMP)
os.environ.setdefault("OMP_NUM_THREADS", "1")

from fastapi.testclient import TestClient  # noqa: E402

import backend.file_store as fstore        # noqa: E402
import backend.project_store as pstore      # noqa: E402

pstore._store = None
fstore._file_store = None

import backend.app as appmod                # noqa: E402
import backend.meeting_summary as ms        # noqa: E402
from backend.fake_llm import FakeOpenAI     # noqa: E402
from backend.meeting_summary import _format_transcript, _speaker_table  # noqa: E402
from backend.schema import Segment          # noqa: E402

pass_n = fail_n = 0


def chk(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name}  {extra}")
        fail_n += 1


_rng = np.random.default_rng(23)
_BASE = _rng.normal(0, 1, (2, 192))
_BASE /= np.linalg.norm(_BASE, axis=1, keepdims=True)


class _Res:
    def __init__(self):
        self.segments = [Segment(start=i * 5.0, end=i * 5.0 + 4.0,
                                 text=f"文本{i}", speaker=f"SPEAKER_{i % 2}")
                         for i in range(6)]
        self.duration = 30.0
        self.num_speakers = 2
        self.audio_file = "a.wav"
        self.peaks = []

    def to_dict(self):
        return {"audio_file": self.audio_file, "duration": self.duration,
                "num_speakers": self.num_speakers,
                "segments": [asdict(s) for s in self.segments],
                "peaks": [], "model_info": {}}


class _Pipe:
    device = "cpu"

    def __init__(self):
        self.last_embeddings = []
        for i in range(6):
            v = _BASE[i % 2] + _rng.normal(0, 0.08, 192)
            self.last_embeddings.append(v / np.linalg.norm(v))
        self.last_segment_durations = [4.0] * 6

    @property
    def is_loaded(self):
        return True

    def transcribe(self, audio_path, language="zh", return_embeddings=False):
        return _Res()


appmod.get_backend = lambda device="auto", language="zh": _Pipe()
ms.set_llm_client_factory(FakeOpenAI)
client = TestClient(appmod.app)

AUDIO = ("a.wav", b"AUDIO-BYTES", "audio/wav")


def new_project(name="协议测试"):
    pid = client.post("/api/projects", json={"name": name}).json()["project_id"]
    client.post(f"/api/projects/{pid}/recordings", files=[("files", AUDIO)],
                data={"language": "zh", "start": "true"})
    return pid


# ── 1. revision 初始化与递增 ──────────────────────────────────
print("1) 修订号 revision")
pid = new_project()
tr = client.get(f"/api/projects/{pid}/transcript").json()
chk("新文档有 revision", isinstance(tr.get("revision"), int), tr.get("revision"))
rev0 = tr["revision"]

r = client.patch(f"/api/projects/{pid}/transcript", json={
    "segments": [{"id": tr["segments"][0]["id"], "text": "改一下"}],
    "revision": rev0,
})
chk("带正确 revision 保存 -> 200", r.status_code == 200, r.status_code)
chk("revision 递增", r.json().get("revision") == rev0 + 1, r.json().get("revision"))

print("\n2) 并发保护（旧页面不能覆盖新修改）")
r2 = client.patch(f"/api/projects/{pid}/transcript",
                  json={"segments": [], "revision": rev0})
chk("用过期 revision 保存 -> 409", r2.status_code == 409, r2.status_code)
chk("409 给出可读原因", "刷新" in r2.json().get("detail", ""),
    r2.json().get("detail"))
now = client.get(f"/api/projects/{pid}/transcript").json()
chk("被拒绝的请求未改动数据",
      now["segments"][0]["text"] == "改一下", now["segments"][0]["text"])
r3 = client.patch(f"/api/projects/{pid}/transcript",
                  json={"segments": [], "revision": now["revision"]})
chk("用最新 revision -> 200", r3.status_code == 200, r3.status_code)
r4 = client.patch(f"/api/projects/{pid}/transcript", json={"segments": []})
chk("不带 revision（向后兼容）-> 200", r4.status_code == 200, r4.status_code)

# ── 3. 计数口径 ───────────────────────────────────────────────
print("\n3) changes 明细口径（与前端底栏一致）")
pid = new_project("计数测试")
tr = client.get(f"/api/projects/{pid}/transcript").json()
segs = tr["segments"]

r = client.patch(f"/api/projects/{pid}/transcript", json={
    "segments": [
        {"id": segs[0]["id"], "text": "文字A"},
        {"id": segs[1]["id"], "text": "文字B"},
        {"id": segs[2]["id"], "speaker": "SPEAKER_1" if segs[2]["speaker"] != "SPEAKER_1" else "SPEAKER_0"},
    ],
    "speaker_map": {"SPEAKER_0": "leader", "SPEAKER_1": "我"},
    "revision": tr["revision"],
})
c = r.json().get("changes") or {}
chk("changes 字段齐全", set(c) == {"text", "speaker", "renamed"}, c)
chk("文字计数 = 2", c.get("text") == 2, c)
chk("归属计数 = 1", c.get("speaker") == 1, c)
chk("显示名计数 = 2", c.get("renamed") == 2, c)
chk("updated = 三者之和", r.json().get("updated") == c["text"] + c["speaker"] + c["renamed"],
    r.json().get("updated"))

print("\n4) 无变化时不递增修订号")
tr = client.get(f"/api/projects/{pid}/transcript").json()
r = client.patch(f"/api/projects/{pid}/transcript", json={
    "segments": [], "speaker_map": tr.get("speaker_map"), "revision": tr["revision"]})
chk("重复提交相同内容 updated=0", r.json().get("updated") == 0, r.json().get("updated"))
chk("revision 未变", r.json().get("revision") == tr["revision"], r.json().get("revision"))

print("\n5) num_speakers 重算")
tr = client.get(f"/api/projects/{pid}/transcript").json()
r = client.patch(f"/api/projects/{pid}/transcript", json={
    "segments": [{"id": s["id"], "speaker": "ONLY"} for s in tr["segments"]],
    "revision": tr["revision"],
})
after = client.get(f"/api/projects/{pid}/transcript").json()
chk("全部并为一个说话人", after["num_speakers"] == 1, after["num_speakers"])

# ── 6. 原子写 ─────────────────────────────────────────────────
print("\n6) 原子写（不产生半截文件）")
store = pstore.get_project_store()
tp = store._project_dir(pid) / "transcript.json"
raw = tp.read_text(encoding="utf-8")
json.loads(raw)          # 能解析
chk("transcript.json 是合法 JSON", True)
tmp_leftovers = list(store._project_dir(pid).glob("*.tmp"))
chk("没有残留的临时文件", not tmp_leftovers, tmp_leftovers)

print("\n7) 并发保存不互相覆盖（项目写锁）")
pid = new_project("并发测试")
tr = client.get(f"/api/projects/{pid}/transcript").json()
sid = tr["segments"][0]["id"]
N = 6
results = []
barrier = threading.Barrier(N)      # 用栅栏让 N 个请求尽量同时进入临界区


def save(text):
    try:
        barrier.wait(timeout=20)     # 齐了再一起发，制造真实并发
    except threading.BrokenBarrierError:
        pass
    rr = client.patch(f"/api/projects/{pid}/transcript",
                      json={"segments": [{"id": sid, "text": text}]})
    results.append(rr.status_code)


ths = [threading.Thread(target=save, args=(f"并发{i}",)) for i in range(N)]
for t in ths:
    t.start()
for t in ths:
    t.join(timeout=60)
chk(f"{N} 个并发保存全部返回 200", sorted(results) == [200] * N, results)
chk("没有请求丢失", len(results) == N, len(results))
final = client.get(f"/api/projects/{pid}/transcript").json()
chk("文件仍是合法 JSON（未被写坏）", isinstance(final["segments"], list))
chk("最终内容是某一次的值", final["segments"][0]["text"].startswith("并发"),
    final["segments"][0]["text"])
chk("修订号累计了 N 次（无丢失更新）",
    final["revision"] == N, f"revision={final['revision']} 期望={N}")

# ── 8. 纪要待更新标记 ─────────────────────────────────────────
print("\n8) 「纪要待更新」标记")
pid = new_project("过期标记")
chk("初始未标记过期",
    client.get(f"/api/projects/{pid}").json().get("summary_stale") is False)
tr = client.get(f"/api/projects/{pid}/transcript").json()
client.patch(f"/api/projects/{pid}/transcript", json={
    "segments": [{"id": tr["segments"][0]["id"], "text": "改了"}]})
chk("转录改动后标记为过期",
    client.get(f"/api/projects/{pid}").json().get("summary_stale") is True)

# ── 9. 纪要输入用显示名，录音编号不作身份 ─────────────────────
print("\n9) 纪要转录文本的说话人表达（R2-05）")
fake = {
    "segments": [
        {"id": "s1", "start": 5.0, "text": "第一句", "speaker": "SPEAKER_0",
         "recording_index": 0},
        {"id": "s2", "start": 20.0, "text": "第二句", "speaker": "SPEAKER_1",
         "recording_index": 1},
        {"id": "s3", "start": 40.0, "text": "第三句", "speaker": "SPEAKER_0",
         "recording_index": 1},
    ],
    "speaker_map": {"SPEAKER_0": "leader", "SPEAKER_1": "我"},
    "duration": 60.0,
}
tbl = _speaker_table(fake)
chk("参与者表用显示名", tbl == {"SPEAKER_0": "leader", "SPEAKER_1": "我"}, tbl)
txt, _ = _format_transcript(fake, 100000)
chk("转录用显示名而非 SPEAKER_x", "leader:" in txt and "我:" in txt, txt)
chk("转录里不再出现 SPEAKER_ 字样", "SPEAKER_" not in txt, txt)
chk("录音编号作为来源标注保留", "（录音1）" in txt and "（录音2）" in txt, txt)
chk("同一人跨录音仍是同一个名字",
      txt.count("leader:") == 2, txt)

# 未设显示名时回落原始 ID
tbl2 = _speaker_table({"segments": [{"speaker": "SPEAKER_3"}], "speaker_map": {}})
chk("未改名回落到原始 ID", tbl2 == {"SPEAKER_3": "SPEAKER_3"}, tbl2)

for p in [pid]:
    client.delete(f"/api/projects/{p}")
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'='*58}\n保存协议验证: {pass_n} 通过, {fail_n} 失败\n{'='*58}")
sys.exit(0 if fail_n == 0 else 1)
