"""
LLM 连通性自检 —— 填好 key 后跑这个，30 秒确认配置能用。

只做**一次最小调用**（几十个 token），不会打印 key，也不会把 key 写进任何文件。

用法：
    .venv\\Scripts\\python.exe backend\\tests\\check_llm_live.py
"""
import sys
import time
from pathlib import Path

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_c))
        break

from dotenv import load_dotenv

load_dotenv(override=True)

from backend.config import env                      # noqa: E402
from backend.meeting_summary import check_llm_config  # noqa: E402

print("=" * 62)
print("LLM 连通性自检")
print("=" * 62)

cfg = check_llm_config()
print(f"  API_BASE : {cfg['api_base'] or '(未设置)'}")
print(f"  MODEL    : {cfg['model']}")
print(f"  KEY      : {'已设置' if cfg['key_set'] else '未设置/占位符'}")

if cfg["problems"]:
    print("\n  ❌ 配置有问题，先修好再测：")
    for p in cfg["problems"]:
        print(f"     - {p}")
    print("\n  修改 .env 后重跑本脚本。")
    sys.exit(1)

if cfg["warnings"]:
    print("\n  ⚠ 警告（不一定致命，但建议确认）：")
    for w in cfg["warnings"]:
        print(f"     - {w}")

print("\n  正在发起一次最小请求…")
t0 = time.time()
try:
    from openai import OpenAI
    client = OpenAI(api_key=env("LLM_API_KEY", ""), base_url=env("LLM_API_BASE", ""))
    resp = client.chat.completions.create(
        model=env("LLM_MODEL", "deepseek-chat") or "deepseek-chat",
        messages=[{"role": "user", "content": "只回复两个字：正常"}],
        max_tokens=16,
        temperature=0,
    )
    text = (resp.choices[0].message.content or "").strip()
    print(f"  ✅ 调用成功（{time.time()-t0:.1f}s）")
    print(f"     模型回复: {text!r}")
    if getattr(resp, "usage", None):
        u = resp.usage
        print(f"     token 用量: prompt={u.prompt_tokens} completion={u.completion_tokens}")
    print("\n  配置可用，可以生成会议纪要了。")
    print("  提示：打开已有会议 → 纪要 Tab → 点「↻ 重新生成」，无需重跑转录。")
    sys.exit(0)
except Exception as e:
    print(f"  ❌ 调用失败（{time.time()-t0:.1f}s）")
    print(f"     {type(e).__name__}: {str(e)[:400]}")
    print("\n  排查方向：")
    print("   - key 是否正确 / 是否已过期 / 是否欠费")
    print("   - 模型名是否存在（DeepSeek 是 deepseek-chat 或 deepseek-reasoner）")
    print("   - 网络或代理是否可达该 API 地址")
    sys.exit(1)
