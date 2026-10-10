"""
测试专用启动器：以假 LLM 客户端启动后端（**不开热重载**）。

为什么要单独一个启动器：
  - uvicorn 的 StatReload 会重新导入 backend.meeting_summary，
    把模块级的 LLM 客户端工厂重置回真实 OpenAI，导致注入失效
  - 因此测试时关闭 reload，避免这个干扰

用法：
    .venv\\Scripts\\python.exe backend\\tests\\serve_fake_llm.py
然后用另一个终端跑 backend/tests/test_summary_over_http.py
"""
import os
import sys
from pathlib import Path

# 项目根加入 sys.path，保证能 import backend.*
_here = Path(__file__).resolve()
for _c in _here.parents:
    if (_c / "backend" / "__init__.py").exists():
        ROOT = _c
        sys.path.insert(0, str(ROOT))
        break

# 必须在导入 backend.app 之前设置：让 app 启动时就注入假客户端
os.environ["CCASR_LLM_FAKE"] = "1"
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

# 给一份假的 LLM 配置，避免任何"未配置"分支
os.environ.setdefault("CCASR_LLM_API_BASE", "https://fake.local/v1")
os.environ.setdefault("CCASR_LLM_API_KEY", "fake-key-for-test")
os.environ.setdefault("CCASR_LLM_MODEL", "fake-model")

import uvicorn

if __name__ == "__main__":
    print("⚠ 测试模式：假 LLM 客户端已启用，热重载已关闭")
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8000, reload=False)
