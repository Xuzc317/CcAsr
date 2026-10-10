export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Task {
  id: string;
  filename: string;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  completedAt: string | null;
}

export interface Segment {
  id: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
  rawText: string;
  emotion: string;
  language: string;
  events: string[];
  isModified: boolean;
}

export type SpeakerMap = Record<string, string>;

export interface TranscriptionResult {
  audioFile: string;
  duration: number;
  numSpeakers: number;
  segments: Segment[];
  peaks: number[];
  speakerMap: SpeakerMap;
}

export interface SummarizePreset {
  key: string;
  label: string;
  description: string;
}

export interface SummarizeJob {
  job_id: string;
  task_id: string;
  preset: string;
  state: TaskStatus;
  progress: number;
  has_reference: boolean;
  has_result: boolean;
  error?: string;
  created_at?: string;
  completed_at?: string;
}
