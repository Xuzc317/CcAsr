import type { MergedSegment, MergedTranscript } from '../types';

/**
 * 转录编辑的草稿状态。
 *
 * 为什么要提到页面层用 reducer 管理：
 *   - **草稿不能在切 Tab 时丢**：TranscriptWorkspace 是条件挂载的，
 *     卸载即丢 state。提到父层后，切 Tab 回来草稿原样还在。
 *   - **保存后必须同步基线**：此前保存成功只更新了工作区内部，
 *     父层的 transcript 还是旧的，切 Tab 重新挂载就回显旧值（QA 报告 R2-01）。
 *   - **改动明细要一致**：底栏的「待保存 N 处」必须和后端返回的计数口径相同
 *     （此前底栏算 4、后端只报 2，见 R2-04）。
 */

/** 三类改动明细 —— 前后端共用同一口径 */
export interface EditChanges {
  /** 改过文字的段数 */
  text: number;
  /** 改过归属的段数 */
  speaker: number;
  /** 改过显示名的说话人数 */
  renamed: number;
}

export const EMPTY_CHANGES: EditChanges = { text: 0, speaker: 0, renamed: 0 };

export const totalChanges = (c: EditChanges): number => c.text + c.speaker + c.renamed;

/** 一次批量改判的记录，用于「撤销本次批量操作」 */
export interface BatchRecord {
  from: string;
  to: string;
  /** 按 segments 顺序记录每段原 speaker；null 表示该段未被本次操作影响 */
  previous: (string | null)[];
}

export interface EditState {
  /** 保存基线（服务端已知状态） */
  baseline: MergedSegment[];
  baselineNames: Record<string, string>;
  /** 草稿（界面正在编辑的状态） */
  segments: MergedSegment[];
  names: Record<string, string>;
  /** 服务端修订号，保存时回传用于冲突检测 */
  revision: number;
  /** 最近一次批量改判（仅保留一次，够用且语义清晰） */
  lastBatch: BatchRecord | null;
  /** 为 true 表示这些内容来自服务端、尚未被本地编辑过 */
  pristine: boolean;
}

export const emptyEditState: EditState = {
  baseline: [],
  baselineNames: {},
  segments: [],
  names: {},
  revision: 0,
  lastBatch: null,
  pristine: true,
};

export type EditAction =
  | { type: 'load'; transcript: MergedTranscript }
  | { type: 'text'; id: string; text: string }
  | { type: 'reassignOne'; id: string; speaker: string }
  | { type: 'rename'; speaker: string; name: string }
  | { type: 'reassignAll'; from: string; to: string }
  | { type: 'undoBatch' }
  | { type: 'undoAll' }
  | { type: 'saved'; transcript: MergedTranscript };

export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case 'load': {
      const t = action.transcript;
      return {
        baseline: t.segments,
        baselineNames: t.speaker_map || {},
        segments: t.segments,
        names: t.speaker_map || {},
        revision: t.revision ?? 0,
        lastBatch: null,
        pristine: true,
      };
    }

    case 'text':
      return {
        ...state,
        pristine: false,
        segments: state.segments.map((s) =>
          s.id === action.id ? { ...s, text: action.text } : s),
      };

    case 'reassignOne':
      return {
        ...state,
        pristine: false,
        // 单句改判会让上一次批量操作的撤销变得不准确，清掉
        lastBatch: null,
        segments: state.segments.map((s) =>
          s.id === action.id ? { ...s, speaker: action.speaker } : s),
      };

    case 'rename':
      return {
        ...state,
        pristine: false,
        names: { ...state.names, [action.speaker]: action.name },
      };

    case 'reassignAll': {
      const { from, to } = action;
      if (from === to) return state;
      const previous: (string | null)[] = [];
      let touched = 0;
      const segments = state.segments.map((s) => {
        if (s.speaker !== from) {
          previous.push(null);       // 未被本次操作影响 -> 撤销时跳过
          return s;
        }
        previous.push(s.speaker);    // 记录原值
        touched += 1;
        return { ...s, speaker: to };
      });
      if (touched === 0) return state;   // 没有可改的，保持原状（含 lastBatch）
      return {
        ...state,
        pristine: false,
        segments,
        lastBatch: { from, to, previous },
      };
    }

    case 'undoBatch': {
      const b = state.lastBatch;
      if (!b) return state;
      return {
        ...state,
        segments: state.segments.map((s, i) =>
          b.previous[i] === null ? s : { ...s, speaker: b.previous[i] as string }),
        lastBatch: null,
      };
    }

    case 'undoAll':
      return {
        ...state,
        segments: state.baseline,
        names: state.baselineNames,
        lastBatch: null,
        pristine: true,
      };

    case 'saved': {
      const t = action.transcript;
      return {
        // 以服务端返回为准刷新基线，避免本地/服务端不一致导致"看起来还有改动"
        baseline: t.segments,
        baselineNames: t.speaker_map || {},
        segments: t.segments,
        names: t.speaker_map || {},
        revision: t.revision ?? state.revision,
        lastBatch: null,
        pristine: true,
      };
    }

    default:
      return state;
  }
}

/** 计算三类改动明细（与后端口径一致） */
export function computeChanges(state: EditState): EditChanges {
  const baseById = new Map<string, MergedSegment>();
  state.baseline.forEach((s) => baseById.set(s.id, s));

  let text = 0;
  let speaker = 0;
  for (const s of state.segments) {
    const b = baseById.get(s.id);
    if (!b) continue;
    if (s.text !== b.text) text += 1;
    if (s.speaker !== b.speaker) speaker += 1;
  }

  const keys = new Set([
    ...Object.keys(state.baselineNames),
    ...Object.keys(state.names),
  ]);
  let renamed = 0;
  keys.forEach((k) => {
    if ((state.baselineNames[k] || '') !== (state.names[k] || '')) renamed += 1;
  });

  return { text, speaker, renamed };
}

/** 只把**差异**打包发给后端，避免每次保存都上传整份转录 */
export function buildPatchPayload(state: EditState): {
  segments: { id: string; text?: string; speaker?: string }[];
  speaker_map: Record<string, string>;
} {
  const baseById = new Map<string, MergedSegment>();
  state.baseline.forEach((s) => baseById.set(s.id, s));

  const segments: { id: string; text?: string; speaker?: string }[] = [];
  for (const s of state.segments) {
    const b = baseById.get(s.id);
    if (!b) continue;
    const patch: { id: string; text?: string; speaker?: string } = { id: s.id };
    if (s.text !== b.text) patch.text = s.text;
    if (s.speaker !== b.speaker) patch.speaker = s.speaker;
    if (patch.text !== undefined || patch.speaker !== undefined) segments.push(patch);
  }

  return { segments, speaker_map: state.names };
}

/** 当前出现过的说话人，按发言段数降序 */
export function speakerOrder(segments: MergedSegment[]): string[] {
  const count = new Map<string, number>();
  segments.forEach((s) => count.set(s.speaker, (count.get(s.speaker) || 0) + 1));
  return Array.from(count.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([spk]) => spk);
}
