"""
假 LLM 客户端 —— 仅供测试使用，**只有在 CCASR_LLM_FAKE=1 时才会被启用**。

用途：在没有真实 API key 的情况下，验证"纪要自动生成 → 内嵌结构化数据 →
HTTP 响应 → 前端解析"这条完整链路的正确性。

返回内容**故意包含脏数据**（非法 block 类型、缺字段的块、字符串形式的待办），
用来验证后端清洗逻辑真的生效，而不是只测了happy path。
"""

from __future__ import annotations

import json

# 一份具备全部版式组件、同时混入脏数据的"LLM 输出"
FAKE_SUMMARY_JSON = {
    "title": "交接会议：文档与网站",
    "attendees": ["SPEAKER_0", "SPEAKER_1"],
    "summary": "本次交接覆盖文档整理与网站改版两条线，确认了各自的负责人与时间节点。",
    "blocks": [
        {"type": "bullets", "title": "一、核心结论",
         "points": ["**文档线**：由 SPEAKER_0 主责，本周内完成目录梳理",
                    "**网站线**：由 SPEAKER_1 主责，下周评审设计方案"]},
        {"type": "columns", "title": "二、两条工作线", "items": [
            {"icon": "📄", "heading": "文档整理",
             "points": ["建立统一目录结构", "补齐历史版本说明"]},
            {"icon": "🌐", "heading": "网站改版",
             "points": ["确定信息架构", "补充移动端适配"]},
        ]},
        {"type": "timeline", "title": "三、讨论脉络", "items": [
            {"time": "00:00", "text": "开场，确认本次交接范围"},
            {"time": "00:31", "text": "讨论文档目录如何组织"},
            {"time": "00:62", "text": "转到网站改版排期"},
        ]},
        {"type": "steps", "title": "四、推进步骤", "items": [
            {"heading": "梳理现状", "text": "各自列出待办清单"},
            {"heading": "交叉确认", "text": "双方对齐接口人"},
            {"heading": "落地执行", "text": "按排期推进并同步进度"},
        ]},
        {"type": "table", "title": "五、分工对照",
         "headers": ["工作线", "负责人", "时间节点"],
         "rows": [["文档整理", "SPEAKER_0", "本周内"],
                  ["网站改版", "SPEAKER_1", "下周评审"]]},
        # ↓↓↓ 以下为故意混入的脏数据，验证清洗逻辑 ↓↓↓
        {"type": "flowchart", "title": "不该出现的非法类型", "nodes": ["a", "b"]},
        {"type": "timeline", "title": "缺 items 的块"},
        {"type": "columns", "title": "空 items 的块", "items": []},
        {"type": "bullets", "title": "空 points 的块", "points": []},
    ],
    "todos": [
        {"task": "完成文档目录梳理", "owner": "SPEAKER_0", "due": "本周五"},
        {"task": "输出网站设计方案", "owner": "SPEAKER_1", "due": "下周一"},
        "缺字段的字符串待办",          # 应被归一化为 未指定/未提及
        {"nope": "完全无效的条目"},     # 应被丢弃
    ],
}


class _FakeMessage:
    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeMessage(content)
        self.finish_reason = "stop"


class _FakeResponse:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def create(self, **kwargs):
        # 用 ensure_ascii=False 保持中文，贴近真实 API 行为
        return _FakeResponse(json.dumps(FAKE_SUMMARY_JSON, ensure_ascii=False))


class FakeOpenAI:
    """冒充 openai.OpenAI：只需支持 chat.completions.create"""

    def __init__(self, *args, **kwargs):
        self.chat = type("_Chat", (), {"completions": _FakeCompletions()})()


def is_fake_mode() -> bool:
    """当前是否处于假 LLM 模式（读环境变量，无副作用）。"""
    from backend.config import env
    return (env("LLM_FAKE", "") or "").strip().lower() in ("1", "true", "yes")


def enable_if_requested() -> bool:
    """
    若设置了 CCASR_LLM_FAKE=1，则把 meeting_summary 的 LLM 客户端换成假实现。

    注意：uvicorn 的热重载会**重新导入** meeting_summary 模块，
    模块级的 ``_llm_client_factory`` 会被重置回 OpenAI。
    因此本函数在应用启动时与每次生成纪要前都会被调用（幂等）。
    生产环境未设置该变量，恒为 no-op。

    Returns:
        当前是否处于假模式
    """
    if not is_fake_mode():
        return False

    import backend.meeting_summary as ms
    if ms._llm_client_factory is not FakeOpenAI:   # 幂等，避免重复打日志
        ms.set_llm_client_factory(FakeOpenAI)
    return True
