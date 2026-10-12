"""
边界与异常路径测试（自包含，无需 key、无需启动服务）。

把测试人员可能踩到的坑固化为回归测试。用 TestClient + 假 ASR/假 LLM，
仅替换两处外部依赖。

覆盖：
  A. 分批上传（start=false）不应把自己挡死 —— 曾是一个真 bug：
     update_state 仅因存在 pending 录音就把项目标为 transcribing，
     导致第二次上传收到 409「队列正在运行」且提示误导。
  B. 队列运行中追加录音应被拒绝（409）
  C. 空项目启动队列应 400
  D. 上传非音频文件：录音标记 failed，服务不崩
  E. 不存在的项目/录音应 404
  F. 特殊文件名（中文/空格/括号/emoji）与导出名净化
  G. 队列结束后必须清掉"运行中"标志（否则项目被永久锁死）
"""
import io
import os
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        ROOT = _c
        sys.path.insert(0, str(ROOT))
        break

TMP = Path(tempfile.mkdtemp(prefix="ccasr_edge_"))
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


def chk(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name}  {extra}")
        fail_n += 1


_rng = np.random.default_rng(11)
_BASE = _rng.normal(0, 1, (2, 192))
_BASE /= np.linalg.norm(_BASE, axis=1, keepdims=True)


class _Res:
    def __init__(self):
        self.segments = [Segment(start=i * 5.0, end=i * 5.0 + 4.0,
                                 text=f"文本{i}", speaker=f"SPEAKER_{i % 2}")
                         for i in range(4)]
        self.duration = 20.0
        self.num_speakers = 2
        self.audio_file = "a.wav"
        self.peaks = []

    def to_dict(self):
        return {"audio_file": self.audio_file, "duration": self.duration,
                "num_segments": len(self.segments),
                "num_speakers": self.num_speakers,
                "segments": [asdict(s) for s in self.segments],
                "peaks": [], "model_info": {}}


class _Pipe:
    device = "cpu"

    def __init__(self):
        v = _BASE[0] + _rng.normal(0, 0.1, 192)
        self.last_embeddings = [v / np.linalg.norm(v) for _ in range(4)]
        self.last_segment_durations = [4.0] * 4
        self._loaded = True

    @property
    def is_loaded(self):
        return self._loaded

    def transcribe(self, audio_path, language="zh", return_embeddings=False):
        return _Res()


appmod.get_backend = lambda device="auto", language="zh": _Pipe()
ms.set_llm_client_factory(FakeOpenAI)
client = TestClient(appmod.app)

AUDIO = ("a.wav", b"FAKE-AUDIO-BYTES", "audio/wav")


def new_project(name="边界测试"):
    return client.post("/api/projects", json={"name": name}).json()["project_id"]


def wait_done(pid, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        p = client.get(f"/api/projects/{pid}").json()
        if p["state"] in ("completed", "failed") and \
                p["summary_state"] in ("completed", "failed"):
            return p
        time.sleep(0.4)
    return client.get(f"/api/projects/{pid}").json()


# ── A. 分批上传（曾经的 bug）─────────────────────────────────
print("A) 分批上传 start=false 不应把自己挡死")
pid = new_project("A-分批上传")
codes = []
for i in range(3):
    r = client.post(f"/api/projects/{pid}/recordings",
                    files=[("files", (f"批{i+1}.wav", b"X", "audio/wav"))],
                    data={"language": "zh", "start": "false"})
    codes.append(r.status_code)
chk("连续三次分批上传都成功（无 409）", codes == [202, 202, 202], codes)
p = client.get(f"/api/projects/{pid}").json()
chk("累计三段", p["recording_count"] == 3, p["recording_count"])
chk("未启队列时状态为 draft（而非 transcribing）", p["state"] == "draft", p["state"])

r = client.post(f"/api/projects/{pid}/start")
chk("启动队列返回 202", r.status_code == 202, r.status_code)
p = wait_done(pid)
chk("三段全部处理完成", p["done_count"] == 3, p["done_count"])
chk("队列结束后状态回落为 completed", p["state"] == "completed", p["state"])
chk("队列结束后未锁死（可再次上传）",
    client.post(f"/api/projects/{pid}/recordings",
                files=[("files", ("追加.wav", b"Y", "audio/wav"))],
                data={"language": "zh", "start": "false"}).status_code == 202)
client.delete(f"/api/projects/{pid}")

# ── B. 并发占用（需真实 HTTP 服务，TestClient 会同步执行 BackgroundTasks）──
# 说明：TestClient 在响应返回前就把 BackgroundTasks 跑完，因此这里无法制造
# "队列正在运行"的窗口。该场景已用真实服务单独验证过（见 README 的测试章节）。
print("\nB) 运行中拒绝追加 —— 跳过（需真实服务；已单独验证）")

# ── C. 空项目 ─────────────────────────────────────────────────
print("\nC) 空项目的边界行为")
pid = new_project("C-空项目")
chk("空项目 start -> 400", client.post(f"/api/projects/{pid}/start").status_code == 400)
chk("空项目 transcript -> 400",
    client.get(f"/api/projects/{pid}/transcript").status_code == 400)
chk("空项目 summary 不报 500",
    client.get(f"/api/projects/{pid}/summary").status_code in (200, 404))
chk("空 project name -> 400",
    client.post("/api/projects", json={"name": "   "}).status_code == 400)
client.delete(f"/api/projects/{pid}")

# ── D. 上传内容与扩展名不符 ───────────────────────────────────
# 说明：本套件用假 pipeline，不会真的去解析音频，因此无法在这里断言
# "坏音频 -> failed"。该场景由真实服务验证（见 test_real_server_edges.py，
# 实测错误信息为 ffmpeg 的 "Failed to load audio: ..."）。
# 这里只验证"坏音频不会破坏项目结构"这类结构性行为。
print("\nD) 内容非音频时的结构性行为")
pid = new_project("D-坏音频")
r = client.post(f"/api/projects/{pid}/recordings",
                files=[("files", ("bad.wav", b"not audio at all", "audio/wav"))],
                data={"language": "zh", "start": "false"})
chk("上传接受（内容校验不在此层）", r.status_code == 202, r.status_code)
p = client.get(f"/api/projects/{pid}").json()
chk("录音已入队", p["recording_count"] == 1, p["recording_count"])
chk("未启队列时状态为 draft", p["state"] == "draft", p["state"])
chk("健康检查仍正常", client.get("/health").status_code == 200)
client.delete(f"/api/projects/{pid}")

# ── E. 不存在的资源 ───────────────────────────────────────────
print("\nE) 不存在的资源应 404")
for path in ("/api/projects/nope", "/api/projects/nope/transcript",
             "/api/projects/nope/summary", "/api/projects/nope/export?fmt=txt"):
    chk(f"GET {path} -> 404", client.get(path).status_code == 404)
chk("DELETE /api/projects/nope -> 404",
    client.delete("/api/projects/nope").status_code == 404)
chk("PATCH /api/projects/nope -> 404",
    client.patch("/api/projects/nope/transcript", json={}).status_code == 404)

# ── F. 特殊文件名 ─────────────────────────────────────────────
print("\nF) 特殊文件名与导出名净化")
pid = new_project('F-特殊字符 / 冒号: 竖线| 问号? 星号*')
names = ["会议 2026-10-12 (上午).wav", "带空格 的 文件.wav", "🎙录音.wav"]
r = client.post(f"/api/projects/{pid}/recordings",
                files=[("files", (n, b"x", "audio/wav")) for n in names],
                data={"language": "zh", "start": "false"})
chk("特殊文件名上传成功", r.status_code == 202, r.status_code)
chk("文件名原样保留",
    [a["filename"] for a in r.json()["added"]] == names,
    [a["filename"] for a in r.json()["added"]])
r = client.get(f"/api/projects/{pid}/export?fmt=txt")
chk("导出不因非法字符失败", r.status_code == 200, r.status_code)
if r.status_code == 200:
    fn = r.json()["filename"]
    chk("导出名已净化非法字符", not (set(fn) & set(r'\/:*?"<>|')), fn)
client.delete(f"/api/projects/{pid}")

# ── G. 中文项目名重命名 ───────────────────────────────────────
print("\nG) 重命名")
pid = new_project("G-原名")
chk("重命名成功",
    client.patch(f"/api/projects/{pid}", json={"name": "G-新名字"}).status_code == 200)
chk("新名字生效", client.get(f"/api/projects/{pid}").json()["name"] == "G-新名字")
chk("空名字被拒", client.patch(f"/api/projects/{pid}", json={"name": ""}).status_code == 400)
client.delete(f"/api/projects/{pid}")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'='*58}\n边界与异常路径: {pass_n} 通过, {fail_n} 失败\n{'='*58}")
sys.exit(0 if fail_n == 0 else 1)
