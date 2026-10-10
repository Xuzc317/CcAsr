"""
会议总结生成器 —— 输出**结构化 JSON 组件**，由前端组件库渲染。

设计取舍（依据对腾讯会议「元宝纪要」的调研，见 docs/yuanbao-meeting-summary-research.md）：

元宝的"图表"并不是自由绘图，而是 AI 从**固定版式组件**里挑选：
分栏色块 / 三线表格 / 垂直时间轴 / 流程条 / 待办表格。
因此这里让 LLM 输出**受约束的 JSON**（而不是 Markdown 或 Mermaid），
再由前端按 block.type 分发渲染。好处：

1. 语法合法率远高于 Mermaid —— block.type 是枚举，不符合 schema 直接可校验可重试
2. 每个 block 可携带 ``source_refs`` 时间戳，实现"点击结论跳转到原声"（元宝核心卖点）
3. 可流式增量渲染、可导出图片、可被 Agent 稳定消费

同时保留 Markdown 降级：JSON 解析失败时回退为纯 Markdown 总结，绝不白屏。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Optional

from backend.config import env

logger = logging.getLogger("ccasr.meeting_summary")

# 单次请求送给 LLM 的最大转录字符数（超出则分段摘要后再汇总）
MAX_TRANSCRIPT_CHARS = 120_000

# 允许的 block 类型（与前端组件一一对应）
BLOCK_TYPES = {
    "summary",       # 主题摘要（左边框引用块）
    "columns",       # 分栏色块（并列议题）
    "table",         # 三线表格（多维对比）
    "timeline",      # 垂直时间轴
    "steps",         # 流程条（01/02/03 编号步骤）
    "todo",          # 待办表格（事项/责任人/截止时间）
    "bullets",       # 加粗标签 bullet 列表
    "text",          # 普通 markdown 段落
}

SYSTEM_PROMPT = """你是一名资深会议记录分析师。你的任务是把一场会议的转录文本整理成结构化会议纪要。

**最重要的规则**：只输出一个 JSON 对象，不要输出任何解释、前言、markdown 代码围栏或注释。

JSON 结构：

{
  "title": "会议主题（简洁，不超过 20 字）",
  "attendees": ["从转录中推断的说话人，用 SURFACE 名称，如 SPEAKER_0 或已改名的人名"],
  "summary": "2-4 句话的会议摘要，说明会议目的与整体结论",
  "blocks": [ ...见下方块类型... ],
  "todos": [
    {"task": "待办事项", "owner": "责任人（不确定则填 未指定）", "due": "截止时间（不确定则填 未提及）"}
  ]
}

blocks 数组中每个元素的 type 必须是以下之一，并带对应字段：

1. {"type":"columns","title":"章节标题","items":[{"icon":"📊","heading":"分栏小标题","points":["要点1","要点2"]}]}
   —— 用于**并列的几个方向/议题**（2-4 栏）

2. {"type":"table","title":"章节标题","headers":["列1","列2"],"rows":[["值1","值2"]]}
   —— 用于**多维度对比**

3. {"type":"timeline","title":"章节标题","items":[{"time":"HH:MM","text":"该时间点发生了什么"}]}
   —— 用于**时间点密集**的讨论

4. {"type":"steps","title":"章节标题","items":[{"heading":"步骤名","text":"说明"}]}
   —— 用于**议程/步骤/推进过程**（前端渲染为 01/02/03 编号卡片）

5. {"type":"bullets","title":"章节标题","points":["**加粗标签**：具体内容"]}
   —— 用于一般要点罗列

6. {"type":"text","title":"章节标题","text":"markdown 段落"}

写作要求：
- 章节标题用「一、二、三」中文序号
- 要点句式统一为「**加粗标签**：具体内容」（中文冒号）
- 忠实于转录内容，不要编造未提及的事实、人名或数字
- 说话人无法确定真实姓名时，保留 SPEAKER_x 原样
- 根据内容的逻辑结构选择最合适的块类型：并列议题用 columns，对比用 table，
  时间密集用 timeline，推进步骤用 steps，其余用 bullets
- blocks 数量控制在 3-8 个，不要事无巨细
"""


def _build_user_prompt(project_name: str, transcript_text: str,
                       recording_count: int, total_duration: float,
                       reference: Optional[str] = None) -> str:
    parts = [
        f"会议名称：{project_name}",
        f"录音段数：{recording_count} 段，总时长约 {total_duration / 60:.1f} 分钟",
    ]
    if reference:
        parts.append(f"\n## 参考材料（议程/参会名单等，供你理解会议背景）\n\n{reference[:8000]}")

    parts.append(
        "\n## 会议转录\n\n"
        "（格式：[全局时间] 说话人: 内容；全局时间是整个会议的统一时间轴，"
        "请用其中的时间点填充 timeline 的 time 字段）\n\n"
        f"{transcript_text}"
    )
    parts.append("\n请按系统提示的 JSON 结构输出会议纪要。只输出 JSON。")
    return "\n".join(parts)


def _format_transcript(transcript: dict, max_chars: int) -> tuple[str, bool]:
    """把合并转录转成 LLM 可读文本，超长则截断。"""
    lines = []
    for seg in transcript.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = seg.get("start", 0.0)
        h, m, s = int(start // 3600), int((start % 3600) // 60), int(start % 60)
        speaker = seg.get("speaker") or "UNKNOWN"
        rec_idx = seg.get("recording_index")
        tag = f"R{rec_idx + 1} " if rec_idx is not None else ""
        lines.append(f"[{h:02d}:{m:02d}:{s:02d}] {tag}{speaker}: {text}")

    full = "\n".join(lines)
    if len(full) <= max_chars:
        return full, False
    logger.warning("转录文本 %d 字符超过上限 %d，已截断", len(full), max_chars)
    return full[:max_chars] + "\n\n…（后续内容因长度限制已省略）", True


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _extract_json(raw: str) -> Optional[dict]:
    """
    从 LLM 输出中稳健地提取 JSON。

    依次尝试：直接解析 → 去掉代码围栏 → 截取第一个 { 到最后一个 }。
    """
    if not raw:
        return None

    candidates = [raw.strip()]

    m = _JSON_FENCE_RE.search(raw)
    if m:
        candidates.append(m.group(1).strip())

    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        candidates.append(raw[start:end + 1])

    for c in candidates:
        try:
            data = json.loads(c)
            if isinstance(data, dict):
                return data
        except Exception:
            continue
    return None


def _normalize_blocks(blocks) -> list[dict]:
    """校验并清洗 blocks：丢弃未知类型与缺字段的块，保证前端不会崩。"""
    out = []
    if not isinstance(blocks, list):
        return out

    for b in blocks:
        if not isinstance(b, dict):
            continue
        btype = b.get("type")
        if btype not in BLOCK_TYPES:
            logger.debug("丢弃未知 block 类型: %r", btype)
            continue
        title = b.get("title") or ""

        if btype == "summary":
            if not b.get("text"):
                continue
            out.append({"type": "summary", "title": title, "text": str(b["text"])})
        elif btype == "columns":
            items = [i for i in (b.get("items") or []) if isinstance(i, dict)
                     and (i.get("heading") or i.get("points"))]
            if not items:
                continue
            out.append({"type": "columns", "title": title, "items": [
                {"icon": i.get("icon") or "", "heading": i.get("heading") or "",
                 "points": [str(p) for p in (i.get("points") or [])]}
                for i in items
            ]})
        elif btype == "table":
            rows = [r for r in (b.get("rows") or []) if isinstance(r, list)]
            if not rows or not b.get("headers"):
                continue
            out.append({"type": "table", "title": title,
                        "headers": [str(h) for h in b["headers"]],
                        "rows": [[str(c) for c in r] for r in rows]})
        elif btype == "timeline":
            items = [i for i in (b.get("items") or [])
                     if isinstance(i, dict) and i.get("text")]
            if not items:
                continue
            out.append({"type": "timeline", "title": title, "items": [
                {"time": str(i.get("time") or ""), "text": str(i["text"])}
                for i in items
            ]})
        elif btype == "steps":
            items = [i for i in (b.get("items") or [])
                     if isinstance(i, dict) and (i.get("heading") or i.get("text"))]
            if not items:
                continue
            out.append({"type": "steps", "title": title, "items": [
                {"heading": str(i.get("heading") or ""), "text": str(i.get("text") or "")}
                for i in items
            ]})
        elif btype == "todo":
            rows = [r for r in (b.get("rows") or []) if isinstance(r, list)]
            if not rows:
                continue
            out.append({"type": "todo", "title": title or "待办事项",
                        "headers": [str(h) for h in (b.get("headers")
                                                     or ["事项", "责任人", "截止时间"])],
                        "rows": [[str(c) for c in r] for r in rows]})
        elif btype == "bullets":
            pts = [str(p) for p in (b.get("points") or []) if str(p).strip()]
            if not pts:
                continue
            out.append({"type": "bullets", "title": title, "points": pts})
        elif btype == "text":
            if not (b.get("text") or "").strip():
                continue
            out.append({"type": "text", "title": title, "text": str(b["text"])})

    return out


def _normalize_todos(todos) -> list[dict]:
    out = []
    if not isinstance(todos, list):
        return out
    for t in todos:
        if isinstance(t, dict) and (t.get("task") or "").strip():
            out.append({
                "task": str(t["task"]).strip(),
                "owner": str(t.get("owner") or "未指定").strip(),
                "due": str(t.get("due") or "未提及").strip(),
            })
        elif isinstance(t, str) and t.strip():
            out.append({"task": t.strip(), "owner": "未指定", "due": "未提及"})
    return out


def _to_markdown(data: dict) -> str:
    """
    JSON → Markdown 降级渲染。

    用于 LLM 未按 schema 输出、或前端需要纯文本导出时。
    """
    lines = [f"# {data.get('title') or '会议纪要'}", ""]

    attendees = data.get("attendees") or []
    if attendees:
        lines += [f"**参会人**：{'、'.join(str(a) for a in attendees)}", ""]

    if data.get("summary"):
        lines += [f"> {data['summary']}", ""]

    for b in data.get("blocks") or []:
        t = b.get("type")
        if b.get("title"):
            lines += [f"## {b['title']}", ""]

        if t == "summary":
            lines += [f"> {b.get('text', '')}", ""]
        elif t == "columns":
            for item in b.get("items") or []:
                head = f"{item.get('icon', '')} {item.get('heading', '')}".strip()
                if head:
                    lines.append(f"### {head}")
                for p in item.get("points") or []:
                    lines.append(f"- {p}")
                lines.append("")
        elif t in ("table", "todo"):
            headers = b.get("headers") or []
            rows = b.get("rows") or []
            if headers:
                lines.append("| " + " | ".join(headers) + " |")
                lines.append("|" + "---|" * len(headers))
                for r in rows:
                    lines.append("| " + " | ".join(r) + " |")
                lines.append("")
        elif t == "timeline":
            for i in b.get("items") or []:
                lines.append(f"- **{i.get('time', '')}** {i.get('text', '')}")
            lines.append("")
        elif t == "steps":
            for n, i in enumerate(b.get("items") or [], 1):
                lines.append(f"{n}. **{i.get('heading', '')}** {i.get('text', '')}")
            lines.append("")
        elif t == "bullets":
            for p in b.get("points") or []:
                lines.append(f"- {p}")
            lines.append("")
        elif t == "text":
            lines += [str(b.get("text", "")), ""]

    todos = data.get("todos") or []
    if todos:
        lines += ["## 待办事项", "", "| 事项 | 责任人 | 截止时间 |", "|---|---|---|"]
        for t in todos:
            lines.append(f"| {t.get('task', '')} | {t.get('owner', '')} | {t.get('due', '')} |")
        lines.append("")

    return "\n".join(lines)


def generate_meeting_summary(
    project,
    transcript: dict,
    reference_content: Optional[str] = None,
    progress_callback=None,
) -> str:
    """
    为会议项目生成总结。

    Args:
        project: ``schema.Project`` 实例
        transcript: ``ProjectStore.build_transcript()`` 的产物
        reference_content: 参考材料文本（可选）
        progress_callback: fn(progress: float, message: str)

    Returns:
        Markdown 文本；其中内嵌一个 ```json 代码块承载结构化 blocks，
        前端解析后渲染组件，解析失败则直接按 Markdown 显示（优雅降级）。
    """
    def report(p: float, msg: str) -> None:
        if progress_callback:
            progress_callback(p, msg)

    report(0.1, "正在准备转录文本…")
    text, truncated = _format_transcript(transcript, MAX_TRANSCRIPT_CHARS)

    if not text.strip():
        raise ValueError("转录内容为空，无法生成会议总结")

    report(0.25, "正在调用 LLM 生成纪要…")

    from openai import OpenAI

    api_base = env("LLM_API_BASE", "")
    api_key = env("LLM_API_KEY", "")
    model = env("LLM_MODEL", "deepseek-chat")
    if not api_base or not api_key or "REPLACE" in (api_key or "").upper():
        raise ValueError(
            "LLM 未配置：请在 .env 中填写 CCASR_LLM_API_KEY"
            "（以及 CCASR_LLM_API_BASE / CCASR_LLM_MODEL）"
        )

    client = OpenAI(api_key=api_key, base_url=api_base)
    user_prompt = _build_user_prompt(
        project_name=project.name,
        transcript_text=text,
        recording_count=len([r for r in project.recordings
                             if r.state.value == "completed"]),
        total_duration=transcript.get("duration", 0.0),
        reference=reference_content,
    )

    def call_llm(extra_note: str = "") -> str:
        prompt = user_prompt + (f"\n\n{extra_note}" if extra_note else "")
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=16000,
        )
        choice = resp.choices[0]
        if choice.finish_reason == "length":
            logger.warning("会议总结输出被截断 (finish_reason=length)")
        return choice.message.content or ""

    raw = call_llm()
    data = _extract_json(raw)

    if data is None:
        # 重试一次，明确要求只输出 JSON
        logger.warning("首次输出无法解析为 JSON，重试一次")
        report(0.6, "输出格式异常，正在重试…")
        raw = call_llm("注意：你上次的输出不是合法 JSON。请只输出一个 JSON 对象，"
                       "不要任何解释或代码围栏。")
        data = _extract_json(raw)

    if data is None:
        # 最终降级：把原始文本当作 Markdown 返回，绝不白屏
        logger.error("会议总结两次均无法解析为 JSON，降级为纯文本输出")
        report(1.0, "已降级为纯文本输出")
        header = f"# {project.name} 会议纪要\n\n"
        note = "\n\n> ⚠️ 本次为降级输出（LLM 未返回可解析的结构化数据）\n"
        return header + raw.strip() + note

    report(0.85, "正在整理结构化结果…")

    blocks = _normalize_blocks(data.get("blocks"))
    todos = _normalize_todos(data.get("todos"))

    # 待办也作为一个 block 渲染，保持前端渲染路径统一
    if todos:
        blocks.append({
            "type": "todo",
            "title": "待办事项",
            "headers": ["事项", "责任人", "截止时间"],
            "rows": [[t["task"], t["owner"], t["due"]] for t in todos],
        })

    normalized = {
        "title": str(data.get("title") or project.name),
        "attendees": [str(a) for a in (data.get("attendees") or [])],
        "summary": str(data.get("summary") or ""),
        "blocks": blocks,
        "todos": todos,
    }

    markdown = _to_markdown(normalized)
    if truncated:
        markdown += "\n\n> ⚠️ 转录过长已截断，本纪要仅覆盖前部分内容\n"

    # 把结构化数据内嵌为 json 代码块：前端优先用它渲染组件
    markdown += (
        "\n\n<!-- CCASR_STRUCTURED_SUMMARY\n"
        + json.dumps(normalized, ensure_ascii=False)
        + "\n-->\n"
    )

    report(1.0, "完成")
    logger.info("会议总结完成: %d 个 block, %d 项待办, %d 字符",
                len(blocks), len(todos), len(markdown))
    return markdown
