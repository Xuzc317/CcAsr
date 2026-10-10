import localforage from 'localforage';

const draftStore = localforage.createInstance({
  name: 'ccasr',
  storeName: 'drafts',
});

export async function saveDraft(taskId: string, data: unknown): Promise<void> {
  await draftStore.setItem(taskId, data);
}

export async function loadDraft(taskId: string): Promise<unknown | null> {
  return draftStore.getItem(taskId);
}

export async function deleteDraft(taskId: string): Promise<void> {
  await draftStore.removeItem(taskId);
}

export async function listDrafts(): Promise<string[]> {
  return draftStore.keys();
}
