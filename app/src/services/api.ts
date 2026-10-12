// ── CcAsr API 客户端（会议项目制）────────────────────────────

import type {
  Project, MergedTranscript, SummaryState, StructuredSummary,
} from '../types';

export const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.detail) {
        detail = typeof parsed.detail === 'string'
          ? parsed.detail : JSON.stringify(parsed.detail);
      }
    } catch { /* 非 JSON，按原文显示 */ }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── 项目管理 ─────────────────────────────────────────────────

export async function createProject(name: string): Promise<Project> {
  return request<Project>(`${API_BASE}/projects`, jsonPost({ name }));
}

export async function listProjects(): Promise<Project[]> {
  return request<Project[]>(`${API_BASE}/projects`);
}

export async function getProject(projectId: string): Promise<Project> {
  return request<Project>(`${API_BASE}/projects/${projectId}`);
}

export async function renameProject(projectId: string, name: string): Promise<Project> {
  return request<Project>(`${API_BASE}/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await request<unknown>(`${API_BASE}/projects/${projectId}`, { method: 'DELETE' });
}

// ── 录音上传（支持一次多个）──────────────────────────────────

export interface AddRecordingsResult {
  project: Project;
  added: { recording_id: string; filename: string; order: number }[];
}

export async function addRecordings(
  projectId: string,
  files: File[],
  language: string = 'zh',
  start: boolean = true,
): Promise<AddRecordingsResult> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('language', language);
  form.append('start', String(start));

  return request<AddRecordingsResult>(
    `${API_BASE}/projects/${projectId}/recordings`,
    { method: 'POST', body: form },
  );
}

export async function startQueue(projectId: string): Promise<Project> {
  return request<Project>(`${API_BASE}/projects/${projectId}/start`, { method: 'POST' });
}

// ── 转录文档 ─────────────────────────────────────────────────

export async function getTranscript(projectId: string): Promise<MergedTranscript> {
  return request<MergedTranscript>(`${API_BASE}/projects/${projectId}/transcript`);
}

export async function saveTranscriptEdits(
  projectId: string,
  payload: {
    segments: { id: string; text?: string; speaker?: string }[];
    speaker_map?: Record<string, string>;
    /** 客户端已知的服务端修订号，用于检测"旧页面覆盖新修改" */
    revision?: number;
  },
): Promise<{
  updated: number;
  transcript: MergedTranscript;
  changes?: { text: number; speaker: number; renamed: number };
}> {
  return request<{
    updated: number;
    transcript: MergedTranscript;
    changes?: { text: number; speaker: number; renamed: number };
  }>(
    `${API_BASE}/projects/${projectId}/transcript`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

/**
 * 把某个说话人的**全部**发言改判给另一个说话人。
 *
 * `to` 是新标签时相当于重命名整个说话人；已存在时相当于合并两人。
 * 单独用一个接口是因为长会议有几百段，逐段 PATCH 又慢又可能半改。
 */
export async function reassignSpeaker(
  projectId: string,
  from: string,
  to: string,
): Promise<{ changed: number; transcript: MergedTranscript }> {
  return request<{ changed: number; transcript: MergedTranscript }>(
    `${API_BASE}/projects/${projectId}/transcript/reassign`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    },
  );
}

/** 单段录音的音频 URL（用于回放定位） */
export function recordingAudioUrl(projectId: string, recordingId: string): string {
  return `${API_BASE}/projects/${projectId}/recordings/${recordingId}/audio`;
}

// ── 会议纪要 ─────────────────────────────────────────────────

export async function getSummary(projectId: string): Promise<SummaryState> {
  return request<SummaryState>(`${API_BASE}/projects/${projectId}/summary`);
}

export async function regenerateSummary(projectId: string): Promise<unknown> {
  return request<unknown>(
    `${API_BASE}/projects/${projectId}/summary/regenerate`, { method: 'POST' },
  );
}

export async function uploadReference(projectId: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.append('reference', file);
  return request<unknown>(`${API_BASE}/projects/${projectId}/reference`,
    { method: 'POST', body: form });
}

// ── 导出 ─────────────────────────────────────────────────────

export async function exportProject(
  projectId: string, fmt: 'md' | 'txt' | 'json',
): Promise<{ filename: string; content: string }> {
  return request<{ filename: string; content: string }>(
    `${API_BASE}/projects/${projectId}/export?fmt=${fmt}`,
  );
}

export function downloadText(content: string, filename: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 纪要结构化数据解析 ───────────────────────────────────────

const STRUCT_RE = /<!--\s*CCASR_STRUCTURED_SUMMARY\s*([\s\S]*?)\s*-->/;

/**
 * 从纪要 Markdown 中提取内嵌的结构化 JSON。
 *
 * 后端把结构化 blocks 以 HTML 注释形式内嵌，前端优先用它渲染组件；
 * 解析失败返回 null，调用方回退为 Markdown 渲染（优雅降级）。
 */
export function parseStructuredSummary(markdown: string): StructuredSummary | null {
  const m = STRUCT_RE.exec(markdown || '');
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (data && Array.isArray(data.blocks)) return data as StructuredSummary;
  } catch {
    /* 交给调用方降级 */
  }
  return null;
}

/** 取出纪要正文（去掉内嵌的结构化注释与降级提示） */
export function summaryBodyMarkdown(markdown: string): string {
  return (markdown || '').replace(STRUCT_RE, '').trim();
}
