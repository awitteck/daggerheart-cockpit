import { ID, publicHTML, escapeHTML } from "./model.mjs";

export const BOOK_CATEGORIES = ["general", "person", "place", "clue", "agreement"];
export const BOOK_SOURCES = ["observed", "reported", "theory"];

export function validateNotebook(record) {
  if (!record || ![1, 2, 3].includes(record.version) || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      ["sessionId", "sessionName", "userId", "authorName", "body"].some(key => typeof record[key] !== "string") ||
      (record.version === 3 && record.body !== "")) {
    throw new Error("Unsupported or damaged player notes. No data was changed.");
  }
  if (record.version >= 2 && (!Array.isArray(record.entries) || record.entries.some(entry =>
    !entry || ["id", "title", "text", "updated"].some(key => typeof entry[key] !== "string") ||
    !/^[A-Za-z0-9_-]+$/.test(entry.id) || !entry.title.trim() || !entry.text.trim() ||
    !BOOK_CATEGORIES.includes(entry.category) || !BOOK_SOURCES.includes(entry.source)
  ) || new Set(record.entries.map(entry => entry.id)).size !== record.entries.length)) {
    throw new Error("Invalid campaign book entries. No data was changed.");
  }
  return record;
}

export class PlayerNotesStore {
  #pending = Promise.resolve();

  constructor(env) {
    this.env = env;
  }

  list(sessionId = null) {
    return this.env.journals().filter(doc => {
      const notes = doc.getFlag(ID, "playerNotes");
      return notes && (sessionId === null || notes.sessionId === sessionId);
    });
  }

  read(doc) {
    const record = structuredClone(validateNotebook(doc.getFlag(ID, "playerNotes")));
    if (record.version === 1) {
      record.version = 2;
      record.entries = [];
    }
    if (record.version === 2) {
      record.version = 3;
      if (record.body.trim()) {
        let id = "legacy-session-note";
        while (record.entries.some(entry => entry.id === id)) id += "-old";
        record.entries.push({
          id, title: this.env.localize("generalSessionNote"), text: record.body,
          category: "general", source: "reported", updated: ""
        });
      }
      record.body = "";
    }
    return record;
  }

  #write(operation) {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => {});
    return result;
  }

  enable(session) {
    return this.#write(async () => {
      this.env.assertWriter();
      for (const user of this.env.users().filter(user => !user.isGM)) {
        if (this.list(session.id).some(doc => this.read(doc).userId === user.id)) continue;
        const record = {
          version: 3, revision: 0, sessionId: session.id, sessionName: session.name,
          userId: user.id, authorName: user.name, body: "", entries: []
        };
        await this.env.createJournal({
          name: `${session.name} — ${this.env.localize("playerNotes")} — ${user.name}`,
          ownership: { default: 2, [user.id]: 3 },
          flags: { [ID]: { playerNotes: record } },
          pages: [{
            name: this.env.localize("playerNotes"), type: "text",
            flags: { [ID]: { playerNotesPage: true } },
            text: { format: 1, content: this.html(record) }
          }]
        });
      }
      return this.list(session.id);
    });
  }

  html(record) {
    return `<h2>${escapeHTML(record.authorName)}</h2>` +
      record.entries.map(entry => `<h3>${escapeHTML(entry.title)}</h3><p>${
        escapeHTML(this.env.localize(`book_${entry.category}`))} · ${
        escapeHTML(this.env.localize(`source_${entry.source}`))}</p>${publicHTML(entry.text)}`).join("") +
      (!record.entries.length ? `<p>${escapeHTML(this.env.localize("noPlayerNotes"))}</p>` : "");
  }

  saveEntry(doc, revision, entry) {
    return this.change(doc, revision, record => {
      const next = { ...entry, updated: new Date().toISOString() };
      const index = record.entries.findIndex(saved => saved.id === next.id);
      if (index < 0) record.entries.push(next);
      else record.entries[index] = next;
      return record;
    });
  }

  removeEntry(doc, revision, id) {
    return this.change(doc, revision, record => {
      if (!record.entries.some(entry => entry.id === id)) throw new Error(this.env.localize("missing"));
      record.entries = record.entries.filter(entry => entry.id !== id);
      return record;
    });
  }

  change(doc, revision, transform) {
    return this.#write(async () => {
      if (!doc) throw new Error(this.env.localize("noOwnNotebook"));
      if (!this.env.journals().some(current => current.id === doc.id)) throw new Error(this.env.localize("missing"));
      const current = this.read(doc);
      const user = this.env.currentUser();
      if (current.userId !== user.id || !doc.testUserPermission(user, "OWNER")) {
        throw new Error(this.env.localize("ownNotesOnly"));
      }
      if (current.revision !== revision) throw new Error(this.env.localize("conflict"));
      const page = doc.pages.find(page => page.getFlag(ID, "playerNotesPage"));
      if (!page) throw new Error(this.env.localize("missingPage"));
      const record = validateNotebook(transform({ ...current, revision: current.revision + 1 }));
      await doc.update({
        [`flags.${ID}.playerNotes`]: record,
        pages: [{ _id: page.id, "text.content": this.html(record) }]
      });
      return record;
    });
  }
}
