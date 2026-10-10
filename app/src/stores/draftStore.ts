import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { saveDraft, loadDraft as loadDraftFromStorage, deleteDraft } from '../utils/draft';
import { useEditorStore } from './editorStore';
import type { TranscriptionResult } from '../types';

const AUTOSAVE_DEBOUNCE_MS = 1000;

interface DraftState {
  currentDraftId: string | null;
  hasUnsavedChanges: boolean;
  autoSaveTimer: ReturnType<typeof setTimeout> | null;

  markDirty: () => void;
  autoSave: () => void;
  loadDraft: (taskId: string) => Promise<boolean>;
  clearDraft: (taskId: string) => Promise<void>;
  setCurrentDraftId: (taskId: string | null) => void;
}

export const useDraftStore = create<DraftState>()(
  immer((set, get) => ({
    currentDraftId: null,
    hasUnsavedChanges: false,
    autoSaveTimer: null,

    /**
     * Mark the draft as dirty and schedule a debounced auto-save.
     * Call this whenever the editor state changes.
     */
    markDirty: () => {
      set((state) => {
        state.hasUnsavedChanges = true;
      });
      get().autoSave();
    },

    /**
     * Debounced auto-save: writes the current editor result to localforage
     * after AUTOSAVE_DEBOUNCE_MS of inactivity.
     */
    autoSave: () => {
      const { autoSaveTimer } = get();
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
      }

      const timer = setTimeout(async () => {
        const { currentDraftId } = get();
        const { result } = useEditorStore.getState();

        if (currentDraftId && result) {
          try {
            await saveDraft(currentDraftId, result);
            set((state) => {
              state.hasUnsavedChanges = false;
              state.autoSaveTimer = null;
            });
          } catch (error) {
            console.error('Auto-save failed:', error);
            set((state) => {
              state.autoSaveTimer = null;
            });
          }
        }
      }, AUTOSAVE_DEBOUNCE_MS);

      set((state) => {
        state.autoSaveTimer = timer;
      });
    },

    /**
     * Load a draft from localforage and apply it to the editor store.
     * Returns true if a draft was found and loaded.
     */
    loadDraft: async (taskId: string): Promise<boolean> => {
      try {
        const draft = await loadDraftFromStorage(taskId);
        if (draft) {
          useEditorStore.getState().setResult(draft as TranscriptionResult);
          set((state) => {
            state.currentDraftId = taskId;
            state.hasUnsavedChanges = false;
          });
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to load draft:', error);
        return false;
      }
    },

    /**
     * Clear a draft from localforage and reset draft state if it matches.
     */
    clearDraft: async (taskId: string): Promise<void> => {
      try {
        await deleteDraft(taskId);
        set((state) => {
          if (state.currentDraftId === taskId) {
            state.currentDraftId = null;
            state.hasUnsavedChanges = false;
          }
        });
      } catch (error) {
        console.error('Failed to clear draft:', error);
      }
    },

    setCurrentDraftId: (taskId: string | null) => {
      set((state) => {
        state.currentDraftId = taskId;
      });
    },
  }))
);
