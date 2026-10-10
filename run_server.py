#!/usr/bin/env python3
"""CcAsr 启动脚本"""
import os
import sys

# ── 加载 .env (AI 总结功能需要) ──
from dotenv import load_dotenv
load_dotenv()

# ── 性能优化: 必须在 import torch 之前设置 ──
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
# MPS GPU 内存: 用完立即归还 OS（默认行为是缓存不释放）——仅 macOS 有效
if sys.platform == "darwin":
    os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

# ── Debug 模式: python run_server.py --debug ──
if "--debug" in sys.argv:
    os.environ["CCASR_DEBUG"] = "1"
    sys.argv.remove("--debug")

import uvicorn

if __name__ == "__main__":
    # reload_dirs 限定 backend：默认监听项目根目录会扫到 .venv/node_modules，
    # Windows 上文件事件过多会导致热重载防抖失效（代码改了不重启）
    uvicorn.run("backend.app:app", host="0.0.0.0", port=8000,
                reload=True, reload_dirs=["backend"])
