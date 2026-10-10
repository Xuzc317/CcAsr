"""
会议纪要「全链路」自包含集成验证。

与前一个 test_summary_over_http.py 的区别：
  - 那个需要**人工**以假 LLM 模式启动一个后端进程（且要关掉热重载）
  - 本脚本用 FastAPI TestClient 在自己进程内跑，**无需启动服务、无需 API key**，
    可直接作为回归测试反复运行（CI 友好）

覆盖的真实链路（只替换两处外部依赖）：
    多文件上传 → 串行队列（真实调度逻辑）→ 跨录音说话人统一（真实聚类）
        → 合并时间轴（真实拼接）→ 自动触发纪要 → /summary 响应
        → 结构化数据可被前端还原

替换的两处：
    - ASR 模型（用假 pipeline，避免几十秒推理）
    - LLM 客户端（用假客户端，避免网络与 key）
其余全部是真实生产代码。
"""
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

import numpy as np

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        ROOT = _c
        sys.path.insert(0, str(ROOT))
        break

# 必须在导入 backend.app 之前指定输出目录，避免污染真实数据
TMP = Path(tempfile.mkdtemp(prefix="ccasr_e2e_"))
os.environ["CCASR_OUTPUT_DIR"] = str(TMP)
os.environ.setdefault("OMP_NUM_THREADS", "1")

from fastapi.testclient import TestClient  # noqa: E402

import backend.config as cfg          # noqa: E402
import backend.file_store as fstore   # noqa: E402
import backend.project_store as pstore  # noqa: E402

# 重建单例，指向临时目录
pstore._store = None
fstore._file_store = None

import backend.app as appmod          # noqa: E402
import backend.meeting_summary as ms  # noqa: E402
from backend.fake_llm import FAKE_SUMMARY_JSON, FakeOpenAI  # noqa: E402
from backend.schema import Segment    # noqa: E402

pass_n = fail_n = 0


def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name} {extra}")
        fail_n += 1


# ── 假 ASR：模拟"同一场会议的两段录音，本地编号错位" ──────────
_rng = np.random.default_rng(1234)
_BASE = _rng.normal(0, 1, (2, 192))
_BASE /= np.linalg.norm(_BASE, axis=1, keepdims=True)
_call = {"n": 0}


def _emb(spk: int) -> np.ndarray:
    v = _BASE[spk] + _rng.normal(0, 0.10, 192)
    return v / np.linalg.norm(v)


class _FakeResult:
    def __init__(self, speakers):
        self.segments = [
            Segment(start=i * 5.0, end=i * 5.0 + 4.0,
                    text=f"第{i}句 说话人{speakers[i % len(speakers)]}",
                    speaker=f"SPEAKER_{speakers[i % len(speakers)]}")
            for i in range(6)
        ]
        self.duration = 30.0
        self.num_speakers = len(set(speakers))
        self.audio_file = "fake.wav"
        self.peaks = []

    def to_dict(self):
        return {"audio_file": self.audio_file, "duration": self.duration,
                "num_speakers": self.num_speakers,
                "segments": [asdict(s) for s in self.segments],
                "peaks": [], "model_info": {}}


class _FakePipeline:
    device = "cpu"

    def __init__(self):
        self.last_embeddings = None
        self.last_segment_durations = None

    def transcribe(self, audio_path, language="zh", return_embeddings=False):
        k = _call["n"]
        _call["n"] += 1
        # 录音0 本地编号 [0,1]，录音1 反转为 [1,0] —— 考验跨录音统一
        real = [0, 1] if k % 2 == 0 else [1, 0]
        self.last_embeddings = [_emb(real[i % 2]) for i in range(6)]
        self.last_segment_durations = [4.0] * 6
        return _FakeResult([0, 1])


appmod.get_backend = lambda device="auto", language="zh": _FakePipeline()
ms.set_llm_client_factory(FakeOpenAI)          # 注入假 LLM（本进程内，可靠）

client = TestClient(appmod.app)
print(f"临时输出目录: {TMP}\n")

# ── 1. 建会议 ─────────────────────────────────────────────────
r = client.post("/api/projects", json={"name": "纪要自包含验证"})
check("创建会议 201", r.status_code == 201, r.status_code)
pid = r.json()["project_id"]
print(f"  project_id = {pid}")

# ── 2. 一次上传两段 ───────────────────────────────────────────
files = [("files", (f"片段{i+1}.wav", f"AUDIO-{i}".encode(), "audio/wav"))
         for i in range(2)]
r = client.post(f"/api/projects/{pid}/recordings", files=files,
                data={"language": "zh", "start": "true"})
check("上传返回 202", r.status_code == 202, r.status_code)
body = r.json()
check("两段均已入队", len(body["added"]) == 2, len(body["added"]))
check("按上传顺序编号", [a["order"] for a in body["added"]] == [0, 1])

# ── 3. 队列 + 自动纪要（TestClient 会同步跑完 BackgroundTasks）──
p = client.get(f"/api/projects/{pid}").json()
print(f"\n  项目 state={p['state']}  summary_state={p['summary_state']}")
for rec in p["recordings"]:
    print(f"    #{rec['order']} {rec['filename']}  {rec['state']}  {rec['duration']}s")
check("两段都转录完成",
      all(r["state"] == "completed" for r in p["recordings"]),
      [r["state"] for r in p["recordings"]])
check("项目 state=completed", p["state"] == "completed", p["state"])
check("纪要自动完成（无需点按钮）", p["summary_state"] == "completed", p["summary_state"])
check("has_summary=True", p["has_summary"] is True)

# ── 4. 合并文档 ───────────────────────────────────────────────
tr = client.get(f"/api/projects/{pid}/transcript").json()
segs = tr["segments"]
starts = [s["start"] for s in segs]
print(f"\n  合并文档: {len(segs)} 段, {tr['num_speakers']} 说话人, {tr['duration']}s")
for rm in tr["recordings"]:
    print(f"    录音#{rm['order']} offset={rm['offset']}s segs={rm['segment_count']}")
check("段数 = 2 段 × 6", len(segs) == 12, len(segs))
check("时间轴单调递增", starts == sorted(starts))
check("第二段有全局偏移", tr["recordings"][1]["offset"] > 0,
      tr["recordings"][1]["offset"])

# ── 5. 跨录音说话人统一（核心）────────────────────────────────
by_rec = {}
for s in segs:
    by_rec.setdefault(s["recording_index"], set()).add(s["speaker"])
print(f"\n  各录音出现的标签: { {k: sorted(v) for k, v in by_rec.items()} }")
check("两段共用同一套说话人编号",
      by_rec[0] == by_rec[1] == {"SPEAKER_0", "SPEAKER_1"},
      {k: sorted(v) for k, v in by_rec.items()})

# ── 6. 纪要响应 ───────────────────────────────────────────────
sm = client.get(f"/api/projects/{pid}/summary").json()
check("纪要 state=completed", sm["state"] == "completed", sm["state"])
check("summary 非空", bool(sm.get("summary")))
md = sm.get("summary") or ""

# ── 7. 结构化数据 + 清洗 ──────────────────────────────────────
m = re.search(r"<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->", md)
check("Markdown 内嵌结构化数据", m is not None)
if m:
    data = json.loads(m.group(1))
    types = [b["type"] for b in data["blocks"]]
    print(f"\n  标题   : {data['title']}")
    print(f"  blocks : {types}")
    print(f"  待办   : {len(data['todos'])} 项")
    check("非法类型 flowchart 被清洗", "flowchart" not in types, types)
    check("空 items/points 的块被丢弃",
          not [b for b in data["blocks"]
               if b["type"] in ("columns", "timeline") and not b.get("items")
               or b["type"] == "bullets" and not b.get("points")])
    check("六类版式组件齐全",
          {"columns", "table", "timeline", "steps", "bullets", "todo"} <= set(types),
          types)
    check("待办字段齐全且归一化",
          all({"task", "owner", "due"} <= set(t) for t in data["todos"]),
          data["todos"])
    check("纯字符串待办被补默认值",
          any(t["owner"] == "未指定" for t in data["todos"]), data["todos"])

# ── 8. 导出 ───────────────────────────────────────────────────
for fmt, want in (("md", 200), ("txt", 200), ("json", 200)):
    r = client.get(f"/api/projects/{pid}/export?fmt={fmt}")
    check(f"导出 {fmt}", r.status_code == want, r.status_code)

# ── 9. 单段音频可回放 ─────────────────────────────────────────
rid = p["recordings"][0]["recording_id"]
r = client.get(f"/api/projects/{pid}/recordings/{rid}/audio",
               headers={"Range": "bytes=0-9"})
check("单段音频可回放（206）", r.status_code == 206, r.status_code)

# ── 10. 清理 ──────────────────────────────────────────────────
check("删除会议", client.delete(f"/api/projects/{pid}").status_code == 200)
check("删除后 404", client.get(f"/api/projects/{pid}").status_code == 404)

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'='*58}")
print(f"纪要自包含集成验证: {pass_n} 通过, {fail_n} 失败")
print("=" * 58)
sys.exit(0 if fail_n == 0 else 1)
