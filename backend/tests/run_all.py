"""
一键跑完后端全部测试。

用法：
    .venv\\Scripts\\python.exe backend\\tests\\run_all.py

各套件相互独立；本脚本汇总结果并以非零码退出（便于 CI）。
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PY = sys.executable

SUITES = [
    ("纪要管道（进程内，含降级与重试）", HERE / "test_meeting_summary.py"),
    ("LLM 配置体检", HERE / "test_llm_config_check.py"),
    ("ASR 路由判定", HERE / "test_routing.py"),
    ("纪要全链路（自包含，无需 key）", HERE / "test_summary_e2e_selfcontained.py"),
]


def main() -> int:
    print("=" * 66)
    print("CcAsr 后端测试")
    print("=" * 66)

    results = []
    for name, path in SUITES:
        print(f"\n▶ {name}")
        print(f"  {path.relative_to(ROOT)}")
        try:
            r = subprocess.run([PY, str(path)], cwd=str(ROOT),
                               capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=900)
            tail = [ln for ln in (r.stdout or "").splitlines()
                    if "通过" in ln or "失败" in ln]
            summary = tail[-1].strip() if tail else "(无汇总行)"
            ok = r.returncode == 0
            print(f"  {'✅' if ok else '❌'} {summary}")
            if not ok and r.stdout:
                # 失败时打印末段输出帮助定位
                print("  ---- 输出末尾 ----")
                for ln in r.stdout.splitlines()[-12:]:
                    print(f"  {ln}")
                if r.stderr:
                    for ln in r.stderr.splitlines()[-6:]:
                        print(f"  [stderr] {ln}")
            results.append((name, ok))
        except subprocess.TimeoutExpired:
            print("  ❌ 超时")
            results.append((name, False))

    print("\n" + "=" * 66)
    passed = sum(1 for _, ok in results if ok)
    for name, ok in results:
        print(f"  {'✅' if ok else '❌'} {name}")
    print(f"\n  {passed}/{len(results)} 套件通过")
    print("=" * 66)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
