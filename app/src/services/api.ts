import type { Task, TranscriptionResult, Segment, SummarizePreset, SummarizeJob } from '../types';

export const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }
  return response.json();
}

/** 后端 TaskStatus.to_dict() 字段 → 前端 Task 类型 */
function mapTask(raw: Record<string, unknown>): Task {
  return {
    id: raw.task_id as string,
    filename: raw.filename as string,
    status: raw.state as Task['status'],
    progress: raw.progress as number,
    createdAt: raw.created_at as string,
    completedAt: (raw.completed_at as string) ?? null,
  };
}

/** 后端 Segment → 前端 Segment（添加 id + isModified） */
function mapSegment(raw: Record<string, unknown>, index: number): Segment {
  return {
    id: (raw.id as string) || `seg-${index}`,
    speaker: (raw.speaker as string) || 'SPEAKER_0',
    start: (raw.start as number) || 0,
    end: (raw.end as number) || 0,
    text: (raw.text as string) || '',
    rawText: (raw.raw_text as string) || '',
    emotion: (raw.emotion as string) || 'UNKNOWN',
    language: (raw.language as string) || 'unknown',
    events: (raw.events as string[]) || [],
    isModified: false,
  };
}

/** 后端 TranscriptionResult → 前端 TranscriptionResult */
function mapResult(raw: Record<string, unknown>): TranscriptionResult {
  const rawSegments = (raw.segments as Record<string, unknown>[]) || [];
  const segments = rawSegments.map((s, i) => mapSegment(s, i));

  // 从 segments 构建 speakerMap（首次出现的 speaker ID 映射为自身）
  const speakerMap: Record<string, string> = {};
  for (const seg of segments) {
    if (!(seg.speaker in speakerMap)) {
      speakerMap[seg.speaker] = seg.speaker;
    }
  }

  return {
    audioFile: (raw.audio_file as string) || '',
    duration: (raw.duration as number) || 0,
    numSpeakers: (raw.num_speakers as number) || 0,
    segments,
    peaks: (raw.peaks as number[]) || [],
    speakerMap,
  };
}

export async function uploadAudio(file: File, language: string = 'zh'): Promise<Task> {
  const formData = new FormData();
  formData.append('file', file);

  const url = new URL(`${API_BASE}/tasks`, window.location.origin);
  url.searchParams.set('language', language);

  const raw = await request<Record<string, unknown>>(url.toString(), {
    method: 'POST',
    body: formData,
  });
  return mapTask(raw);
}

export async function getTasks(): Promise<Task[]> {
  const rawList = await request<Record<string, unknown>[]>(`${API_BASE}/tasks`);
  return rawList.map(mapTask);
}

export async function getTask(taskId: string): Promise<Task> {
  const raw = await request<Record<string, unknown>>(`${API_BASE}/tasks/${taskId}`);
  return mapTask(raw);
}

export async function getTaskResult(taskId: string): Promise<TranscriptionResult> {
  const raw = await request<Record<string, unknown>>(`${API_BASE}/tasks/${taskId}/result`);
  return mapResult(raw);
}

// ── AI 总结 API ──────────────────────────────────────────────

export async function getSummarizePresets(): Promise<SummarizePreset[]> {
  return await request<SummarizePreset[]>(`${API_BASE}/summarize/presets`);
}

export async function createSummarize(
  taskId: string,
  preset: string,
  referenceFile: File | null,
  includeIntro: boolean = true,
): Promise<SummarizeJob> {
  const formData = new FormData();
  formData.append('preset', preset);
  formData.append('include_intro', String(includeIntro));
  if (referenceFile) {
    formData.append('reference', referenceFile);
  }

  const response = await fetch(`${API_BASE}/tasks/${taskId}/summarize`, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }
  return response.json();
}

export async function getSummarizeStatus(taskId: string): Promise<SummarizeJob> {
  return await request<SummarizeJob>(`${API_BASE}/tasks/${taskId}/summarize`);
}

export async function getSummarizeResult(taskId: string): Promise<{ summary: string; filename: string }> {
  return await request<{ summary: string; filename: string }>(`${API_BASE}/tasks/${taskId}/summarize/result`);
}
