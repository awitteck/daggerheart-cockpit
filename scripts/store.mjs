import { ID, createRecord, validateRecord, upgradeRecord, journalHTML, publicHTML } from "./model.mjs";

export class CockpitStore {
  #pending = Promise.resolve();

  constructor(env) {
    this.env = env;
  }

  list(kind) {
    return this.env.journals().filter(doc => doc.getFlag(ID, "record")?.kind === kind);
  }

  read(doc) {
    return upgradeRecord(doc.getFlag(ID, "record"));
  }

  #write(operation) {
    const result = this.#pending.then(() => {
      this.env.assertWriter();
      return operation();
    });
    this.#pending = result.catch(() => {});
    return result;
  }

  create(kind, name, previous = null, initial = {}) {
    return this.#write(async () => {
      const record = createRecord(kind, name, previous ? this.read(previous) : null);
      for (const field of ["facts", "motives", "development"]) {
        if (kind === "thread" && Object.hasOwn(initial, field)) record[field] = initial[field];
      }
      validateRecord(record);
      if (kind === "session") {
        const open = new Set(this.list("thread").filter(doc => {
          const record = this.read(doc);
          return record.status === "open" && !record.archived;
        }).map(doc => doc.uuid));
        record.threads = previous ? this.read(previous).threads.filter(uuid => open.has(uuid)) : [];
      }
      return this.env.createJournal({
        name: name.trim(),
        folder: await this.env.folder(),
        ownership: { default: 0 },
        flags: { [ID]: { record } },
        pages: [{
          name: this.env.localize(kind), type: "text",
          flags: { [ID]: { managed: true } },
          text: { format: 1, content: journalHTML(record, this.env.localize) }
        }]
      });
    });
  }

  change(doc, transform, { name } = {}) {
    return this.#write(async () => {
      if (!this.env.journals().some(current => current.id === doc.id)) throw new Error(this.env.localize("missing"));
      const current = this.read(doc);
      const record = validateRecord(await transform(structuredClone(current)));
      if (name !== undefined && (typeof name !== "string" || !name.trim())) throw new Error(this.env.localize("nameRequired"));
      record.revision = current.revision + 1;
      const page = doc.pages.find(page => page.getFlag(ID, "managed"));
      if (!page) throw new Error(this.env.localize("missingPage"));
      // One document update keeps structured data and the readable journal together.
      await doc.update({
        ...(name !== undefined ? { name: name.trim() } : {}),
        [`flags.${ID}.record`]: record,
        pages: [{ _id: page.id, "text.content": journalHTML(record, this.env.localize) }]
      });
      return record;
    });
  }

  publish(name, text) {
    return this.#write(async () => {
      if (typeof name !== "string" || !name.trim()) throw new Error(this.env.localize("nameRequired"));
      const content = publicHTML(text);
      // No source flags, private folder, document links, or hidden GM fields are copied.
      return this.env.createJournal({
        name: name.trim(), ownership: { default: 2 },
        pages: [{ name: this.env.localize("summary"), type: "text", text: { format: 1, content } }]
      });
    });
  }
}
