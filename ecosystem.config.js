// PM2 进程配置 — 请按实际部署路径修改 cwd / interpreter
// 本机（Windows）示例已填入实际路径；Linux/macOS 请替换为对应绝对路径。
const path = require('path');

const ROOT = __dirname;                    // 自动定位到本文件所在目录
const isWin = process.platform === 'win32';

module.exports = {
  apps: [
    {
      name: 'ccasr-backend',
      cwd: ROOT,
      script: 'run_server.py',
      // 虚拟环境解释器：Windows 与 Unix 路径不同
      interpreter: isWin
        ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
        : path.join(ROOT, '.venv', 'bin', 'python'),
      args: '--debug',                  // 不需要详细日志可去掉
      exec_mode: 'fork',                // Python 应用使用 fork 模式
      watch: false,                     // 生产环境建议 false
      max_memory_restart: '4G',         // RSS 超 4G 自动重启（兜底防泄漏）
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        // MPS 显存用完立即归还 OS（仅 macOS 生效）
        PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
      },
    },
    {
      name: 'ccasr-frontend',
      cwd: path.join(ROOT, 'app'),
      script: isWin ? 'npm' : 'pnpm',
      args: 'run dev',                  // 生产环境建议改为 build + 由后端托管 dist
      interpreter: 'none',              // 避免 PM2 误用 node 解释器
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
