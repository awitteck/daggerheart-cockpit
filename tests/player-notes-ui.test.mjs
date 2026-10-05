import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { parseHTML } from "linkedom";
import { ID } from "../scripts/model.mjs";

const errors = [];
let confirm = true;
globalThis.game = {
  world: { id: "world" }, user: { id: "one", isGM: false },
  i18n: { localize: key => key }
};
globalThis.foundry = {
  utils: { randomID: () => `entry${Math.random().toString(36).slice(2)}` },
  applications: { api: {
    ApplicationV2: class { _onRender() {} async close() { return true; } },
    HandlebarsApplicationMixin: Base => class extends Base {},
    DialogV2: { confirm: async () => confirm }
  } }
};
globalThis.ui = { notifications: { error: message => errors.push(message) } };
const disk = new Map();
globalThis.localStorage = {
  getItem: key => disk.get(key) ?? null,
  setItem: (key, value) => disk.set(key, value),
  removeItem: key => disk.delete(key)
};
const { PlayerNotes } = await import("../scripts/player-notes-ui.mjs");
Handlebars.registerHelper("localize", key => key);
const template = Handlebars.compile(await readFile(new URL("../templates/player-notes.hbs", import.meta.url), "utf8"));

function notebook(id, userId, body, sessionId = "session") {
  const doc = {
    id, uuid: `JournalEntry.${id}`,
    record: { version: 1, revision: 0, sessionId, sessionName: sessionId, userId, authorName: userId, body },
    getFlag: (scope, key) => key === "playerNotes" ? doc.record : undefined,
    testUserPermission: user => user.id === userId,
    pages: [{ id: "page", getFlag: (scope, key) => key === "playerNotesPage" }],
    html: "", updates: 0,
    update: async update => {
      if (doc.fail) throw new Error("disk");
      doc.record = structuredClone(update[`flags.${ID}.playerNotes`]);
      doc.html = update.pages[0]["text.content"];
      doc.updates++;
    }
  };
  return doc;
}

function app() {
  const view = new PlayerNotes();
  view.render = async () => {
    const context = await view._prepareContext();
    const { document } = parseHTML(`<html><body><form>${template(context)}</form></body></html>`);
    view.element = document.querySelector("form");
    // LinkeDOM lacks HTMLSelectElement.value's browser setter.
    view.element.querySelectorAll("select").forEach(select => {
      let value = select.value ?? select.querySelector("option")?.value ?? "";
      Object.defineProperty(select, "value", {
        get: () => value,
        set: next => { value = next; }
      });
    });
    view.context = context;
    view._onRender(context, {});
    view.rendered = true;
  };
  view.action = async (action, dataset = {}) =>
    PlayerNotes.action.call(view, {}, { dataset: { action, ...dataset } });
  view.body = () => view.element.querySelector("[name=playerBody]");
  return view;
}

function setup() {
  disk.clear(); errors.length = 0; confirm = true;
  game.user = { id: "one", isGM: false };
  const mine = notebook("mine", "one", "Saved");
  const other = notebook("other", "two", "<script>not executable</script>");
  game.journal = [mine, other];
  return { mine, other, view: app() };
}

async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = original; }
}

test("real player template shows shared notes and edits only the current player's contribution", async () => {
  const { view, mine, other } = setup();
  await view.render();
  assert.equal(view.element.querySelectorAll("textarea").length, 2);
  assert.equal(view.element.querySelectorAll("script").length, 0);
  assert.match(view.element.textContent, /not executable/);
  view.body().value = "My theory, not a GM fact";
  await view.action("notesSave");
  assert.equal(mine.record.body, "My theory, not a GM fact");
  assert.equal(other.updates, 0);
  assert.match(mine.html, /My theory/);
  assert.equal(view.element.querySelector("[data-save-status]").textContent, "DHC.journalSaved");
});

test("unsaved player drafts survive reload, switching sessions and refreshing other contributions", async () => {
  const { view, mine, other } = setup();
  game.journal.push(notebook("second", "one", "Second", "secondSession"));
  view.selectedSession = "session";
  await view.render();
  view.body().value = "Local draft";
  const EventClass = view.body().ownerDocument.defaultView.Event;
  view.body().dispatchEvent(new EventClass("input"));
  const restored = app();
  restored.selectedSession = "session";
  await restored.render();
  assert.equal(restored.body().value, "Local draft");
  other.record.body = "Updated by another player";
  await restored.action("notesRefresh");
  assert.equal(restored.body().value, "Local draft");
  assert.match(restored.element.textContent, /Updated by another player/);
  await restored.action("notesSelect", { id: "secondSession" });
  assert.equal(restored.body().value, "Second");
  await restored.action("notesSelect", { id: "session" });
  assert.equal(restored.body().value, "Local draft");
  assert.equal(mine.record.body, "Saved");
});

test("stale player drafts are rejected until explicitly discarded", async () => {
  const { view, mine } = setup();
  await view.render();
  view.body().value = "Stale";
  view.capture();
  mine.record.revision = 1;
  mine.record.body = "New saved text";
  const restored = app();
  await restored.render();
  assert.equal(restored.context.stale, true);
  await quiet(() => restored.action("notesSave"));
  assert.equal(errors.at(-1), "DHC.conflict");
  assert.equal(mine.updates, 0);
  confirm = false;
  await restored.action("notesDiscard");
  assert.equal(restored.body().value, "Stale");
  confirm = true;
  await restored.action("notesDiscard");
  assert.equal(restored.body().value, "New saved text");
  assert.equal(restored.revision, 1);
});

test("journal failures preserve input and users without notebooks see no write controls", async () => {
  const { view, mine } = setup();
  await view.render();
  view.body().value = "Unsaved";
  mine.fail = true;
  await quiet(() => view.action("notesSave"));
  assert.equal(errors.at(-1), "disk");
  assert.equal(view.body().value, "Unsaved");
  assert.equal(view.busy, false);
  game.user = { id: "third", isGM: false };
  const reader = app();
  await reader.render();
  assert.equal(reader.body(), null);
  assert.equal(reader.element.querySelector("[data-action=notesSave]"), null);
});

test("real campaign book form creates, edits, searches and deletes categorized entries", async () => {
  const { view, mine, other } = setup();
  await view.render();
  const field = name => view.element.querySelector(`[name=${name}]`);
  field("bookTitle").value = "Ylva";
  field("bookText").value = "Might know the orcs";
  field("bookCategory").value = "person";
  field("bookSource").value = "theory";
  view.body().value = "Unsaved session note";
  await view.action("bookSave");
  assert.equal(mine.record.entries.length, 1);
  assert.equal(mine.record.entries[0].category, "person");
  assert.equal(mine.record.entries[0].source, "theory");
  assert.equal(view.body().value, "Unsaved session note");
  const id = mine.record.entries[0].id;
  await view.action("bookEdit", { notebook: mine.id, entry: id });
  assert.equal(field("bookTitle").value, "Ylva");
  field("bookText").value = "Helped us";
  field("bookSource").value = "observed";
  await view.action("bookSave");
  assert.equal(mine.record.entries.length, 1);
  assert.equal(mine.record.entries[0].text, "Helped us");
  assert.equal(mine.record.entries[0].source, "observed");
  field("bookSearch").value = "ylva";
  await view.action("bookSearch");
  assert.equal(view.context.groups[0].entries.length, 1);
  field("bookSearch").value = "not found";
  await view.action("bookSearch");
  assert.equal(view.context.groups.length, 0);
  confirm = false;
  await view.action("bookRemove", { notebook: mine.id, entry: id });
  assert.equal(mine.record.entries.length, 1);
  confirm = true;
  await view.action("bookRemove", { notebook: mine.id, entry: id });
  assert.equal(mine.record.entries.length, 0);
  assert.equal(view.body().value, "Unsaved session note");
  assert.equal(other.updates, 0);
});

test("campaign entries across sessions are grouped, attributed and restricted to their author", async () => {
  const { view, mine, other } = setup();
  const later = notebook("later", "one", "", "laterSession");
  mine.record.version = 2;
  mine.record.entries = [{ id: "a", title: "Zed", text: "NPC", category: "person", source: "reported", updated: "now" }];
  other.record.version = 2;
  other.record.entries = [{ id: "b", title: "Arne", text: "NPC", category: "person", source: "observed", updated: "now" }];
  later.record.version = 2;
  later.record.entries = [{ id: "c", title: "River", text: "Place", category: "place", source: "theory", updated: "now" }];
  game.journal.push(later);
  view.selectedSession = "session";
  await view.render();
  assert.deepEqual(view.context.groups[0].entries.map(entry => entry.title), ["Arne", "Zed"]);
  assert.equal(view.context.groups[0].entries[0].editable, false);
  assert.equal(view.context.groups[1].entries[0].sessionName, "laterSession");
  assert.equal(view.element.querySelector('[data-action=bookEdit][data-notebook=other]'), null);
  await quiet(() => view.action("bookEdit", { notebook: other.id, entry: "b" }));
  assert.equal(errors.at(-1), "DHC.ownNotesOnly");
  await view.action("bookEdit", { notebook: later.id, entry: "c" });
  assert.equal(view.selectedSession, "laterSession");
  assert.equal(view.element.querySelector("[name=bookTitle]").value, "River");
});

test("categorized entry drafts restore after reload and stale saves are rejected", async () => {
  const { view, mine } = setup();
  await view.render();
  view.element.querySelector("[name=bookTitle]").value = "Draft place";
  view.element.querySelector("[name=bookText]").value = "Description";
  view.element.querySelector("[name=bookCategory]").value = "place";
  view.element.querySelector("[name=bookSource]").value = "reported";
  view.capture();
  const restored = app();
  await restored.render();
  assert.equal(restored.element.querySelector("[name=bookTitle]").value, "Draft place");
  assert.equal(restored.element.querySelector("[name=bookCategory]").value, "place");
  mine.record.revision++;
  await quiet(() => restored.action("bookSave"));
  assert.equal(errors.at(-1), "DHC.conflict");
  assert.equal(restored.element.querySelector("[name=bookText]").value, "Description");
  assert.equal(mine.updates, 0);
});

test("corrupt player drafts are reported and not overwritten until explicit discard", async () => {
  const { view, mine } = setup();
  const key = `${ID}:draft:world:one:${encodeURIComponent(mine.uuid)}`;
  disk.set(key, "{");
  await quiet(() => view.render());
  assert.equal(view.draftError, true);
  view.body().value = "Fresh input";
  view.capture();
  assert.equal(disk.get(key), "{");
  await view.action("notesDiscard");
  assert.equal(view.body().value, "Saved");
  assert.equal(view.draftError, false);
});
