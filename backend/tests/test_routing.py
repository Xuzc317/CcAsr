"""ASR 后端路由验证（纯函数，不加载模型）。"""
import os
import sys
from pathlib import Path

_here = Path(__file__).resolve()
for _cand in _here.parents:
    if (_cand / "backend" / "__init__.py").exists():
        sys.path.insert(0, str(_cand))
        break

from backend.backends import choose_backend_name, describe_routing, SENSEVOICE_LANGUAGES

pass_n = fail_n = 0


def check(name, got, want):
    global pass_n, fail_n
    if got == want:
        print(f"  PASS  {name}: {got}")
        pass_n += 1
    else:
        print(f"  FAIL  {name}: 期望 {want}, 实际 {got}")
        fail_n += 1


print("=== 1. auto 路由：SenseVoice 覆盖的语种走本地 ===")
for lang in ("zh", "yue", "en", "ja", "ko", "auto"):
    check(f"language={lang!r}", choose_backend_name(lang, routing="auto"), "sensevoice")

print("\n=== 2. auto 路由：超出覆盖范围走 faster-whisper ===")
for lang in ("fr", "de", "es", "ru", "ar", "th", "vi", "nan"):
    check(f"language={lang!r}", choose_backend_name(lang, routing="auto"), "whisper")

print("\n=== 3. 强制指定路由（忽略语种）===")
check("whisper + zh", choose_backend_name("zh", routing="whisper"), "whisper")
check("sensevoice + fr", choose_backend_name("fr", routing="sensevoice"), "sensevoice")
check("doubao + en", choose_backend_name("en", routing="doubao"), "doubao")

print("\n=== 4. 环境变量驱动的路由 ===")
for env_val, want in [
    ("auto", "sensevoice"),        # zh
    ("whisper", "whisper"),
    ("sensevoice", "sensevoice"),
    ("bogus", "sensevoice"),       # 非法值回退 auto
]:
    os.environ["CCASR_ASR_ROUTING"] = env_val
    check(f"CCASR_ASR_ROUTING={env_val!r}", choose_backend_name("zh"), want)

print("\n=== 5. 兼容旧变量 CCASR_BACKEND ===")
os.environ.pop("CCASR_ASR_ROUTING", None)
for env_val, lang, want in [
    ("doubao", "zh", "doubao"),
    ("whisper", "zh", "whisper"),
    ("sensevoice", "zh", "sensevoice"),
]:
    os.environ["CCASR_BACKEND"] = env_val
    check(f"CCASR_BACKEND={env_val!r}", choose_backend_name(lang), want)
os.environ.pop("CCASR_BACKEND", None)

print("\n=== 6. 优先级：ASR_ROUTING 覆盖 BACKEND ===")
os.environ["CCASR_BACKEND"] = "doubao"
os.environ["CCASR_ASR_ROUTING"] = "whisper"
check("ROUTING=whisper > BACKEND=doubao", choose_backend_name("zh"), "whisper")
os.environ.pop("CCASR_ASR_ROUTING", None)
os.environ.pop("CCASR_BACKEND", None)

print("\n=== 7. 大小写与空白容错 ===")
check("' ZH '", choose_backend_name(" ZH ", routing="auto"), "sensevoice")
check("'Whisper'", choose_backend_name("zh", routing="Whisper"), "whisper")

print("\n=== 8. describe_routing ===")
info = describe_routing()
print(f"  {info}")
check("含 mode", "mode" in info, True)
check("列出 SenseVoice 语种", set(info["sensevoice_languages"]) == SENSEVOICE_LANGUAGES, True)

print(f"\n{'='*56}\n路由验证: {pass_n} 通过, {fail_n} 失败\n{'='*56}")
sys.exit(0 if fail_n == 0 else 1)
