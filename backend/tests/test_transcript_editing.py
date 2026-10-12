"""
合并文档「编辑」功能验证 —— 说话人改名 + 文本校对。

这是用户可见但此前未验证的功能：
  前端 TranscriptWorkspace 支持双击改文本、给说话人改名，
  保存时 PATCH /api/projects/{id}/transcript。
本脚本验证后端真的持久化了这些编辑，且不会误改其它字段。

自包含：假 ASR + 假 LLM，无需 key、无需启动服务。
"""
import os
import shutil
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

import numpy as np

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        ROOT = _c
        sys.path.insert(0, str(ROOT))
        break

TMP = Path(tempfile.mkdtemp(prefix="ccasr_edit_"))
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
from backend.schema import Segment          # noqa: E402

pass_n = fail_n = 0


def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name} {extra}")
        fail_n += 1


_rng = np.random.default_rng(7)
_BASE = _rng.normal(0, 1, (2, 192))
_BASE /= np.linalg.norm(_BASE, axis=1, keepdims=True)


def _emb(s):
    v = _BASE[s] + _rng.normal(0, 0.10, 192)
    return v / np.linalg.norm(v)


class _Res:
    def __init__(self):
        self.segments = [
            Segment(start=i * 5.0, end=i * 5.0 + 4.0,
                    text=f"原始文本{i}", speaker=f"SPEAKER_{i % 2}")
            for i in range(4)
        ]
        self.duration = 20.0
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
        self.last_embeddings = [_emb(i % 2) for i in range(4)]
        self.last_segment_durations = [4.0] * 4

    def transcribe(self, audio_path, language="zh", return_embeddings=False):
        return _Res()


appmod.get_backend = lambda device="auto", language="zh": _Pipe()
ms.set_llm_client_factory(FakeOpenAI)
client = TestClient(appmod.app)

AUDIO = ("a.wav", b"AUDIO", "audio/wav")


def new_project(name="编辑测试"):
    """建一个会议并跑完转录，返回 project_id"""
    _pid = client.post("/api/projects", json={"name": name}).json()["project_id"]
    client.post(f"/api/projects/{_pid}/recordings",
                files=[("files", AUDIO)],
                data={"language": "zh", "start": "true"})
    return _pid


# ── 准备一个有转录的会议 ──────────────────────────────────────
pid = client.post("/api/projects", json={"name": "编辑功能验证"}).json()["project_id"]
client.post(f"/api/projects/{pid}/recordings",
            files=[("files", ("a.wav", b"AUDIO", "audio/wav"))],
            data={"language": "zh", "start": "true"})

tr = client.get(f"/api/projects/{pid}/transcript").json()
segs = tr["segments"]
print(f"会议 {pid}：{len(segs)} 段\n")

check("合并文档已生成", len(segs) == 4, len(segs))
first_id = segs[0]["id"]
first_text = segs[0]["text"]

print("\n=== 1. 修改某一段文本 ===")
r = client.patch(f"/api/projects/{pid}/transcript",
                 json={"segments": [{"id": first_id, "text": "校对后的文本"}]})
check("PATCH 返回 200", r.status_code == 200, r.status_code)
check("返回 updated=1", r.json().get("updated") == 1, r.json().get("updated"))

tr2 = client.get(f"/api/projects/{pid}/transcript").json()
s0 = next(s for s in tr2["segments"] if s["id"] == first_id)
check("文本已持久化", s0["text"] == "校对后的文本", s0["text"])
check("其它段落未被误改",
      all(s["text"] == f"原始文本{i}" for i, s in enumerate(tr2["segments"][1:], start=1)),
      [s["text"] for s in tr2["segments"][1:]])

print("\n=== 2. 修改说话人标签 ===")
# 把第一段改到 SPEAKER_1
r = client.patch(f"/api/projects/{pid}/transcript",
                 json={"segments": [{"id": first_id, "speaker": "SPEAKER_9"}]})
check("PATCH 返回 200", r.status_code == 200, r.status_code)
tr3 = client.get(f"/api/projects/{pid}/transcript").json()
s0 = next(s for s in tr3["segments"] if s["id"] == first_id)
check("说话人标签已更新", s0["speaker"] == "SPEAKER_9", s0["speaker"])

print("\n=== 3. 保存说话人显示名映射（speaker_map）===")
r = client.patch(f"/api/projects/{pid}/transcript",
                 json={"segments": [],
                       "speaker_map": {"SPEAKER_0": "张三", "SPEAKER_9": "李四"}})
check("PATCH 返回 200", r.status_code == 200, r.status_code)
tr4 = client.get(f"/api/projects/{pid}/transcript").json()
check("speaker_map 已保存",
      tr4.get("speaker_map") == {"SPEAKER_0": "张三", "SPEAKER_9": "李四"},
      tr4.get("speaker_map"))

print("\n=== 4. 边界：未知 id / 空请求不应破坏数据 ===")
before = client.get(f"/api/projects/{pid}/transcript").json()
r = client.patch(f"/api/projects/{pid}/transcript",
                 json={"segments": [{"id": "不存在的id", "text": "x"}]})
check("未知 id 的 PATCH 不报错", r.status_code == 200, r.status_code)
check("未知 id 返回 updated=0", r.json().get("updated") == 0, r.json().get("updated"))
after = client.get(f"/api/projects/{pid}/transcript").json()
check("数据未被破坏", before == after)

r = client.patch(f"/api/projects/{pid}/transcript", json={})
check("空请求不报错", r.status_code == 200, r.status_code)
check("空请求后段数不变",
      len(client.get(f"/api/projects/{pid}/transcript").json()["segments"]) == 4)

print("\n=== 5. 导出应反映编辑结果 ===")
r = client.get(f"/api/projects/{pid}/export?fmt=txt")
check("导出 txt 200", r.status_code == 200, r.status_code)
if r.status_code == 200:
    content = r.json()["content"]
    check("导出含校对后的文本", "校对后的文本" in content)
    # 关键：导出必须用 speaker_map 里的**显示名**，而不是原始编号。
    # 此前只断言编号变化，漏掉了"改名后导出仍是 SPEAKER_x"的真实缺陷（QA 报告 B02）。
    check("导出使用说话人显示名（李四）", "李四" in content, content[:160])
    check("导出不应再出现被改名的原始编号",
          "SPEAKER_9" not in content, content[:160])
    # 未改名的说话人应回退原始编号，而非空白
    check("未改名的说话人回退原始编号", "SPEAKER_1" in content, content[:200])

print("\n=== 6. 不存在的项目应 404 ===")
check("PATCH 不存在项目 -> 404",
      client.patch("/api/projects/nope/transcript", json={}).status_code == 404)
check("GET 不存在项目 transcript -> 404",
      client.get("/api/projects/nope/transcript").status_code == 404)

# ══════════════════════════════════════════════════════════════
# 转录完成后的三类修改（对应腾讯会议的编辑能力）
# ══════════════════════════════════════════════════════════════
print("\n=== 7. 批量改判：把某人全部发言改给另一个人 ===")
pid = new_project("改判测试")
tr = client.get(f"/api/projects/{pid}/transcript").json()
before = {}
for s in tr["segments"]:
    before[s["speaker"]] = before.get(s["speaker"], 0) + 1
check("初始有 2 位说话人", len(before) == 2, before)

# SPEAKER_1 -> SPEAKER_0（合并两人）
r = client.post(f"/api/projects/{pid}/transcript/reassign",
                json={"from": "SPEAKER_1", "to": "SPEAKER_0"})
check("改判返回 200", r.status_code == 200, r.status_code)
check("改判段数 = 原 SPEAKER_1 的段数",
      r.json()["changed"] == before.get("SPEAKER_1", 0), r.json().get("changed"))

tr = client.get(f"/api/projects/{pid}/transcript").json()
after = {}
for s in tr["segments"]:
    after[s["speaker"]] = after.get(s["speaker"], 0) + 1
check("全部并到 SPEAKER_0", after == {"SPEAKER_0": sum(before.values())}, after)
check("num_speakers 重算为 1", tr["num_speakers"] == 1, tr["num_speakers"])
check("总段数不变", len(tr["segments"]) == len(before and tr["segments"]))

print("\n=== 8. 改判：显示名跟着迁移 ===")
client.patch(f"/api/projects/{pid}/transcript",
             json={"segments": [], "speaker_map": {"SPEAKER_0": "leader"}})
r = client.post(f"/api/projects/{pid}/transcript/reassign",
                json={"from": "SPEAKER_0", "to": "BOSS"})
check("改判到新标签 200", r.status_code == 200, r.status_code)
tr = client.get(f"/api/projects/{pid}/transcript").json()
check("标签已变 BOSS", all(s["speaker"] == "BOSS" for s in tr["segments"]))
check("显示名迁移到 BOSS", tr["speaker_map"].get("BOSS") == "leader",
      tr["speaker_map"])
check("旧标签从 speaker_map 移除", "SPEAKER_0" not in tr["speaker_map"],
      tr["speaker_map"])
txt = client.get(f"/api/projects/{pid}/export?fmt=txt").json()["content"]
check("导出用迁移后的显示名", "leader" in txt, txt[:80])

print("\n=== 9. 改判的边界 ===")
check("缺 from 参数 -> 400",
      client.post(f"/api/projects/{pid}/transcript/reassign",
                  json={"to": "X"}).status_code == 400)
check("缺 to 参数 -> 400",
      client.post(f"/api/projects/{pid}/transcript/reassign",
                  json={"from": "X"}).status_code == 400)
r = client.post(f"/api/projects/{pid}/transcript/reassign",
                json={"from": "BOSS", "to": "BOSS"})
check("from == to 返回 changed=0", r.status_code == 200
      and r.json()["changed"] == 0, r.json())
check("改判不存在的说话人 -> 404",
      client.post(f"/api/projects/{pid}/transcript/reassign",
                  json={"from": "不存在", "to": "X"}).status_code == 404)
check("不存在项目改判 -> 404",
      client.post("/api/projects/nope/transcript/reassign",
                  json={"from": "a", "to": "b"}).status_code == 404)
client.delete(f"/api/projects/{pid}")

print("\n=== 10. 三类修改一次性提交 ===")
pid = new_project("三类修改")
tr = client.get(f"/api/projects/{pid}/transcript").json()
segs = tr["segments"]
# 同时：改 display name、改第一句归属、改第二句文字
payload = {
    "segments": [
        {"id": segs[0]["id"], "speaker": "SPEAKER_1"},      # 归属改判
        {"id": segs[1]["id"], "text": "改过的第二句"},        # 文字校对
    ],
    "speaker_map": {"SPEAKER_0": "leader", "SPEAKER_1": "我"},
}
r = client.patch(f"/api/projects/{pid}/transcript", json=payload)
check("一次 PATCH 成功", r.status_code == 200, r.status_code)
tr = client.get(f"/api/projects/{pid}/transcript").json()
check("改名生效", tr["speaker_map"] == {"SPEAKER_0": "leader", "SPEAKER_1": "我"},
      tr["speaker_map"])
check("归属改判生效", tr["segments"][0]["speaker"] == "SPEAKER_1",
      tr["segments"][0]["speaker"])
check("文字校对生效", tr["segments"][1]["text"] == "改过的第二句",
      tr["segments"][1]["text"])
check("未提及的段保持原样", tr["segments"][2]["text"] == segs[2]["text"])
txt = client.get(f"/api/projects/{pid}/export?fmt=txt").json()["content"]
check("导出同时反映改名与新归属",
      "leader" in txt and "我" in txt and "改过的第二句" in txt, txt[:200])
check("导出不再出现原始编号",
      "SPEAKER_0" not in txt and "SPEAKER_1" not in txt, txt[:200])
client.delete(f"/api/projects/{pid}")

client.delete(f"/api/projects/{pid}")
shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'='*58}\n合并文档编辑验证: {pass_n} 通过, {fail_n} 失败\n{'='*58}")
sys.exit(0 if fail_n == 0 else 1)
