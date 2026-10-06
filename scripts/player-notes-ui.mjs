import { ID } from "./model.mjs";
import { Drafts } from "./drafts.mjs";
import { PlayerNotesStore, BOOK_CATEGORIES, BOOK_SOURCES } from "./player-notes.mjs";

const t = key => game.i18n.localize(`DHC.${key}`);
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
export const playerNotesStore = new PlayerNotesStore({
  journals: () => Array.from(game.journal),
  users: () => Array.from(game.users),
  currentUser: () => game.user,
  localize: t,
  assertWriter: () => {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) throw new Error(t("primaryGM"));
  },
  createJournal: data => JournalEntry.create(data)
});

export class PlayerNotes extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${ID}-player-notes`, classes: ["dh-cockpit"], tag: "form",
    window: { title: "DHC.playerNotes", resizable: true },
    position: { width: 760, height: 720 },
    actions: {
      notesSelect: PlayerNotes.action, bookLegacy: PlayerNotes.action,
      notesRefresh: PlayerNotes.action, notesDiscard: PlayerNotes.action,
      bookSave: PlayerNotes.action, bookEdit: PlayerNotes.action, bookNew: PlayerNotes.action,
      bookRemove: PlayerNotes.action, bookSearch: PlayerNotes.action
    }
  };

  static PARTS = { body: { template: `modules/${ID}/templates/player-notes.hbs` } };
  selectedSession = null;
  revision = null;
  dirty = false;
  busy = false;
  draft = null;
  draftError = false;
  drafts = null;
  draftUuid = null;
  freshRender = false;
  query = "";

  get own() {
    return playerNotesStore.list(this.selectedSession).find(doc => playerNotesStore.read(doc).userId === game.user.id);
  }

  report(error) {
    console.error(`${ID} player notes:`, error);
    ui.notifications.error(error.message);
  }

  capture() {
    if (!this.own || !this.element) return;
    if (!this.element.querySelector("[name=bookText]")) return;
    const values = Object.fromEntries(Array.from(this.element.querySelectorAll("[data-player-draft]")).map(input =>
      [input.dataset.playerDraft, input.value]
    ));
    if (this.draft?.values.playerBody) values.playerBody = this.draft.values.playerBody;
    if (this.draft?.values.legacyLoaded) values.legacyLoaded = this.draft.values.legacyLoaded;
    this.draft = { revision: this.revision, values };
    this.dirty = Boolean(values.bookTitle || values.bookText || values.playerBody);
    try {
      // A corrupt draft is retained until the user explicitly discards it.
      if (!this.draftError) this.drafts.save(this.own.uuid, this.revision, this.draft.values);
    } catch (error) {
      if (!this.draftError) this.report(new Error(`${t("draftError")} ${error.message}`));
      this.draftError = true;
    }
    this.status();
  }

  status() {
    const node = this.element.querySelector("[data-save-status]");
    if (node) node.textContent = t(this.draftError ? "draftUnavailable" : this.dirty ? "draftSaved" : "journalSaved");
  }

  async _prepareContext() {
    if (this.rendered && !this.freshRender) this.capture();
    this.freshRender = false;
    this.drafts ??= new Drafts(globalThis.localStorage, game.world.id, game.user.id);
    const notebooks = playerNotesStore.list();
    const sessions = new Map();
    for (const doc of notebooks) {
      const record = playerNotesStore.read(doc);
      sessions.set(record.sessionId, record.sessionName);
    }
    if (!sessions.has(this.selectedSession)) this.selectedSession = Array.from(sessions.keys()).at(-1) ?? null;
    const own = this.own;
    if (own?.uuid !== this.draftUuid) {
      this.draftUuid = own?.uuid ?? null;
      this.draft = null;
      this.draftError = false;
      if (own) {
        try {
          this.draft = this.drafts.read(own.uuid);
          const original = own.getFlag(ID, "playerNotes");
          if (original.version < 3 && this.draft?.values.playerBody === original.body) {
            delete this.draft.values.playerBody;
          }
        }
        catch (error) { this.draftError = true; this.report(new Error(`${t("draftError")} ${error.message}`)); }
      }
    }
    const record = own ? playerNotesStore.read(own) : null;
    this.revision = this.draft?.revision ?? record?.revision ?? null;
    this.dirty = Boolean(record && (this.draft?.values.playerBody || this.draft?.values.bookTitle || this.draft?.values.bookText));
    const allEntries = notebooks.flatMap(doc => {
      const notes = playerNotesStore.read(doc);
      return notes.entries.map(entry => ({
        ...entry, notebookId: doc.id, authorName: notes.authorName, sessionName: notes.sessionName,
        editable: notes.userId === game.user.id,
        sourceLabel: t(`source_${entry.source}`)
      }));
    }).filter(entry => [entry.title, entry.text, entry.authorName, entry.sessionName].join("\n")
      .toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()));
    allEntries.sort((a, b) => a.title.localeCompare(b.title));
    return {
      sessions: Array.from(sessions, ([id, name]) => ({ id, name, selected: id === this.selectedSession })),
      own: Boolean(own), stale: Boolean(record && this.revision !== record.revision),
      legacyDraft: Boolean(this.draft?.values.playerBody),
      query: this.query,
      categories: BOOK_CATEGORIES.map(key => ({ key, label: t(`book_${key}`) })),
      sources: BOOK_SOURCES.map(key => ({ key, label: t(`source_${key}`) })),
      groups: BOOK_CATEGORIES.map(key => ({
        label: t(`book_${key}`), entries: allEntries.filter(entry => entry.category === key)
      })).filter(group => group.entries.length)
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("submit", event => event.preventDefault());
    this.element.querySelectorAll("[data-player-draft]").forEach(input => {
      const value = this.draft?.values[input.dataset.playerDraft];
      if (value !== undefined) input.value = value;
      input.addEventListener("input", () => this.capture());
    });
    this.status();
  }

  async close(options) {
    if (this.busy) return;
    this.capture();
    if (this.dirty && this.draftError && !await DialogV2.confirm({
      window: { title: t("unsaved") }, content: `<p>${t("closeWithoutDraft")}</p>`
    })) return;
    return super.close(options);
  }

  static async action(event, target) {
    if (this.busy) return;
    this.capture();
    this.busy = true;
    this.element.querySelectorAll("button, textarea, input, select").forEach(input => { input.disabled = true; });
    try {
      const action = target.dataset.action;
      if (action === "bookSearch") {
        this.query = this.element.querySelector("[name=bookSearch]").value;
      } else if (action === "bookEdit" || action === "bookNew" || action === "bookLegacy") {
        if ((this.draft?.values.bookTitle || this.draft?.values.bookText) && !await DialogV2.confirm({
          window: { title: t("unsaved") }, content: `<p>${t("replaceBookDraft")}</p>`
        })) return;
        if (action === "bookEdit") {
          const doc = playerNotesStore.list().find(doc => doc.id === target.dataset.notebook);
          if (!doc || playerNotesStore.read(doc).userId !== game.user.id) throw new Error(t("ownNotesOnly"));
          const notes = playerNotesStore.read(doc);
          const entry = notes.entries.find(entry => entry.id === target.dataset.entry);
          if (!entry) throw new Error(t("missing"));
          const same = this.own?.id === doc.id;
          let previous;
          if (same) previous = this.draft;
          else previous = this.drafts.read(doc.uuid);
          if (!same && (previous?.values.bookTitle || previous?.values.bookText) &&
              !await DialogV2.confirm({
                window: { title: t("unsaved") }, content: `<p>${t("replaceBookDraft")}</p>`
              })) return;
          if (same && this.draftError) throw new Error(t("draftError"));
          this.selectedSession = notes.sessionId;
          this.draftUuid = doc.uuid;
          this.revision = same ? this.revision : notes.revision;
          this.draftError = false;
          this.draft = { revision: previous?.revision ?? this.revision, values: {
            ...previous?.values,
            bookId: entry.id, bookTitle: entry.title, bookText: entry.text,
            bookCategory: entry.category, bookSource: entry.source
          } };
          delete this.draft.values.legacyLoaded;
        } else {
          if (!this.own) throw new Error(t("noOwnNotebook"));
          if (this.draftError) throw new Error(t("draftError"));
          const legacy = this.draft.values.playerBody;
          this.draft.values = {
            ...(legacy ? { playerBody: legacy } : {}), bookId: foundry.utils.randomID(),
            ...(action === "bookLegacy" ? {
              bookTitle: t("generalSessionNote"), bookText: legacy ?? "", bookCategory: "general", bookSource: "reported",
              legacyLoaded: "true"
            } : {})
          };
        }
        this.drafts.save(this.own.uuid, this.draft.revision, this.draft.values);
      } else if (action === "bookSave") {
        const entry = {
          id: this.element.querySelector("[name=bookId]").value || foundry.utils.randomID(),
          title: this.element.querySelector("[name=bookTitle]").value.trim(),
          text: this.element.querySelector("[name=bookText]").value.trim(),
          category: this.element.querySelector("[name=bookCategory]").value,
          source: this.element.querySelector("[name=bookSource]").value
        };
        if (!entry.title || !entry.text) throw new Error(t("bookRequired"));
        const record = await playerNotesStore.saveEntry(this.own, this.revision, entry);
        this.acceptSave(record, true, true);
      } else if (action === "bookRemove") {
        const doc = playerNotesStore.list().find(doc => doc.id === target.dataset.notebook);
        if (!doc) throw new Error(t("missing"));
        if (!await DialogV2.confirm({
          window: { title: t("deleteBookEntry") }, content: `<p>${t("deleteBookWarning")}</p>`
        })) return;
        // Load the record's current revision only for another notebook with no visible editor.
        const record = await playerNotesStore.removeEntry(doc,
          doc.id === this.own?.id ? this.revision : playerNotesStore.read(doc).revision, target.dataset.entry);
        if (doc.id === this.own?.id) this.acceptSave(record, this.draft?.values.bookId === target.dataset.entry);
      } else if (target.dataset.action === "notesSelect") {
        this.selectedSession = target.dataset.id;
      } else if (target.dataset.action === "notesDiscard") {
        if (!await DialogV2.confirm({
          window: { title: t("unsaved") }, content: `<p>${t("discard")}</p>`
        })) return;
        if (this.own) this.drafts.remove(this.own.uuid);
        this.draft = null;
        this.draftError = false;
      }
      this.freshRender = true;
      await this.render({ force: true });
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      this.element.querySelectorAll("button, textarea, input, select").forEach(input => { input.disabled = false; });
      this.status();
    }

  }

  acceptSave(record, clearEntry, savedEntry = false) {
    this.revision = record.revision;
    this.draft = { revision: record.revision, values: { ...this.draft?.values } };
    if (clearEntry) {
      if (savedEntry && this.draft.values.legacyLoaded === "true") delete this.draft.values.playerBody;
      for (const key of ["bookId", "bookTitle", "bookText", "bookCategory", "bookSource", "legacyLoaded"]) delete this.draft.values[key];
    }
    try {
      if (!this.draftError) this.drafts.save(this.own.uuid, record.revision, this.draft.values);
    } catch (error) {
      this.draftError = true;
      this.report(new Error(`${t("draftError")} ${error.message}`));
    }
  }
}

let notesApp;
export function openPlayerNotes() {
  notesApp ??= new PlayerNotes();
  if (notesApp.rendered) return notesApp.bringToFront();
  return notesApp.render({ force: true });
}
