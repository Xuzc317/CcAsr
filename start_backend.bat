@echo off
REM CcAsr 后端启动脚本 (Windows)
cd /d %~dp0

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境: .venv\Scripts\python.exe
    echo 请先执行: uv sync
    pause
    exit /b 1
)

.venv\Scripts\python.exe run_server.py %*
