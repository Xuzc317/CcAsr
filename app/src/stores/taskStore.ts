import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Task } from '../types';
import * as api from '../services/api';

interface TaskState {
  tasks: Task[];
  currentTask: Task | null;
  isLoading: boolean;
  pollingTimer: ReturnType<typeof setInterval> | null;

  fetchTasks: () => Promise<void>;
  fetchTask: (id: string) => Promise<void>;
  createTask: (file: File, language?: string) => Promise<Task>;
  setCurrentTask: (task: Task | null) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useTaskStore = create<TaskState>()(
  immer((set, get) => ({
    tasks: [],
    currentTask: null,
    isLoading: false,
    pollingTimer: null,

    fetchTasks: async () => {
      set((state) => {
        state.isLoading = true;
      });
      try {
        const tasks = await api.getTasks();
        set((state) => {
          state.tasks = tasks;
          state.isLoading = false;
        });
        // Start polling if any tasks are still processing
        const hasProcessing = tasks.some(
          (t) => t.status === 'pending' || t.status === 'processing'
        );
        if (hasProcessing) {
          get().startPolling();
        } else {
          get().stopPolling();
        }
      } catch (error) {
        set((state) => {
          state.isLoading = false;
        });
        throw error;
      }
    },

    fetchTask: async (id: string) => {
      try {
        const task = await api.getTask(id);
        set((state) => {
          const idx = state.tasks.findIndex((t) => t.id === id);
          if (idx !== -1) {
            state.tasks[idx] = task;
          } else {
            state.tasks.push(task);
          }
          if (state.currentTask?.id === id) {
            state.currentTask = task;
          }
        });
      } catch (error) {
        throw error;
      }
    },

    createTask: async (file: File, language?: string) => {
      set((state) => {
        state.isLoading = true;
      });
      try {
        const task = await api.uploadAudio(file, language);
        set((state) => {
          state.tasks.unshift(task);
          state.currentTask = task;
          state.isLoading = false;
        });
        // Start polling since new task will be pending
        get().startPolling();
        return task;
      } catch (error) {
        set((state) => {
          state.isLoading = false;
        });
        throw error;
      }
    },

    setCurrentTask: (task: Task | null) => {
      set((state) => {
        state.currentTask = task;
      });
    },

    startPolling: () => {
      const { pollingTimer } = get();
      if (pollingTimer) return; // Already polling

      const timer = setInterval(async () => {
        const { tasks } = get();
        const processingTasks = tasks.filter(
          (t) => t.status === 'pending' || t.status === 'processing'
        );

        if (processingTasks.length === 0) {
          get().stopPolling();
          return;
        }

        // Poll each processing task
        for (const task of processingTasks) {
          try {
            await get().fetchTask(task.id);
          } catch {
            // Ignore individual poll failures
          }
        }
      }, 2000);

      set((state) => {
        state.pollingTimer = timer;
      });
    },

    stopPolling: () => {
      const { pollingTimer } = get();
      if (pollingTimer) {
        clearInterval(pollingTimer);
        set((state) => {
          state.pollingTimer = null;
        });
      }
    },
  }))
);
