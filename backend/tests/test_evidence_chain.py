"""
证据链（source_refs）验证 —— 纪要结论能否回溯到原声，且不编造。

设计要点：LLM 可能编造时间戳，因此后端只在转录里**真的存在**足够接近的
片段时才生成证据引用。本套件重点验证这个"防编造"逻辑。

纯函数级测试，不需要 key、不需要启动服务。
"""
import sys
from pathlib import Path

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_c))
        break

from backend.meeting_summary import (  # noqa: E402
    _norm_time_hint, _normalize_blocks, _resolve_source_refs, _to_markdown,
)

pass_n = fail_n = 0


def chk(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name}  {extra}")
        fail_n += 1


SEGS = [
    {"start": 0.0, "end": 5.0, "text": "开场白", "recording_id": "r1",
     "recording_index": 0},
    {"start": 65.0, "end": 70.0, "text": "讨论分支结构", "recording_id": "r1",
     "recording_index": 0},
    {"start": 1094.9, "end": 1100.0, "text": "第二段开始", "recording_id": "r2",
     "recording_index": 1},
    {"start": 2111.0, "end": 2116.0, "text": "结尾", "recording_id": "r2",
     "recording_index": 1},
]

print("=== 1. 时间提示归一化 ===")
for raw, want in [(65, 65.0), ("01:05", 65), ("1:02:03", 3723),
                  ("00:00:05", 5), ("125", 125.0)]:
    chk(f"{raw!r} -> {want}", _norm_time_hint(raw) == want, _norm_time_hint(raw))
for bad in ("bad", None, -3, "", "1:2:3:4"):
    chk(f"{bad!r} -> None", _norm_time_hint(bad) is None, _norm_time_hint(bad))

print("\n=== 2. 证据解析：命中与容差 ===")
r = _resolve_source_refs([{"time": "01:05"}], SEGS)
chk("精确命中", len(r) == 1 and r[0]["start"] == 65.0, r)
chk("带出 recording_id", r and r[0]["recording_id"] == "r1", r)
chk("带出 quote", r and r[0]["quote"] == "讨论分支结构", r)
r = _resolve_source_refs([{"time": "01:07"}], SEGS)
chk("偏差 2 秒（容差内）命中", len(r) == 1, r)
r = _resolve_source_refs([{"time": "00:00"}], SEGS)
chk("纯字符串形式命中", len(r) == 1 and r[0]["start"] == 0.0, r)
r = _resolve_source_refs([{"at": "00:01:05"}], SEGS)
chk("at 字段 + HH:MM:SS", len(r) == 1 and r[0]["start"] == 65.0, r)

print("\n=== 3. 防编造（关键）===")
r = _resolve_source_refs([{"time": "10:00"}], SEGS)
chk("偏差过大被丢弃（不编造证据）", r == [], r)
r = _resolve_source_refs([{"time": "99:59:59"}], SEGS)
chk("完全不存在的时间被丢弃", r == [], r)
r = _resolve_source_refs([{"time": "01:05"}, {"time": "10:00"}], SEGS)
chk("混合时只保留有效的那条", len(r) == 1 and r[0]["start"] == 65.0, r)
chk("空输入返回空", _resolve_source_refs([], SEGS) == [])
chk("None 返回空", _resolve_source_refs(None, SEGS) == [])
chk("无 segments 时返回空", _resolve_source_refs([{"time": "01:05"}], []) == [])

print("\n=== 4. 去重与上限 ===")
r = _resolve_source_refs([{"time": "01:05"}, {"time": "01:05"}], SEGS)
chk("同一片段去重", len(r) == 1, r)
r = _resolve_source_refs([{"time": f"00:0{i}"} for i in range(1, 6)], SEGS, max_refs=3)
chk("受 max_refs 限制", len(r) <= 3, len(r))

print("\n=== 5. _normalize_blocks 集成 ===")
blocks = [
    {"type": "bullets", "title": "一、要点", "points": ["**A**：内容"],
     "source_refs": [{"time": "01:05"}]},
    {"type": "timeline", "title": "二、脉络",
     "items": [{"time": "00:00", "text": "开场"}, {"time": "01:05", "text": "分支"}]},
    {"type": "bullets", "title": "三、无证据", "points": ["普通要点"]},
]
out = _normalize_blocks(blocks, segments=SEGS)
chk("块数保持 3", len(out) == 3, len(out))
chk("显式 source_refs 被解析", out[0].get("source_refs", [{}])[0].get("start") == 65.0,
    out[0].get("source_refs"))
chk("timeline 的时间标注自动成为证据",
    len(out[1].get("source_refs") or []) == 2, out[1].get("source_refs"))
chk("无时间信息的块不硬造证据", "source_refs" not in out[2], out[2])

print("\n=== 6. 不传 segments 时不产生证据（向后兼容）===")
out2 = _normalize_blocks(blocks)
chk("无 segments 则无 source_refs",
    all("source_refs" not in b for b in out2), out2)

print("\n=== 7. Markdown 降级渲染不因证据字段出错 ===")
md = _to_markdown({"title": "T", "attendees": [], "summary": "S",
                   "blocks": [
                       {"type": "bullets", "title": "一", "points": ["p"],
                        "source_refs": [{"start": 65.0, "quote": "q"}]},
                       {"type": "todo", "title": "待办事项",
                        "headers": ["事项", "责任人", "截止时间"],
                        "rows": [["a", "b", "c"]]},
                   ],
                   "todos": [{"task": "a", "owner": "b", "due": "c"}]})
chk("渲染成功", "T" in md and "一" in md)
chk("待办只渲染一次",
    len([l for l in md.split("\n") if l.strip().startswith("## 待办事项")]) == 1,
    md)

print(f"\n{'='*58}\n证据链验证: {pass_n} 通过, {fail_n} 失败\n{'='*58}")
sys.exit(0 if fail_n == 0 else 1)
