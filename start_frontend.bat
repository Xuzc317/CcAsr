@echo off
REM CcAsr 前端启动脚本 (Windows)
cd /d %~dp0app

where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未在 PATH 中找到 npm，请先安装 Node.js 20+
    echo 下载: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

call npm run dev
