# 品牌与首页配图

[项目首页](../../README.md) · [仓库展示](../GITHUB.md)

## 首页素材

| 文件 | 用途 |
| :--- | :--- |
| `readme-cover.svg` | README 品牌封面；可直接编辑的矢量源文件 |
| `social-preview.png` | 1280 × 640 的 GitHub 分享预览图 |
| `readme-summary.png` | 当前应用的结构化纪要界面，使用虚构会议数据 |
| `readme-transcript.png` | 当前应用的合并转录界面，使用同一份虚构会议数据 |

封面沿用 [现有 Logo](../design/logo.svg) 和纸面工作台配色。封面右侧是产品概念示意；两张界面配图则由实际前端渲染，没有改动应用样式。

## 重现示例界面

先在 `app/` 中执行 `npm ci` 和 `npm run build`。然后从仓库根目录运行：

```bash
node app/scripts/docs-demo.mjs
```

打开 [示例会议](http://127.0.0.1:8765/meeting/demo-review)，分别在「会议纪要」和「合并转录」中截图。截图可按阅读位置滚动，让标题与主要内容完整呈现。

该服务只监听本机 8765 端口，提供虚构的产品评审数据和已构建的真实前端。它不访问会议存储、不运行 ASR、不调用 LLM，写入请求返回 405。音频回放和导出等接口不在此展示服务中实现；示例数据不用于说明真实识别准确率。结束后按 Ctrl+C 停止。

## 既有截图与录屏

`ui-*.png` 和 `demo-evidence-jump.gif` 保留为历史界面资料。重新截取已有会议时，在 `app/` 中运行：

```bash
npm run shots
```

需已构建前端、后端在 8000 端口运行，且有已生成纪要的会议。脚本是 `app/scripts/capture-ui-shots.mjs`，原始输出位于 `.workbuddy/readme-shots/`，不会自动覆盖本目录。

该脚本会临时修改并还原说话人显示名，但不会清理会议名或正文里的信息。用于仓库展示时，应先确认素材内容适合分享。

录屏抓帧脚本为 `app/scripts/capture-demo-frames.mjs`；生成 GIF 另需 ffmpeg。当前首页不依赖该录屏。
