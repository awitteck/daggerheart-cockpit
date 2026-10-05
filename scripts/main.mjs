import {
  ID, SESSION_FIELDS, THREAD_FIELDS, updateFields, matchesSearch, appendNote, documentPresentation
} from "./model.mjs";
import { CockpitStore } from "./store.mjs";
import { Drafts } from "./drafts.mjs";

const t = key => game.i18n.localize(`DHC.${key}`);
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
let app;
let folderPromise;

function assertWriter() {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) throw new Error(t("primaryGM"));
}

const store = new CockpitStore({
  journals: () => Array.from(game.journal),
  assertWriter,
  localize: t,
  createJournal: data => JournalEntry.create(data),
  folder: async () => {
    if (!folderPromise) {
      folderPromise = (async () => {
        const existing = game.folders.find(folder => folder.type === "JournalEntry" && folder.getFlag(ID, "managed"));
        return (existing ?? await Folder.create({
          name: "Daggerheart Cockpit", type: "JournalEntry", flags: { [ID]: { managed: true } }
        })).id;
      })();
      folderPromise.catch(() => { folderPromise = null; });
    }
    return folderPromise;
  }
});

const ACTIONS = [
  "createSession", "createThread", "select", "save", "addEvent", "toggleThread",
  "attachThread", "detachThread", "removeLink", "openLink", "spotlight", "refresh",
  "view", "search", "archives", "archive", "rename", "feature", "convertEvent",
  "applyConversion", "previewSummary", "publishSummary", "removeEvent"
];
const VIEWS = ["prep", "play", "after"];

class Cockpit extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: ID,
    classes: ["dh-cockpit"],
    tag: "form",
    window: { title: "DHC.title", resizable: true },
    position: { width: 950, height: 800 },
    actions: Object.fromEntries(ACTIONS.map(action => [action, Cockpit.action]))
  };

  static PARTS = { body: { template: `modules/${ID}/templates/cockpit.hbs` } };

  selectedId = null;
  dirty = false;
  busy = false;
  baseline = null;
  view = "prep";
  query = "";
  showArchives = false;
  draftCache = new Map();
  draftStorage = null;
  storageError = false;
  conversion = null;
  summaryReady = false;
  freshRender = false;
  expandedCards = new Set();
  blockedDrafts = new Set();

  get selected() {
    return game.journal.get(this.selectedId);
  }

  get drafts() {
    this.draftStorage ??= new Drafts(globalThis.localStorage, game.world.id, game.user.id);
    return this.draftStorage;
  }

  report(error) {
    console.error(`${ID}:`, error);
    ui.notifications.error(error.message);
  }

  loadDraft(doc) {
    if (!this.draftCache.has(doc.uuid)) {
      try {
        this.draftCache.set(doc.uuid, this.drafts.read(doc.uuid));
      } catch (error) {
        this.storageError = true;
        this.blockedDrafts.add(doc.uuid);
        this.report(new Error(`${t("draftError")} ${error.message}`));
        this.draftCache.set(doc.uuid, null);
      }
    }
    return this.draftCache.get(doc.uuid);
  }

  captureDraft() {
    if (!this.selected || !game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    const values = Object.fromEntries(Array.from(this.element.querySelectorAll("[data-draft]")).map(input => [
      input.dataset.draft, input.type === "checkbox" ? input.checked : input.value
    ]));
    if (this.conversion?.session === this.selectedId) values.conversionIndex = String(this.conversion.index);
    const draft = { version: 1, revision: this.baseline, values };
    this.draftCache.set(this.selected.uuid, draft);
    if (this.blockedDrafts.has(this.selected.uuid)) {
      this.storageError = true;
      this.updateStatus();
      return;
    }
    try {
      this.drafts.save(this.selected.uuid, draft.revision, values);
      this.storageError = false;
    } catch (error) {
      if (!this.storageError) this.report(new Error(`${t("draftError")} ${error.message}`));
      this.storageError = true;
    }
    this.updateStatus();
  }

  updateStatus() {
    const status = this.element.querySelector("[data-save-status]");
    if (status) status.textContent = t(this.storageError ? "draftUnavailable" : this.dirty ? "draftSaved" : "journalSaved");
  }

  async _prepareContext() {
    // Capture before Foundry-triggered re-renders as well as our own actions.
    if (this.rendered && !this.freshRender) this.captureDraft();
    this.freshRender = false;
    const sessions = store.list("session");
    if (!this.selected) this.selectedId = sessions.filter(doc => !store.read(doc).archived).at(-1)?.id ?? null;
    const doc = this.selected;
    const record = doc ? store.read(doc) : null;
    const draft = doc ? this.loadDraft(doc) : null;
    if (!this.conversion && draft?.values?.conversionIndex !== undefined && record?.kind === "session") {
      const index = Number(draft.values.conversionIndex);
      if (record.events[index]) this.conversion = { session: doc.id, index, text: record.events[index].text };
    }
    this.baseline = draft?.revision ?? record?.revision ?? null;
    const isSession = record?.kind === "session";
    const threads = store.list("thread");
    const resolve = async uuid => {
      const linked = await fromUuid(uuid);
      const presentation = linked ? documentPresentation(linked) : null;
      return {
        uuid, name: linked?.name ?? `${t("missing")}: ${uuid}`, missing: !linked,
        icon: presentation?.icon, typeLabel: presentation ? t(presentation.typeKey) : ""
      };
    };
    const visible = doc => {
      const record = store.read(doc);
      return (this.showArchives || !record.archived) && matchesSearch(doc.name, record, this.query);
    };
    const cards = isSession ? await Promise.all(record.threads.map(async uuid => {
      const linked = threads.find(doc => doc.uuid === uuid);
      if (!linked) return { uuid, name: `${t("missing")}: ${uuid}`, missing: true };
      const thread = store.read(linked);
      return {
        uuid, id: linked.id, name: linked.name, status: t(thread.status),
        resolved: thread.status === "resolved", archived: thread.archived,
        featured: record.featured.includes(uuid),
        expanded: record.featured.includes(uuid) || this.expandedCards.has(uuid),
        fields: THREAD_FIELDS.map(key => ({ label: t(key), value: thread[key] })),
        links: await Promise.all(thread.links.map(resolve))
      };
    })) : [];
    cards.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
    return {
      hint: t("hint"), writer: game.user.isGM && game.users.activeGM?.id === game.user.id,
      sessions: sessions.filter(visible).map(doc => ({
        id: doc.id, name: doc.name, selected: doc.id === this.selectedId, archived: store.read(doc).archived
      })),
      threads: threads.filter(visible).map(doc => ({
        id: doc.id, name: doc.name, status: t(store.read(doc).status), archived: store.read(doc).archived
      })),
      query: this.query, showArchives: this.showArchives,
      selected: doc ? { name: doc.name, uuid: doc.uuid } : null,
      record, isSession, status: t(record?.status ?? "open"),
      views: VIEWS.map(key => ({ key, label: t(key), active: this.view === key })),
      prep: this.view === "prep", play: this.view === "play", after: this.view === "after",
      fields: record ? (isSession ? SESSION_FIELDS : THREAD_FIELDS).map(key => ({
        key, label: t(key), value: record[key],
        hidden: isSession && (this.view === "play" ||
          (this.view === "prep" ? ["consequences", "feedback", "nextGoals"].includes(key) :
            !["consequences", "feedback", "nextGoals"].includes(key)))
      })) : [],
      links: record ? await Promise.all(record.links.map(resolve)) : [],
      attached: cards,
      available: isSession ? threads.filter(doc => {
        const thread = store.read(doc);
        return thread.status === "open" && !thread.archived && !record.threads.includes(doc.uuid);
      }).map(doc => ({ uuid: doc.uuid, name: doc.name })) : [],
      factTargets: threads.filter(doc => !store.read(doc).archived).map(doc => ({ uuid: doc.uuid, name: doc.name })),
      actors: isSession ? game.actors.filter(actor => actor.type === "character").map(actor => ({
        uuid: actor.uuid, name: actor.name, marked: record.spotlight.includes(actor.uuid)
      })) : [],
      conversion: this.conversion?.session === doc?.id ? this.conversion : null,
      summaryReady: this.summaryReady || Boolean(draft?.values?.summaryBody),
      summaryName: doc ? `${doc.name} — ${t("summary")}` : "",
      stale: Boolean(draft && record && draft.revision !== record.revision)
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const draft = this.selected ? this.loadDraft(this.selected) : null;
    this.element.querySelectorAll("[data-draft]").forEach(input => {
      const value = draft?.values?.[input.dataset.draft];
      if (value !== undefined) {
        if (input.type === "checkbox") input.checked = value === true;
        else input.value = value;
      }
      input.addEventListener("input", () => {
        this.dirty = true;
        this.captureDraft();
      });
    });
    this.dirty = Boolean(draft && this.hasUnsaved(draft));
    this.updateStatus();
    this.element.addEventListener("submit", event => event.preventDefault());
    this.element.addEventListener("dragover", event => event.preventDefault());
    this.element.addEventListener("drop", event => this.dropDocument(event));
    this.element.querySelectorAll("[data-card]").forEach(card => card.addEventListener("toggle", () => {
      if (card.open) this.expandedCards.add(card.dataset.card);
      else this.expandedCards.delete(card.dataset.card);
    }));
  }

  hasUnsaved(draft) {
    const record = store.read(this.selected);
    return Object.entries(draft.values).some(([key, value]) =>
      key.startsWith("note:") ? record[key.slice(5)] !== value :
        ["event", "summaryBody", "conversionText"].includes(key) && Boolean(value)
    );
  }

  async close(options) {
    if (this.busy) return;
    this.captureDraft();
    if (this.dirty && this.storageError && !await DialogV2.confirm({
      window: { title: t("unsaved") }, content: `<p>${t("closeWithoutDraft")}</p>`
    })) return;
    return super.close(options);
  }

  async perform(operation, { preserveEvent = true } = {}) {
    if (this.busy) return;
    this.captureDraft();
    this.busy = true;
    this.element.querySelectorAll("input, textarea, select, button").forEach(input => {
      input.dataset.wasDisabled = String(input.disabled);
      input.disabled = true;
    });
    try {
      await operation();
      if (!preserveEvent && this.selected) {
        const draft = this.draftCache.get(this.selected.uuid);
        if (draft) draft.values.event = "";
      }
      this.freshRender = true;
      await this.render({ force: true });
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      this.element.querySelectorAll("[data-was-disabled]").forEach(input => {
        input.disabled = input.dataset.wasDisabled === "true";
        delete input.dataset.wasDisabled;
      });
      this.updateStatus();
    }
  }

  applyDraft(record) {
    if (record.revision !== this.baseline) throw new Error(t("conflict"));
    const values = Object.fromEntries(
      Array.from(this.element.querySelectorAll("[data-note]")).map(input => [input.dataset.note, input.value])
    );
    return updateFields(record, values);
  }

  async saveCurrent(transform = record => record, options = {}) {
    const doc = this.selected;
    if (!doc) throw new Error(t("selectFirst"));
    const record = await store.change(doc, current => transform(this.applyDraft(current)), options);
    this.baseline = record.revision;
    const draft = this.draftCache.get(doc.uuid);
    if (draft) {
      draft.revision = record.revision;
      for (const key of Object.keys(draft.values)) {
        if (key.startsWith("note:")) delete draft.values[key];
      }
      this.persistCached(doc);
    }
    return record;
  }

  persistCached(doc) {
    const draft = this.draftCache.get(doc.uuid);
    if (!draft || this.blockedDrafts.has(doc.uuid)) return;
    try {
      this.drafts.save(doc.uuid, draft.revision, draft.values);
      this.storageError = false;
    } catch (error) {
      if (!this.storageError) this.report(new Error(`${t("draftError")} ${error.message}`));
      this.storageError = true;
    }
  }

  clearDraftValues(keys) {
    const draft = this.draftCache.get(this.selected.uuid);
    if (draft) {
      for (const key of keys) delete draft.values[key];
      this.persistCached(this.selected);
    }
  }

  async openDocument(uuid) {
    const doc = await fromUuid(uuid);
    if (!doc) return ui.notifications.warn(t("missing"));
    await doc.sheet.render({ force: true });
  }

  static async action(event, target) {
    if (this.busy) return;
    const action = target.dataset.action;
    await this.perform(async () => {
      if (action === "openLink") {
        await this.openDocument(target.dataset.uuid);
      } else if (action === "view") {
        if (VIEWS.includes(target.dataset.view)) this.view = target.dataset.view;
      } else if (action === "select") {
        this.selectedId = target.dataset.id;
        this.conversion = null;
        this.summaryReady = false;
      } else if (action === "search") {
        this.query = this.element.querySelector("[name=search]").value;
      } else if (action === "archives") {
        this.showArchives = !this.showArchives;
      } else if (action === "refresh") {
        if (this.dirty && !await DialogV2.confirm({
          window: { title: t("unsaved") }, content: `<p>${t("discard")}</p>`
        })) return;
        if (this.selected) {
          this.drafts.remove(this.selected.uuid);
          this.draftCache.delete(this.selected.uuid);
          this.blockedDrafts.delete(this.selected.uuid);
          this.storageError = false;
        }
        this.conversion = null;
        this.summaryReady = false;
      } else if (action === "createSession" || action === "createThread") {
        const name = this.element.querySelector("[name=newName]").value.trim();
        if (!name) throw new Error(t("nameRequired"));
        const previous = this.selected?.getFlag(ID, "record")?.kind === "session" ? this.selected : null;
        // Carry forward the visible, saved goals rather than silently dropping current edits.
        if (previous) await this.saveCurrent();
        const doc = await store.create(action === "createSession" ? "session" : "thread", name, previous);
        this.selectedId = doc.id;
        this.conversion = null;
        this.summaryReady = false;
      } else if (action === "convertEvent") {
        const pending = this.element.querySelector("[name=conversionText]");
        if (pending?.value.trim() && this.conversion && pending.value !== this.conversion.text &&
            !await DialogV2.confirm({
              window: { title: t("unsaved") }, content: `<p>${t("replaceConversion")}</p>`
            })) return;
        const record = store.read(this.selected);
        const index = Number(target.dataset.index);
        const event = record.events[index];
        if (!event) throw new Error(t("missingEvent"));
        this.conversion = { session: this.selected.id, index, text: event.text };
        this.clearDraftValues(["conversionText"]);
        const draft = this.draftCache.get(this.selected.uuid);
        draft.values.conversionIndex = String(index);
        this.persistCached(this.selected);
        this.view = "after";
      } else if (action === "applyConversion") {
        await this.convert();
      } else if (action === "removeEvent") {
        assertWriter();
        const index = Number(target.dataset.index);
        if (!Number.isSafeInteger(index) || index < 0 || !store.read(this.selected).events?.[index]) {
          throw new Error(t("missingEvent"));
        }
        if (!await DialogV2.confirm({
          window: { title: t("removeEvent") }, content: `<p>${t("removeEventWarning")}</p>`
        })) return;
        await this.saveCurrent(record => {
          if (!record.events[index]) throw new Error(t("missingEvent"));
          record.events.splice(index, 1);
          return record;
        });
        const draft = this.draftCache.get(this.selected.uuid);
        if (draft) {
          const selections = Object.entries(draft.values).filter(([key]) => key.startsWith("summaryEvent:"));
          for (const [key] of selections) delete draft.values[key];
          for (const [key, value] of selections) {
            const oldIndex = Number(key.slice("summaryEvent:".length));
            if (oldIndex !== index) draft.values[`summaryEvent:${oldIndex > index ? oldIndex - 1 : oldIndex}`] = value;
          }
          if (this.conversion?.session === this.selectedId) {
            if (this.conversion.index === index) {
              this.conversion = null;
              for (const key of ["conversionIndex", "conversionText", "conversionName", "conversionType", "factTarget"]) {
                delete draft.values[key];
              }
            } else if (this.conversion.index > index) {
              this.conversion.index--;
              draft.values.conversionIndex = String(this.conversion.index);
            }
          }
          this.persistCached(this.selected);
        }
      } else if (action === "previewSummary") {
        if (this.element.querySelector("[name=summaryBody]")?.value.trim() &&
            !await DialogV2.confirm({
              window: { title: t("unsaved") }, content: `<p>${t("replaceSummary")}</p>`
            })) return;
        this.prepareSummary();
      } else if (action === "publishSummary") {
        assertWriter();
        const name = this.element.querySelector("[name=summaryName]").value.trim();
        const text = this.element.querySelector("[name=summaryBody]").value.trim();
        if (!name || !text) throw new Error(t("summaryRequired"));
        if (!await DialogV2.confirm({
          window: { title: t("publishSummary") }, content: `<p>${t("publishWarning")}</p>`
        })) return;
        const doc = await store.publish(name, text);
        this.clearDraftValues(["summaryBody", "summaryName"]);
        this.summaryReady = false;
        ui.notifications.info(t("published"));
        await this.openDocument(doc.uuid);
      } else {
        assertWriter();
        const text = this.element.querySelector("[name=event]")?.value.trim();
        if (action === "addEvent" && !text) throw new Error(t("eventRequired"));
        const name = action === "rename" ? this.element.querySelector("[name=rename]").value : undefined;
        await this.saveCurrent(record => {
          switch (action) {
            case "addEvent":
              record.events.push({ time: new Date().toISOString(), text });
              break;
            case "archive":
              record.archived = !record.archived;
              break;
            case "toggleThread":
              record.status = record.status === "open" ? "resolved" : "open";
              break;
            case "attachThread": {
              const uuid = this.element.querySelector("[name=thread]").value;
              if (!uuid || !store.list("thread").some(doc => doc.uuid === uuid)) throw new Error(t("missing"));
              if (!record.threads.includes(uuid)) record.threads.push(uuid);
              break;
            }
            case "detachThread":
              record.threads = record.threads.filter(uuid => uuid !== target.dataset.uuid);
              record.featured = record.featured.filter(uuid => uuid !== target.dataset.uuid);
              break;
            case "feature":
              if (!record.threads.includes(target.dataset.uuid)) throw new Error(t("missing"));
              record.featured = record.featured.includes(target.dataset.uuid)
                ? record.featured.filter(uuid => uuid !== target.dataset.uuid)
                : [...record.featured, target.dataset.uuid];
              break;
            case "removeLink":
              record.links = record.links.filter(uuid => uuid !== target.dataset.uuid);
              break;
            case "spotlight":
              record.spotlight = record.spotlight.includes(target.dataset.uuid)
                ? record.spotlight.filter(uuid => uuid !== target.dataset.uuid)
                : [...record.spotlight, target.dataset.uuid];
              break;
          }
          return record;
        }, { name });
        if (action === "addEvent") this.clearDraftValues(["event"]);
        if (action === "save") ui.notifications.info(t("saved"));
      }
    });
  }

  async convert() {
    assertWriter();
    if (!this.conversion || this.conversion.session !== this.selectedId) throw new Error(t("missingEvent"));
    const text = this.element.querySelector("[name=conversionText]").value.trim();
    const type = this.element.querySelector("[name=conversionType]").value;
    if (!text) throw new Error(t("eventRequired"));
    if (!await DialogV2.confirm({
      window: { title: t("applyConversion") }, content: `<p>${t("conversionWarning")}</p>`
    })) return;
    if (["consequences", "nextGoals"].includes(type)) {
      await this.saveCurrent(record => appendNote(record, type, text));
    } else if (type === "facts") {
      const uuid = this.element.querySelector("[name=factTarget]").value;
      const doc = store.list("thread").find(doc => doc.uuid === uuid);
      if (!doc) throw new Error(t("missing"));
      await this.saveCurrent();
      await store.change(doc, record => appendNote(record, "facts", text));
    } else if (type === "newThread") {
      const name = this.element.querySelector("[name=conversionName]").value.trim();
      if (!name) throw new Error(t("nameRequired"));
      await this.saveCurrent();
      await store.create("thread", name, null, { facts: text });
      ui.notifications.info(t("createdFromEvent"));
    } else throw new Error(t("invalidConversion"));
    this.clearDraftValues(["conversionText", "conversionName", "conversionIndex"]);
    this.conversion = null;
  }

  prepareSummary() {
    assertWriter();
    const record = this.applyDraft(store.read(this.selected));
    const sections = [];
    for (const input of this.element.querySelectorAll("[data-summary-event]")) {
      if (input.checked) {
        const event = record.events[Number(input.dataset.summaryEvent)];
        if (event) sections.push(event.text);
      }
    }
    for (const input of this.element.querySelectorAll("[data-summary-field]")) {
      if (input.checked) sections.push(`${t(input.dataset.summaryField)}\n${record[input.dataset.summaryField]}`);
    }
    const text = sections.join("\n\n").trim();
    if (!text) throw new Error(t("selectSummary"));
    const draft = this.draftCache.get(this.selected.uuid);
    draft.values.summaryBody = text;
    this.persistCached(this.selected);
    this.summaryReady = true;
  }

  async dropDocument(event) {
    event.preventDefault();
    await this.perform(async () => {
      assertWriter();
      if (!this.selected) throw new Error(t("selectFirst"));
      const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
      if (!data.uuid) throw new Error(t("invalidDrop"));
      const doc = await fromUuid(data.uuid);
      if (!doc || !["Actor", "JournalEntry", "JournalEntryPage", "Scene", "RollTable"].includes(doc.documentName)) {
        throw new Error(t("invalidDrop"));
      }
      await this.saveCurrent(record => {
        if (!record.links.includes(doc.uuid)) record.links.push(doc.uuid);
        return record;
      });
    });
  }
}

function openCockpit() {
  if (!game.user.isGM) return ui.notifications.error(t("gmOnly"));
  app ??= new Cockpit();
  if (app.rendered) {
    app.bringToFront();
    return app;
  }
  return app.render({ force: true });
}

Hooks.once("init", () => {
  game.settings.registerMenu(ID, "open", {
    name: "DHC.title", label: "DHC.launch", hint: "DHC.hint",
    icon: "fa-solid fa-book-open", type: Cockpit, restricted: true
  });
  game.keybindings.register(ID, "open", {
    name: "DHC.launch", restricted: true,
    editable: [{ key: "KeyK", modifiers: ["Control", "Shift"] }],
    onDown: () => { openCockpit(); return true; }
  });
});

Hooks.once("ready", () => {
  game.modules.get(ID).api = { open: openCockpit };
});
