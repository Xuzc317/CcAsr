"""
会议纪要「全链路」集成验证 —— 走真实 HTTP，只把 LLM 换成假客户端。

补齐此前未覆盖的接缝：
    上传 → 串行队列 → 跨录音统一 → 合并 → **自动触发纪要** → /summary 响应
        → 前端 parseStructuredSummary 能否还原

用法（需后端已启动）：
    # 终端 A：以注入假 LLM 的方式启动后端（仅有假 key 时生效，见 meeting_summary）
    CCASR_LLM_FAKE=1 .venv\\Scripts\\python.exe run_server.py
    # 终端 B：
    .venv\\Scripts\\python.exe backend\\tests\\test_summary_over_http.py

假 LLM 返回一份**结构合法、故意混入脏数据**的纪要，用于验证：
  - 非法 block 类型被清洗
  - 缺字段/空 items 的块被丢弃
  - 待办字段被归一化
  - 结构化数据内嵌进 Markdown
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8000"

# ── 与后端约定：假 LLM 模式下会返回这份内容 ──────────────────
_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_c))
        break
from backend.fake_llm import FAKE_SUMMARY_JSON  # noqa: E402

pass_n = fail_n = 0


def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name} {extra}")
        fail_n += 1


print("=== 0. 确认后端处于假 LLM 模式 ===")
try:
    probe = requests.get(f"{BASE}/health", timeout=15).json()
except Exception as e:
    raise SystemExit(f"后端未启动或不可达: {e}")
print(f"  health pid={probe['code']['pid']} routing={probe['asr_routing']['mode']}")
if not probe.get("llm_fake"):
    raise SystemExit(
        "\n后端不是假 LLM 模式。请用以下方式启动后端后重试：\n"
        "  $env:CCASR_LLM_FAKE='1'; .venv\\Scripts\\python.exe run_server.py"
    )
print("  ✅ 已确认是假 LLM 模式")

# ── 建会议并上传 ─────────────────────────────────────────────
print("\n=== 1. 建会议 + 上传两段真实录音 ===")
pid = requests.post(f"{BASE}/api/projects",
                    json={"name": "纪要全链路验证"}, timeout=30).json()["project_id"]
SRC = Path("samples")
files = [("files", ("p1.wav", open(SRC / "zh_sapi.wav", "rb"), "audio/wav")),
         ("files", ("p2.wav", open(SRC / "test_dialog.wav", "rb"), "audio/wav"))]
r = requests.post(f"{BASE}/api/projects/{pid}/recordings", files=files,
                  data={"language": "zh", "start": "true"}, timeout=600)
for _, (_, fh, _) in files:
    fh.close()
check("上传返回 202", r.status_code == 202, r.status_code)

print("\n=== 2. 等队列 + 自动纪要 ===")
t0 = time.time()
while True:
    time.sleep(4)
    p = requests.get(f"{BASE}/api/projects/{pid}", timeout=60).json()
    if p["state"] in ("completed", "failed") and p["summary_state"] in ("completed", "failed"):
        break
    if time.time() - t0 > 900:
        raise SystemExit("超时")
print(f"  耗时 {time.time()-t0:.0f}s  state={p['state']}  summary_state={p['summary_state']}")
check("项目完成", p["state"] == "completed", p["state"])
check("纪要自动完成（无需点按钮）", p["summary_state"] == "completed", p["summary_state"])
check("has_summary=True", p["has_summary"] is True)

# ── 纪要响应 ─────────────────────────────────────────────────
print("\n=== 3. /summary 响应 ===")
sm = requests.get(f"{BASE}/api/projects/{pid}/summary", timeout=60).json()
check("state=completed", sm["state"] == "completed", sm["state"])
check("summary 非空", bool(sm.get("summary")))
md = sm["summary"] or ""

print("\n=== 4. 结构化数据内嵌 ===")
m = re.search(r"<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->", md)
check("Markdown 内含结构化注释", m is not None)
if m:
    data = json.loads(m.group(1))
    print(f"  标题     : {data['title']}")
    print(f"  参会人   : {data['attendees']}")
    print(f"  blocks   : {[b['type'] for b in data['blocks']]}")
    print(f"  待办     : {len(data['todos'])} 项")

    types = {b["type"] for b in data["blocks"]}
    check("非法类型 flowchart 已被清洗", "flowchart" not in types, sorted(types))
    check("缺 items 的空块已丢弃",
          not [b for b in data["blocks"]
               if b["type"] in ("columns", "timeline") and not b.get("items")])
    check("六类版式组件齐全",
          {"columns", "table", "timeline", "steps", "bullets"} <= types, sorted(types))
    check("待办字段归一化",
          all({"task", "owner", "due"} <= set(t) for t in data["todos"]), data["todos"])
    check("含待办表格块", "todo" in types)

    # ── 前端解析（与 TS 实现同款正则/逻辑）──────────────────
    print("\n=== 5. 前端解析等价验证 ===")
    check("正文剥离后不含注释",
          "CCASR_STRUCTURED_SUMMARY" not in md.replace(m.group(0), "").strip())
    check("blocks 为数组", isinstance(data["blocks"], list))
    check("每个 block 都有 type 字段",
          all(isinstance(b.get("type"), str) for b in data["blocks"]))

print("\n=== 6. 导出（纪要为 md）===")
r = requests.get(f"{BASE}/api/projects/{pid}/export?fmt=md", timeout=60)
check("导出 md 成功", r.status_code == 200, r.status_code)
if r.status_code == 200:
    print(f"  {r.json()['filename']}  {len(r.json()['content'])} 字符")

print(f"\n（保留会议 {pid} 供 GUI 查看；如需清理请手动删除）")
print(f"\n{'='*56}\n纪要全链路: {pass_n} 通过, {fail_n} 失败\n{'='*56}")
sys.exit(0 if fail_n == 0 else 1)
