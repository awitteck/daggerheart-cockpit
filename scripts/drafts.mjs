import { ID } from "./model.mjs";

export class Drafts {
  constructor(storage, world, user) {
    this.storage = storage;
    this.prefix = `${ID}:draft:${encodeURIComponent(world)}:${encodeURIComponent(user)}:`;
  }

  key(uuid) {
    return this.prefix + encodeURIComponent(uuid);
  }

  read(uuid) {
    const raw = this.storage.getItem(this.key(uuid));
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
        !draft.values || typeof draft.values !== "object" || Array.isArray(draft.values) ||
        Object.values(draft.values).some(value => typeof value !== "string" && typeof value !== "boolean")) {
      throw new Error("Invalid local draft. It has not been deleted.");
    }
    return draft;
  }

  save(uuid, revision, values) {
    const draft = { version: 1, revision, values, time: new Date().toISOString() };
    this.storage.setItem(this.key(uuid), JSON.stringify(draft));
  }

  remove(uuid) {
    this.storage.removeItem(this.key(uuid));
  }
}
