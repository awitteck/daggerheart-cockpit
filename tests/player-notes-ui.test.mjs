import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { parseHTML } from "linkedom";
import { ID } from "../scripts/model.mjs";

const errors = [];
let confirm = true;
globalThis.game = { world: { id: "world" }, user: { id: "one", isGM: false }, i18n: { localize: key => key } };
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

function notebook(id, userId, body = "", sessionId = "session") {
  const doc = {
    id, uuid: `JournalEntry.${id}`,
    record: { version: 2, revision: 0, sessionId, sessionName: sessionId, userId, authorName: userId, body, entries: [] },
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
    // LinkeDOM lacks the browser's HTMLSelectElement.value setter.
    view.element.querySelectorAll("select").forEach(select => {
      let value = select.value ?? select.querySelector("option")?.value ?? "";
      Object.defineProperty(select, "value", { get: () => value, set: next => { value = next; } });
    });
    view.context = context;
    view._onRender(context, {});
    view.rendered = true;
  };
  view.action = async (action, dataset = {}) => PlayerNotes.action.call(view, {}, { dataset: { action, ...dataset } });
  view.field = name => view.element.querySelector(`[name=${name}]`);
  return view;
}

function setup() {
  disk.clear(); errors.length = 0; confirm = true;
  game.user = { id: "one", isGM: false };
  const mine = notebook("mine", "one");
  const other = notebook("other", "two", "<script>not executable</script>");
  game.journal = [mine, other];
  return { mine, other, view: app() };
}

async function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = original; }
}

test("one form saves all categories, including general session contributions", async () => {
  const { view, mine, other } = setup();
  await view.render();
  assert.equal(view.element.querySelectorAll("textarea").length, 1);
  assert.equal(view.field("playerBody"), null);
  assert.equal(view.element.querySelector("[data-action=notesSave]"), null);
  assert.equal(view.element.querySelectorAll("script").length, 0);
  assert.match(view.element.textContent, /not executable/);
  for (const category of ["general", "person", "place", "clue", "agreement"]) {
    view.field("bookTitle").value = category;
    view.field("bookText").value = `Text ${category}`;
    view.field("bookCategory").value = category;
    view.field("bookSource").value = "theory";
    await view.action("bookSave");
    assert.equal(view.field("bookText").value, "");
  }
  assert.equal(mine.record.entries.length, 5);
  assert.equal(mine.record.body, "");
  assert.equal(mine.record.version, 3);
  assert.equal(other.updates, 0);
  assert.equal(view.element.querySelector("[data-save-status]").textContent, "DHC.journalSaved");
});

test("one editor restores drafts across sessions, reload and contribution refresh", async () => {
  const { view } = setup();
  game.journal.push(notebook("second", "one", "", "secondSession"));
  view.selectedSession = "session";
  await view.render();
  view.field("bookTitle").value = "Draft";
  view.field("bookText").value = "Local text";
  view.field("bookCategory").value = "general";
  view.capture();
  const restored = app();
  restored.selectedSession = "session";
  await restored.render();
  assert.equal(restored.field("bookText").value, "Local text");
  await restored.action("notesRefresh");
  assert.equal(restored.field("bookText").value, "Local text");
  await restored.action("notesSelect", { id: "secondSession" });
  assert.equal(restored.field("bookText").value, "");
  await restored.action("notesSelect", { id: "session" });
  assert.equal(restored.field("bookCategory").value, "general");
  assert.equal(restored.field("bookText").value, "Local text");
});

test("existing free text appears as an editable general entry without losing original data", async () => {
  const { view, mine } = setup();
  mine.record.body = "Old contribution";
  await view.render();
  const group = view.context.groups.find(group => group.entries.some(entry => entry.text === "Old contribution"));
  assert.ok(group);
  const entry = group.entries.find(entry => entry.text === "Old contribution");
  assert.equal(entry.category, "general");
  assert.equal(mine.record.body, "Old contribution");
  await view.action("bookEdit", { notebook: mine.id, entry: entry.id });
  assert.equal(view.field("bookText").value, "Old contribution");
  view.field("bookText").value = "Revised contribution";
  await view.action("bookSave");
  assert.equal(mine.record.body, "");
  assert.equal(mine.record.entries.length, 1);
  assert.equal(mine.record.entries[0].text, "Revised contribution");
});

test("stale drafts and failed writes preserve input; discard explicitly resets editor", async () => {
  const { view, mine } = setup();
  await view.render();
  view.field("bookTitle").value = "Draft";
  view.field("bookText").value = "Unsaved";
  mine.fail = true;
  await quiet(() => view.action("bookSave"));
  assert.equal(errors.at(-1), "disk");
  assert.equal(view.field("bookText").value, "Unsaved");
  mine.fail = false;
  mine.record.revision++;
  const restored = app();
  await restored.render();
  assert.equal(restored.context.stale, true);
  await quiet(() => restored.action("bookSave"));
  assert.equal(errors.at(-1), "DHC.conflict");
  confirm = false;
  await restored.action("notesDiscard");
  assert.equal(restored.field("bookText").value, "Unsaved");
  confirm = true;
  await restored.action("notesDiscard");
  assert.equal(restored.field("bookText").value, "");
  assert.equal(mine.updates, 0);
});

test("edit, search and confirmed delete use the same entry model", async () => {
  const { view, mine } = setup();
  await view.render();
  view.field("bookTitle").value = "Ylva";
  view.field("bookText").value = "Suspicious";
  view.field("bookCategory").value = "person";
  await view.action("bookSave");
  const id = mine.record.entries[0].id;
  await view.action("bookEdit", { notebook: mine.id, entry: id });
  view.field("bookText").value = "Helped us";
  await view.action("bookSave");
  assert.equal(mine.record.entries.length, 1);
  assert.equal(mine.record.entries[0].text, "Helped us");
  view.field("bookSearch").value = "ylva";
  await view.action("bookSearch");
  assert.equal(view.context.groups.flatMap(group => group.entries).length, 1);
  // The other player's migrated general contribution does not match this search.
  assert.ok(view.context.groups.some(group => group.entries.some(entry => entry.title === "Ylva")));
  confirm = false;
  await view.action("bookRemove", { notebook: mine.id, entry: id });
  assert.equal(mine.record.entries.length, 1);
  confirm = true;
  await view.action("bookRemove", { notebook: mine.id, entry: id });
  assert.equal(mine.record.entries.length, 0);
});

test("players cannot edit other authors; readers without notebooks get no editor", async () => {
  const { view, other } = setup();
  await view.render();
  await quiet(() => view.action("bookEdit", { notebook: other.id, entry: "legacy-session-note" }));
  assert.equal(errors.at(-1), "DHC.ownNotesOnly");
  game.user = { id: "third", isGM: false };
  const reader = app();
  await reader.render();
  assert.equal(reader.field("bookText"), null);
  assert.equal(reader.element.querySelector("[data-action=bookSave]"), null);
});

test("old unsaved free text drafts are recoverable without overwriting a simultaneous entry draft", async () => {
  const { view, mine } = setup();
  const key = `${ID}:draft:world:one:${encodeURIComponent(mine.uuid)}`;
  disk.set(key, JSON.stringify({ version: 1, revision: 0, values: {
    playerBody: "Old unsaved text", bookTitle: "Other draft", bookText: "Other text"
  } }));
  await view.render();
  assert.equal(view.context.legacyDraft, true);
  confirm = false;
  await view.action("bookLegacy");
  assert.equal(view.field("bookText").value, "Other text");
  confirm = true;
  await view.action("bookLegacy");
  assert.equal(view.field("bookText").value, "Old unsaved text");
  assert.equal(view.field("bookCategory").value, "general");
  await view.action("bookSave");
  assert.equal(mine.record.entries[0].text, "Old unsaved text");
  assert.equal(view.context.legacyDraft, false);
});

test("corrupt drafts are not overwritten until explicitly discarded", async () => {
  const { view, mine } = setup();
  const key = `${ID}:draft:world:one:${encodeURIComponent(mine.uuid)}`;
  disk.set(key, "{");
  await quiet(() => view.render());
  view.field("bookText").value = "Input";
  view.capture();
  assert.equal(disk.get(key), "{");
  await view.action("notesDiscard");
  assert.equal(view.draftError, false);
});

test("old stored baseline text is not offered as a duplicate unsaved contribution", async () => {
  const { view, mine } = setup();
  mine.record.body = "Previously saved";
  const key = `${ID}:draft:world:one:${encodeURIComponent(mine.uuid)}`;
  disk.set(key, JSON.stringify({ version: 1, revision: 0, values: { playerBody: mine.record.body } }));
  await view.render();
  assert.equal(view.context.legacyDraft, false);
  assert.equal(view.context.groups.flatMap(group => group.entries).filter(entry => entry.text === mine.record.body).length, 1);
});

test("switching from a recovered draft to a saved entry does not consume the recovered text", async () => {
  const { view, mine } = setup();
  mine.record.entries = [{ id: "saved", title: "Saved", text: "Existing", category: "clue", source: "theory", updated: "" }];
  const key = `${ID}:draft:world:one:${encodeURIComponent(mine.uuid)}`;
  disk.set(key, JSON.stringify({ version: 1, revision: 0, values: { playerBody: "Recover me" } }));
  await view.render();
  await view.action("bookLegacy");
  await view.action("bookEdit", { notebook: mine.id, entry: "saved" });
  await view.action("bookSave");
  assert.equal(view.context.legacyDraft, true);
  await view.action("bookLegacy");
  assert.equal(view.field("bookText").value, "Recover me");
});

test("editing another session preserves the current draft and uses the entry's origin session", async () => {
  const { view, mine } = setup();
  const previous = notebook("previous", "one", "", "oldSession");
  previous.record.entries = [{ id: "past", title: "Past", text: "Earlier note", category: "general", source: "observed", updated: "" }];
  game.journal.push(previous);
  view.selectedSession = "session";
  await view.render();
  view.field("bookTitle").value = "Current";
  view.field("bookText").value = "Current draft";
  await view.action("bookEdit", { notebook: previous.id, entry: "past" });
  assert.equal(view.selectedSession, "oldSession");
  view.field("bookText").value = "Updated past";
  await view.action("bookSave");
  assert.equal(previous.record.entries[0].text, "Updated past");
  assert.equal(mine.updates, 0);
  await view.action("notesSelect", { id: "session" });
  assert.equal(view.field("bookText").value, "Current draft");
});
