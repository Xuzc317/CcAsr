import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { TranscriptionResult, Segment, SpeakerMap } from '../types';

const MAX_HISTORY = 50;

interface HistoryEntry {
  segments: Segment[];
  speakerMap: SpeakerMap;
}

interface EditorState {
  result: TranscriptionResult | null;
  activeSegmentId: string | null;
  isPlaying: boolean;
  playbackSpeed: number;
  currentTime: number;
  isEditing: boolean;
  speakerMap: SpeakerMap;

  // Undo/redo
  past: HistoryEntry[];
  future: HistoryEntry[];

  setResult: (result: TranscriptionResult) => void;
  setActiveSegment: (id: string | null) => void;
  togglePlay: () => void;
  setSpeed: (speed: number) => void;
  updateTime: (time: number) => void;
  startEditing: () => void;
  stopEditing: () => void;
  updateSegmentText: (id: string, text: string) => void;
  updateSpeakerName: (spkId: string, name: string) => void;
  mergeSegments: (ids: string[]) => void;
  splitSegment: (id: string, splitTime: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

/** Snapshot current editing state into a history entry. */
function snapshot(state: EditorState): HistoryEntry {
  return {
    segments: state.result?.segments.map((s) => ({ ...s })) ?? [],
    speakerMap: { ...state.speakerMap },
  };
}

/** Push the current state onto the history stack (called before mutating). */
function pushHistory(state: EditorState) {
  const entry = snapshot(state);
  state.past.push(entry);
  if (state.past.length > MAX_HISTORY) {
    state.past.shift();
  }
  state.future = []; // Clear redo stack on new mutation
}

/** Restore a history entry into the store state. */
function restore(state: EditorState, entry: HistoryEntry) {
  if (state.result) {
    state.result.segments = entry.segments.map((s) => ({ ...s }));
  }
  state.speakerMap = { ...entry.speakerMap };
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    result: null,
    activeSegmentId: null,
    isPlaying: false,
    playbackSpeed: 1,
    currentTime: 0,
    isEditing: false,
    speakerMap: {},

    past: [],
    future: [],

    setResult: (result: TranscriptionResult) => {
      set((state) => {
        state.result = result;
        state.speakerMap = { ...result.speakerMap };
        state.activeSegmentId = result.segments.length > 0 ? result.segments[0].id : null;
        state.currentTime = 0;
        state.isPlaying = false;
        state.isEditing = false;
        state.past = [];
        state.future = [];
      });
    },

    setActiveSegment: (id: string | null) => {
      set((state) => {
        state.activeSegmentId = id;
      });
    },

    togglePlay: () => {
      set((state) => {
        state.isPlaying = !state.isPlaying;
      });
    },

    setSpeed: (speed: number) => {
      set((state) => {
        state.playbackSpeed = speed;
      });
    },

    updateTime: (time: number) => {
      set((state) => {
        state.currentTime = time;
      });
    },

    startEditing: () => {
      set((state) => {
        state.isEditing = true;
      });
    },

    stopEditing: () => {
      set((state) => {
        state.isEditing = false;
      });
    },

    updateSegmentText: (id: string, text: string) => {
      set((state) => {
        if (!state.result) return;
        pushHistory(state);
        const seg = state.result.segments.find((s) => s.id === id);
        if (seg) {
          seg.text = text;
          seg.isModified = true;
        }
      });
    },

    updateSpeakerName: (spkId: string, name: string) => {
      set((state) => {
        pushHistory(state);
        state.speakerMap[spkId] = name;
      });
    },

    mergeSegments: (ids: string[]) => {
      set((state) => {
        if (!state.result || ids.length < 2) return;
        pushHistory(state);

        const segments = state.result.segments;
        const indices = ids
          .map((id) => segments.findIndex((s) => s.id === id))
          .filter((i) => i !== -1)
          .sort((a, b) => a - b);

        if (indices.length < 2) return;

        const first = segments[indices[0]];
        const last = segments[indices[indices.length - 1]];

        // Merge into the first segment
        first.end = last.end;
        first.text = indices.map((i) => segments[i].text).join(' ');
        first.isModified = true;

        // Remove the other segments (in reverse order to preserve indices)
        for (let i = indices.length - 1; i > 0; i--) {
          segments.splice(indices[i], 1);
        }

        state.activeSegmentId = first.id;
      });
    },

    splitSegment: (id: string, splitTime: number) => {
      set((state) => {
        if (!state.result) return;
        pushHistory(state);

        const segments = state.result.segments;
        const idx = segments.findIndex((s) => s.id === id);
        if (idx === -1) return;

        const seg = segments[idx];
        if (splitTime <= seg.start || splitTime >= seg.end) return;

        // Create two new segments from the split
        const newId = `${id}-split-${Date.now()}`;
        const newSegment: Segment = {
          id: newId,
          speaker: seg.speaker,
          start: splitTime,
          end: seg.end,
          text: '',
          rawText: '',
          emotion: seg.emotion,
          language: seg.language,
          events: [],
          isModified: true,
        };

        seg.end = splitTime;
        seg.isModified = true;

        segments.splice(idx + 1, 0, newSegment);
        state.activeSegmentId = newId;
      });
    },

    undo: () => {
      set((state) => {
        if (state.past.length === 0) return;
        // Save current state to future
        state.future.push(snapshot(state));
        if (state.future.length > MAX_HISTORY) {
          state.future.shift();
        }
        // Restore previous state
        const entry = state.past.pop()!;
        restore(state, entry);
      });
    },

    redo: () => {
      set((state) => {
        if (state.future.length === 0) return;
        // Save current state to past
        state.past.push(snapshot(state));
        if (state.past.length > MAX_HISTORY) {
          state.past.shift();
        }
        // Restore future state
        const entry = state.future.pop()!;
        restore(state, entry);
      });
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
  }))
);
