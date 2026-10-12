// ── 会议项目制类型定义 ──────────────────────────────────────
// 与 backend/schema.py 的 Project / Recording / ProjectState 对应

export type TaskState = 'pending' | 'processing' | 'completed' | 'failed';

export type ProjectState =
  | 'draft'
  | 'transcribing'
  | 'summarizing'
  | 'completed'
  | 'failed';

/** 项目内的一段录音 */
export interface Recording {
  recording_id: string;
  project_id: string;
  filename: string;
  order: number;
  state: TaskState;
  progress: number;
  duration: number;
  language: string;
  error?: string;
  created_at?: string;
  completed_at?: string;
}

/** 会议项目（文档），如「xx 会议」 */
export interface Project {
  project_id: string;
  name: string;
  state: ProjectState;
  progress: number;
  recording_count: number;
  done_count: number;
  failed_count: number;
  total_duration: number;
  summary_state: TaskState;
  summary_progress: number;
  has_summary: boolean;
  has_reference: boolean;
  /** 转录在纪要生成之后被改过 —— 提示「纪要待更新」 */
  summary_stale?: boolean;
  reference_name?: string;
  summary_error?: string;
  created_at?: string;
  updated_at?: string;
  summary_completed_at?: string;
  recordings?: Recording[];
}

/** 合并转录中的一个片段（全局时间轴） */
export interface MergedSegment {
  id: string;
  start: number;          // 全局时间（秒）
  end: number;
  local_start: number;    // 该录音内的本地时间，用于定位音频
  local_end: number;
  text: string;
  raw_text?: string;
  speaker: string;
  emotion?: string;
  language?: string;
  events?: string[];
  recording_id: string;
  recording_index: number;  // 第几段录音（0 基）
}

/** 合并文档中每段录音的元信息 */
export interface RecordingMeta {
  recording_id: string;
  filename: string;
  order: number;
  duration: number;
  offset: number;         // 该录音在全局时间轴上的起点
  segment_count: number;
  num_speakers: number;
  language: string;
}

/** 合并后的会议转录文档 */
export interface MergedTranscript {
  project_id: string;
  name: string;
  duration: number;
  num_speakers: number;
  segments: MergedSegment[];
  recordings: RecordingMeta[];
  speaker_map?: Record<string, string>;
  /** 服务端修订号：每次保存 +1，用于检测"旧页面覆盖新修改" */
  revision?: number;
  merged: true;
}

/** 会议纪要状态 */
export interface SummaryState {
  project_id: string;
  state: TaskState;
  progress: number;
  error?: string;
  summary: string | null;
  has_summary: boolean;
}

// ── 会议纪要的结构化组件（参考腾讯会议元宝的固定版式组件）──

export interface ColumnItem {
  icon?: string;
  heading: string;
  points: string[];
}

export interface TimelineItem {
  time: string;
  text: string;
}

export interface StepItem {
  heading: string;
  text: string;
}

/** 纪要中的一条原声证据（指回转录片段） */
export interface SourceRef {
  start: number;              // 全局时间（秒）
  end?: number;
  recording_id?: string;
  recording_index?: number;
  quote?: string;             // 对应转录文本片段
}

export type SummaryBlock =
  | { type: 'summary'; title?: string; text: string; source_refs?: SourceRef[] }
  | { type: 'columns'; title?: string; items: ColumnItem[]; source_refs?: SourceRef[] }
  | { type: 'table'; title?: string; headers: string[]; rows: string[][]; source_refs?: SourceRef[] }
  | { type: 'timeline'; title?: string; items: TimelineItem[]; source_refs?: SourceRef[] }
  | { type: 'steps'; title?: string; items: StepItem[]; source_refs?: SourceRef[] }
  | { type: 'todo'; title?: string; headers: string[]; rows: string[][]; source_refs?: SourceRef[] }
  | { type: 'bullets'; title?: string; points: string[]; source_refs?: SourceRef[] }
  | { type: 'text'; title?: string; text: string; source_refs?: SourceRef[] };

export interface StructuredSummary {
  title: string;
  attendees: string[];
  summary: string;
  blocks: SummaryBlock[];
  todos: { task: string; owner: string; due: string }[];
}
