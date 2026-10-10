"""LLM 配置体检验证（check_llm_config 是纯函数，不发网络请求）。"""
import os
import sys
from pathlib import Path

_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_c))
        break

# 清掉可能干扰的环境变量，逐例显式设置
for k in ("CCASR_LLM_API_BASE", "CCASR_LLM_API_KEY", "CCASR_LLM_MODEL"):
    os.environ.pop(k, None)

from backend.meeting_summary import check_llm_config  # noqa: E402

pass_n = fail_n = 0


def case(name, envs, want_ok=None, want_problem=None, want_warning=None):
    global pass_n, fail_n
    for k in ("CCASR_LLM_API_BASE", "CCASR_LLM_API_KEY", "CCASR_LLM_MODEL"):
        os.environ.pop(k, None)
    os.environ.update(envs)

    c = check_llm_config()
    ok = True
    detail = []

    if want_ok is not None and c["ok"] != want_ok:
        ok = False
        detail.append(f"ok 期望 {want_ok} 实际 {c['ok']}")
    if want_problem and not any(want_problem in p for p in c["problems"]):
        ok = False
        detail.append(f"problems 未命中 {want_problem!r}: {c['problems']}")
    if want_warning and not any(want_warning in w for w in c["warnings"]):
        ok = False
        detail.append(f"warnings 未命中 {want_warning!r}: {c['warnings']}")

    if ok:
        print(f"  PASS  {name}")
        pass_n += 1
    else:
        print(f"  FAIL  {name} -> {'; '.join(detail)}")
        fail_n += 1


GOOD = {"CCASR_LLM_API_BASE": "https://api.deepseek.com",
        "CCASR_LLM_API_KEY": "sk-realkey1234567890",
        "CCASR_LLM_MODEL": "deepseek-chat"}

print("=== 1. 完整正确配置 → ok ===")
case("DeepSeek + deepseek-chat + 真 key", GOOD, want_ok=True)

print("\n=== 2. 缺失项应被发现 ===")
case("缺 key", {k: v for k, v in GOOD.items() if k != "CCASR_LLM_API_KEY"},
     want_ok=False, want_problem="CCASR_LLM_API_KEY 未设置")
case("缺 base", {k: v for k, v in GOOD.items() if k != "CCASR_LLM_API_BASE"},
     want_ok=False, want_problem="CCASR_LLM_API_BASE 未设置")

print("\n=== 3. 占位符 key 应被发现（真实踩过的坑）===")
case("REPLACE_WITH_... 占位符",
     {**GOOD, "CCASR_LLM_API_KEY": "REPLACE_WITH_YOUR_DEEPSEEK_KEY"},
     want_ok=False, want_problem="仍是占位符")
case("your_api_key_here 占位符",
     {**GOOD, "CCASR_LLM_API_KEY": "your_api_key_here"},
     want_ok=False, want_problem="仍是占位符")

print("\n=== 4. 模型名笔误应给出警告（真实踩过的坑）===")
case("DeepSeek 填 deepseek-flash",
     {**GOOD, "CCASR_LLM_MODEL": "deepseek-flash"},
     want_warning="deepseek-flash")
case("OpenAI 填 gpt-5",
     {"CCASR_LLM_API_BASE": "https://api.openai.com/v1",
      "CCASR_LLM_API_KEY": "sk-realkey1234567890",
      "CCASR_LLM_MODEL": "gpt-5"},
     want_warning="gpt-5")

print("\n=== 5. 合法的非列表模型名不应报警（避免误伤自建/代理）===")
case("自建 base 用任意模型名",
     {"CCASR_LLM_API_BASE": "http://127.0.0.1:11434/v1",
      "CCASR_LLM_API_KEY": "sk-realkey1234567890",
      "CCASR_LLM_MODEL": "qwen2.5:14b"},
     want_ok=True)

print("\n=== 6. 模型名缺失只警告、不阻断 ===")
case("缺 model", {k: v for k, v in GOOD.items() if k != "CCASR_LLM_MODEL"},
     want_ok=True, want_warning="CCASR_LLM_MODEL 未设置")

print("\n=== 7. base 不像 URL 应警告 ===")
case("base 缺协议", {**GOOD, "CCASR_LLM_API_BASE": "api.deepseek.com"},
     want_warning="不像 URL")

print("\n=== 8. 返回结构稳定 ===")
for k in ("CCASR_LLM_API_BASE", "CCASR_LLM_API_KEY", "CCASR_LLM_MODEL"):
    os.environ.pop(k, None)
os.environ.update(GOOD)
c = check_llm_config()
need = {"ok", "problems", "warnings", "api_base", "model", "key_set", "fake"}
missing = need - set(c)
if missing:
    print(f"  FAIL  缺少字段: {missing}")
    fail_n += 1
else:
    print(f"  PASS  字段齐全: {sorted(c)}")
    pass_n += 1

print(f"\n{'='*56}\nLLM 配置体检: {pass_n} 通过, {fail_n} 失败\n{'='*56}")
sys.exit(0 if fail_n == 0 else 1)
