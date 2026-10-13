# API 参考

[项目首页](../README.md) · [使用指南](USAGE.md) · [架构说明](ARCHITECTURE.md)

默认地址 `http://localhost:8000`。启动后可在 [/docs](http://localhost:8000/docs) 查看 Swagger，参数与响应以生成的 OpenAPI 为准。

## 接口索引

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| POST | `/api/projects` | 创建会议，JSON：`{"name":"产品评审会"}` |
| GET | `/api/projects` | 会议列表 |
| GET / PATCH / DELETE | `/api/projects/{id}` | 详情、改名、删除及清理产物 |
| POST | `/api/projects/{id}/recordings` | 多文件上传 |
| POST | `/api/projects/{id}/start` | 启动队列；表单 `retry_failed` 默认 true |
| GET | `/api/projects/{id}/recordings/{rid}/audio` | 原声回放，支持 Range |
| GET | `/api/projects/{id}/recordings/{rid}/transcript` | 单段转录 |
| GET / PATCH | `/api/projects/{id}/transcript` | 合并转录与修订保存 |
| POST | `/api/projects/{id}/transcript/reassign` | 立即保存批量归属调整 |
| GET | `/api/projects/{id}/summary` | 纪要与生成状态 |
| POST | `/api/projects/{id}/summary/regenerate` | 重新生成纪要 |
| POST | `/api/projects/{id}/reference` | 文本参考材料 |
| GET | `/api/projects/{id}/export?fmt=md` | md 纪要、txt / json 转录 |
| GET | `/health` | 设备信息与本地配置检查 |

## 上传录音

Multipart 字段 `files` 可重复；`language` 默认为 zh；`start` 默认为 true。单文件上限 500 MB。

Bash 示例，创建后将 `PROJECT_ID` 替换为返回的 `project_id`：

```bash
curl -X POST http://localhost:8000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"产品评审会"}'

curl -X POST http://localhost:8000/api/projects/PROJECT_ID/recordings \
  -F 'files=@01-开场.m4a' \
  -F 'files=@02-讨论.m4a' \
  -F 'language=zh' \
  -F 'start=true'
```

`start=false` 可先入队再调用 /start。队列运行时追加录音返回 409。

## 保存修订

先 GET /transcript 获取片段 ID 与 revision，再 PATCH：

```json
{
  "revision": 0,
  "segments": [
    {"id": "REPLACE_WITH_SEGMENT_ID", "text": "先完成灰度验证。", "speaker": "SPEAKER_1"}
  ],
  "speaker_map": {
    "SPEAKER_0": "产品同学",
    "SPEAKER_1": "研发同学"
  }
}
```

过期修订返回 409。成功返回更新后的转录、修订号与改动计数，并将已有纪要标记为待更新。

POST /transcript/reassign 接受 `{"from":"SPEAKER_0","to":"SPEAKER_1"}`，直接写入后端。网页批量改判则先进入草稿，再统一保存。

## 参考材料与纪要

文件字段为 `reference`。推荐 UTF-8 文本，接口也尝试 GBK 解码；不解析 PDF、DOCX：

```bash
curl -X POST http://localhost:8000/api/projects/PROJECT_ID/reference \
  -F 'reference=@agenda.md'

curl -X POST http://localhost:8000/api/projects/PROJECT_ID/summary/regenerate
```

GET /summary 返回 state、progress、error、has_summary 与 summary。重新生成不需要重跑转录。

## 导出与健康检查

/export 的 fmt 可选 md、txt、json。返回含 `filename` 和 `content` 的 JSON，不是文件流。md 取已生成纪要，txt / json 取已保存合并转录。

/health 的 llm 字段检查缺失项、占位符和常见配置问题，不发 LLM 请求。真实连通性用 `backend/tests/check_llm_live.py` 验证。
