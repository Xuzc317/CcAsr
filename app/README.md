# CcAsr 前端

[项目首页](../README.md) · [安装指南](../INSTALL.md) · [设计规范](../docs/design/CcAsr-UI-Redesign.html)

会议录音工作台的 React 客户端，包括会议列表、结构化纪要、合并转录编辑器与录音队列。

## 开发

推荐 Node.js 22.12+，在本目录执行：

```bash
npm ci
npm run dev
```

先在仓库根目录运行 `uv run python run_server.py`。访问 [localhost:5173](http://localhost:5173)，Vite 将 `/api` 转发至后端 8000 端口。

## 常用命令

| 命令 | 用途 |
| :--- | :--- |
| `npm run dev` | Vite 开发服务 |
| `npm run build` | TypeScript 检查并构建至 `dist/` |
| `npm run lint` | ESLint |
| `npm run test:fe` | 纪要解析、文本转义、编辑状态与配色验证 |
| `npm run test:be` | 跨平台后端套件入口 |
| `npm run preview` | 前端构建预览；没有后端 API 代理 |
| `npm run shots` | 已有会议截图，见 [配图说明](../docs/images/README.md) |

正式构建后，重启后端即可从 8000 端口使用完整功能。依赖由 `package-lock.json` 锁定，统一使用 npm。

## 工程入口

```text
src/components/  会议页面、转录工作区、纪要与共享 UI
src/services/    API 客户端与纪要数据解析
src/styles/      全局样式与设计令牌
src/types/       会议、录音、转录与纪要类型
src/utils/       编辑状态、时间、转义与说话人配色
scripts/         后端测试入口、浏览器验收与截图脚本
tests/           前端验证
```

颜色、间距与字号集中在 `src/styles/global.css`。`MeetingDetailPage` 管理共享草稿和播放器，纪要证据跳转与转录回放共用音频状态。
