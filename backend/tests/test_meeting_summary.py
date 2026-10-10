"""
会议纪要管道端到端验证（注入假 LLM 客户端，除网络外全链路真实）。

覆盖：
  1. 正常 JSON 输出 → 结构化 block 归一化 → 内嵌 Markdown
  2. 代码围栏包裹的 JSON（LLM 常见行为）→ 容错提取
  3. 前后夹带解释文字的 JSON → 容错提取
  4. 完全无法解析 → 降级为纯文本，绝不抛异常
  5. 非法 block 类型 / 缺字段 → 被清洗而非让前端崩
  6. 前端解析函数能否从 Markdown 里还原结构化数据（用 TS 同款正则）
"""
import os
os.environ.setdefault("OMP_NUM_THREADS", "1")

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

# 让 `import backend.*` 生效：向上找到包含 backend/__init__.py 的目录
_here = Path(__file__).resolve()
for _cand in _here.parents:
    if (_cand / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_cand))
        break

import backend.meeting_summary as ms
from backend.schema import Project, Recording, TaskState

# 提供假的 LLM 配置（真实调用被下面的工厂注入拦截）
os.environ["CCASR_LLM_API_BASE"] = "https://fake.local/v1"
os.environ["CCASR_LLM_API_KEY"] = "fake-key-for-test"
os.environ["CCASR_LLM_MODEL"] = "fake-model"

# ── 构造一个真实的 Project + transcript ──────────────────────
proj = Project(project_id="p1", name="11月产品评审会")
proj.recordings = [
    Recording(recording_id="r1", project_id="p1", filename="part1.wav",
              order=0, state=TaskState.completed, duration=30.0),
    Recording(recording_id="r2", project_id="p1", filename="part2.wav",
              order=1, state=TaskState.completed, duration=20.0),
]
transcript = {
    "project_id": "p1",
    "name": "11月产品评审会",
    "duration": 51.0,
    "num_speakers": 2,
    "recordings": [
        {"recording_id": "r1", "filename": "part1.wav", "order": 0,
         "duration": 30.0, "offset": 0.0, "segment_count": 2, "num_speakers": 2,
         "language": "zh"},
        {"recording_id": "r2", "filename": "part2.wav", "order": 1,
         "duration": 20.0, "offset": 31.0, "segment_count": 1, "num_speakers": 1,
         "language": "zh"},
    ],
    "segments": [
        {"id": "a", "start": 0.0, "end": 5.0, "local_start": 0.0, "speaker": "SPEAKER_0",
         "text": "我们先看上半年的销售数据", "recording_id": "r1", "recording_index": 0},
        {"id": "b", "start": 5.0, "end": 12.0, "local_start": 5.0, "speaker": "SPEAKER_1",
         "text": "同比增长了百分之十八，但获客成本也涨了", "recording_id": "r1", "recording_index": 0},
        {"id": "c", "start": 31.0, "end": 38.0, "local_start": 0.0, "speaker": "SPEAKER_0",
         "text": "那下一步的重点是把复购率做上去", "recording_id": "r2", "recording_index": 1},
    ],
}

# ── 假 LLM 客户端 ─────────────────────────────────────────────
VALID_JSON = {
    "title": "上半年业绩复盘与Q4规划",
    "attendees": ["SPEAKER_0", "SPEAKER_1"],
    "summary": "复盘上半年销售表现，讨论获客成本压力，确定Q4以复购率为核心目标。",
    "blocks": [
        {"type": "bullets", "title": "一、核心结论",
         "points": ["**销售增长**：同比增长 18%",
                    "**成本压力**：获客成本同步上升"]},
        {"type": "columns", "title": "二、议题拆解", "items": [
            {"icon": "📊", "heading": "销售与渠道", "points": ["增长 18%", "渠道结构待优化"]},
            {"icon": "🎯", "heading": "用户运营", "points": ["复购率是Q4重点", "需补充留存数据"]},
        ]},
        {"type": "timeline", "title": "三、讨论脉络", "items": [
            {"time": "00:00", "text": "开场，回顾上半年数据"},
            {"time": "00:05", "text": "指出获客成本问题"},
            {"time": "00:31", "text": "确定Q4聚焦复购率"},
        ]},
        {"type": "steps", "title": "四、推进步骤", "items": [
            {"heading": "数据补齐", "text": "补齐留存与复购口径"},
            {"heading": "方案评审", "text": "下周评审Q4增长方案"},
        ]},
        {"type": "table", "title": "五、指标对比",
         "headers": ["指标", "上半年", "目标"],
         "rows": [["销售增长", "18%", "20%"], ["获客成本", "上升", "持平"]]},
        # 故意混入非法类型与缺字段，验证清洗
        {"type": "flowchart", "title": "不该出现的类型", "nodes": []},
        {"type": "timeline", "title": "缺 items 的块"},
        {"type": "columns", "title": "空 items 的块", "items": []},
    ],
    "todos": [
        {"task": "补齐留存数据", "owner": "SPEAKER_1", "due": "本周五"},
        {"task": "评审Q4增长方案", "owner": "SPEAKER_0", "due": "未提及"},
        "缺字段的字符串待办",
    ],
}


class FakeMessage:
    def __init__(self, content):
        self.content = content


class FakeChoice:
    def __init__(self, content, finish_reason="stop"):
        self.message = FakeMessage(content)
        self.finish_reason = finish_reason


class FakeResponse:
    def __init__(self, content, finish_reason="stop"):
        self.choices = [FakeChoice(content, finish_reason)]


class FakeCompletions:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return FakeResponse(self.payloads.pop(0) if self.payloads else "{}")


class FakeClient:
    def __init__(self, payloads):
        self.chat = SimpleNamespace(completions=FakeCompletions(payloads))


def run_case(name, payloads, expect_structured=True):
    print(f"\n{'='*66}\n{name}\n{'='*66}")
    fake = FakeClient(payloads)
    # 通过官方注入点替换客户端工厂 + 用环境变量提供假配置
    ms.set_llm_client_factory(lambda **kw: fake)

    result = ms.generate_meeting_summary(proj, transcript)
    ok = True

    has_struct = "CCASR_STRUCTURED_SUMMARY" in result
    print(f"  输出长度      : {len(result)}")
    print(f"  含结构化注释  : {has_struct}")
    print(f"  LLM 调用次数  : {len(fake.chat.completions.calls)}")

    if expect_structured:
        if not has_struct:
            print("  ❌ 期望结构化输出但未找到"); ok = False
        else:
            m = re.search(r"<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->", result)
            data = json.loads(m.group(1))
            print(f"  标题          : {data['title']}")
            print(f"  参会人        : {data['attendees']}")
            print(f"  blocks        : {[b['type'] for b in data['blocks']]}")
            print(f"  待办          : {len(data['todos'])} 项")
            # 校验清洗：非法类型不应出现
            types = {b["type"] for b in data["blocks"]}
            if "flowchart" in types:
                print("  ❌ 非法类型 flowchart 未被清洗"); ok = False
            else:
                print("  ✅ 非法类型 flowchart 已清洗")
            # 空 items 的块应被丢弃
            empties = [b for b in data["blocks"]
                       if b["type"] in ("columns", "timeline") and not b.get("items")]
            if empties:
                print(f"  ❌ 存在空 items 块: {[b['title'] for b in empties]}"); ok = False
            else:
                print("  ✅ 缺字段/空 items 的块已丢弃")
            # 待办归一化
            for t in data["todos"]:
                if not all(k in t for k in ("task", "owner", "due")):
                    print("  ❌ 待办字段不完整"); ok = False
            print(f"  ✅ 待办字段齐全: {data['todos']}")
            # Markdown 正文应可读
            if "**销售增长**" not in result and "销售增长" not in result:
                print("  ⚠ Markdown 正文缺少要点")
            print("  --- Markdown 前 12 行 ---")
            for line in result.split("\n")[:12]:
                print("   ", line)
    else:
        if not result.strip():
            print("  ❌ 输出为空"); ok = False
        print("  --- 降级输出前 6 行 ---")
        for line in result.split("\n")[:6]:
            print("   ", line)
        if "降级" not in result:
            print("  ⚠ 未标注降级")
        else:
            print("  ✅ 已标注为降级输出")

    print(f"  结果: {'✅ PASS' if ok else '❌ FAIL'}")
    return ok


results = []

# 场景 1：正常 JSON
results.append(run_case("场景 1：LLM 正常返回 JSON", [json.dumps(VALID_JSON, ensure_ascii=False)]))

# 场景 2：代码围栏包裹
results.append(run_case(
    "场景 2：JSON 被 ```json 围栏包裹（LLM 常见行为）",
    ["```json\n" + json.dumps(VALID_JSON, ensure_ascii=False) + "\n```"]))

# 场景 3：前后夹带解释
results.append(run_case(
    "场景 3：JSON 前后夹带解释文字",
    ["好的，以下是会议纪要：\n\n" + json.dumps(VALID_JSON, ensure_ascii=False) + "\n\n希望有帮助！"]))

# 场景 4：完全无法解析 → 降级
results.append(run_case(
    "场景 4：两次都返回非 JSON → 应降级而非崩溃",
    ["抱歉，我无法完成这个请求。", "仍然不是 JSON。"], expect_structured=False))

# 场景 5：首次坏、重试好（验证重试逻辑）
results.append(run_case(
    "场景 5：首次输出坏、重试后正常（验证重试）",
    ["这不是 JSON", json.dumps(VALID_JSON, ensure_ascii=False)]))

print(f"\n{'='*66}")
print(f"总计: {sum(results)}/{len(results)} 通过")
print("=" * 66)
sys.exit(0 if all(results) else 1)
