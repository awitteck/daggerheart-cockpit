import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Handlebars from "handlebars";
import { parseHTML } from "linkedom";
import { ID, SESSION_FIELDS, createRecord } from "../scripts/model.mjs";

let Cockpit;
let confirmation = true;
const hooks = new Map();
const errors = [];
globalThis.Hooks = { once: (name, callback) => hooks.set(name, callback) };
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class { _onRender() {} async close() { return true; } },
      HandlebarsApplicationMixin: Base => class extends Base {},
      DialogV2: { confirm: async () => confirmation }
    },
    ux: { TextEditor: { implementation: { getDragEventData: event => event.data } } }
  }
};
const disk = new Map();
globalThis.localStorage = {
  getItem: key => disk.get(key) ?? null,
  setItem: (key, value) => disk.set(key, value),
  removeItem: key => disk.delete(key)
};
globalThis.game = {
  world: { id: "world" },
  i18n: { localize: key => key },
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm" } },
  actors: [],
  folders: [],
  settings: { registerMenu: (id, key, options) => { Cockpit = options.type; } },
  keybindings: { register: () => {} }
};
globalThis.ui = { notifications: {
  error: message => errors.push(message), info: () => {}, warn: message => errors.push(message)
} };
let docs;
globalThis.fromUuid = async uuid => docs.find(doc => doc.uuid === uuid) ?? null;
globalThis.Folder = { create: async () => ({ id: "folder" }) };
globalThis.JournalEntry = { create: async data => document(data) };
await import("../scripts/main.mjs");
hooks.get("init")();
Handlebars.registerHelper("localize", key => game.i18n.localize(key));
const template = Handlebars.compile(await readFile(new URL("../templates/cockpit.hbs", import.meta.url), "utf8"));

function document(data) {
  const doc = {
    ...structuredClone(data), id: String(docs.length), uuid: `JournalEntry.${docs.length}`,
    getFlag: (scope, key) => doc.flags?.[scope]?.[key],
    pages: data.pages.map((page, index) => ({
      ...structuredClone(page), id: String(index), getFlag: (scope, key) => page.flags?.[scope]?.[key]
    })),
    updates: [],
    sheet: { render: async () => {} },
    update: async update => {
      doc.updates.push(update);
      if (doc.fail) throw new Error("Write failed");
      if (update.name) doc.name = update.name;
      doc.flags[ID].record = structuredClone(update[`flags.${ID}.record`]);
      doc.pages[0].text.content = update.pages[0]["text.content"];
    }
  };
  docs.push(doc);
  return doc;
}

function input(name, value = "", dataset = {}, type = "text") {
  return { name, value, dataset, type, checked: false, disabled: false, addEventListener() {} };
}

function setup() {
  disk.clear();
  errors.length = 0;
  confirmation = true;
  game.user.isGM = true;
  game.users.activeGM.id = "gm";
  docs = [];
  docs.get = id => docs.find(doc => doc.id === id);
  game.journal = docs;
  const doc = document({
    name: "One", flags: { [ID]: { record: createRecord("session", "One") } },
    pages: [{ name: "Notes", flags: { [ID]: { managed: true } }, text: { content: "" } }]
  });
  return { doc, app: makeApp(doc) };
}

function makeApp(doc) {
  const app = new Cockpit();
  app.selectedId = doc.id;
  app.baseline = doc.getFlag(ID, "record").revision;
  app.rendered = false;
  app.context = null;
  let controls = [];
  let status = { textContent: "" };
  app.control = name => controls.find(control => control.name === name);
  app.element = {
    addEventListener() {},
    querySelector: selector => selector === "[data-save-status]" ? status :
      controls.find(control => selector === `[name=${control.name}]`) ?? null,
    querySelectorAll: selector => {
      if (selector === "[data-note]") return controls.filter(control => control.dataset.note);
      if (selector === "[data-draft]") return controls.filter(control => control.dataset.draft);
      if (selector === "[data-summary-event]") return controls.filter(control => control.dataset.summaryEvent !== undefined);
      if (selector === "[data-summary-field]") return controls.filter(control => control.dataset.summaryField);
      if (selector === "[data-was-disabled]") return controls.filter(control => control.dataset.wasDisabled !== undefined);
      if (selector === "[data-card]") return [];
      if (selector === "input, textarea, select, button") return controls;
      return [];
    }
  };
  const rebuild = context => {
    controls = [
      ...context.fields.map(field => input(field.key, field.value, { note: field.key, draft: `note:${field.key}` })),
      input("event", "", { draft: "event" }),
      input("newName"), input("rename", context.selected?.name), input("search", context.query),
      input("thread", context.available[0]?.uuid ?? ""),
      ...context.record.events.map((event, index) =>
        input(`check${index}`, "", { draft: `summaryEvent:${index}`, summaryEvent: String(index) }, "checkbox")),
      input("checkConsequences", "", { draft: "summaryConsequences", summaryField: "consequences" }, "checkbox"),
      input("checkGoals", "", { draft: "summaryGoals", summaryField: "nextGoals" }, "checkbox")
    ];
    if (context.summaryReady) controls.push(
      input("summaryName", context.summaryName, { draft: "summaryName" }),
      input("summaryBody", "", { draft: "summaryBody" })
    );
    if (context.conversion) controls.push(
      input("conversionText", context.conversion.text, { draft: "conversionText" }),
      input("conversionType", "consequences", { draft: "conversionType" }),
      input("factTarget", context.factTargets[0]?.uuid ?? "", { draft: "factTarget" }),
      input("conversionName", "", { draft: "conversionName" })
    );
    status = { textContent: "" };
  };
  app.render = async () => {
    const context = await app._prepareContext();
    rebuild(context);
    app.context = context;
    app._onRender(context, {});
    app.rendered = true;
  };
  app.action = async (action, dataset = {}) =>
    Cockpit.action.call(app, {}, { dataset: { action, ...dataset } });
  app.status = () => status.textContent;
  return app;
}

async function quiet(operation) {
  const original = console.error;
  console.error = () => {};
  try { await operation(); } finally { console.error = original; }
}

test("views change visibility without losing notes or quick drafts", async () => {
  const { app } = setup();
  await app.render();
  app.control("opening").value = "Opening draft";
  app.control("event").value = "Unfinished note";
  await app.action("view", { view: "play" });
  assert.ok(app.context.fields.every(field => field.hidden));
  assert.equal(app.control("opening").value, "Opening draft");
  assert.equal(app.control("event").value, "Unfinished note");
  await app.action("view", { view: "after" });
  assert.deepEqual(app.context.fields.filter(field => !field.hidden).map(field => field.key),
    ["consequences", "feedback", "nextGoals"]);
  assert.equal(app.control("opening").value, "Opening draft");
});

test("a browser reload restores notes and quick input with the original revision", async () => {
  const { app, doc } = setup();
  await app.render();
  app.control("opening").value = "Draft";
  app.control("event").value = "Quick note";
  app.captureDraft();
  const next = makeApp(doc);
  await next.render();
  assert.equal(next.control("opening").value, "Draft");
  assert.equal(next.control("event").value, "Quick note");
  assert.equal(next.baseline, 0);
  assert.equal(next.dirty, true);
  assert.equal(next.status(), "DHC.draftSaved");
});

test("the event action atomically persists notes and event and clears only saved input", async () => {
  const { app, doc } = setup();
  await app.render();
  app.control("opening").value = "At the river";
  app.control("event").value = "Rescued scout";
  await app.action("addEvent");
  assert.equal(doc.updates.length, 1);
  const record = doc.getFlag(ID, "record");
  assert.equal(record.opening, "At the river");
  assert.equal(record.events[0].text, "Rescued scout");
  assert.match(doc.pages[0].text.content, /At the river/);
  assert.equal(app.control("event").value, "");
  assert.equal(app.baseline, 1);
  assert.equal(app.dirty, false);
  await app.action("save");
  assert.equal(doc.updates.length, 2);
});

test("restored stale drafts cannot append events or overwrite newer journals", async () => {
  const { app, doc } = setup();
  await app.render();
  app.control("opening").value = "Draft";
  app.control("event").value = "Old event";
  app.captureDraft();
  doc.flags[ID].record.revision = 1;
  doc.flags[ID].record.opening = "New journal text";
  const next = makeApp(doc);
  await next.render();
  assert.equal(next.context.stale, true);
  await quiet(() => next.action("addEvent"));
  assert.equal(doc.updates.length, 0);
  assert.equal(next.control("event").value, "Old event");
  assert.equal(errors.at(-1), "DHC.conflict");
  confirmation = false;
  await next.action("refresh");
  assert.equal(next.control("opening").value, "Draft");
  confirmation = true;
  await next.action("refresh");
  assert.equal(next.control("opening").value, "New journal text");
  assert.equal(next.control("event").value, "");
  assert.equal(next.baseline, 1);
});

test("failed journal writes retain input, report errors and allow retry", async () => {
  const { app, doc } = setup();
  await app.render();
  app.control("opening").value = "Draft";
  doc.fail = true;
  await quiet(() => app.action("save"));
  assert.equal(app.control("opening").value, "Draft");
  assert.equal(errors.at(-1), "Write failed");
  assert.equal(app.busy, false);
  doc.fail = false;
  await app.action("save");
  assert.equal(doc.getFlag(ID, "record").opening, "Draft");
});

test("search and archive toggle filter records, rename persists without deleting notes", async () => {
  const { app, doc } = setup();
  await app.render();
  app.control("opening").value = "River";
  app.control("rename").value = "Renamed";
  await app.action("rename");
  assert.equal(doc.name, "Renamed");
  app.control("search").value = "river";
  await app.action("search");
  assert.equal(app.context.sessions.length, 1);
  await app.action("archive");
  assert.equal(app.context.sessions.length, 0);
  await app.action("archives");
  assert.equal(app.context.sessions.length, 1);
  await app.action("archive");
  assert.equal(doc.flags[ID].record.archived, false);
});

test("thread cards show facts, resolved status and highlights; removing a card removes its highlight", async () => {
  const { app, doc } = setup();
  const thread = document({
    name: "Scout", flags: { [ID]: { record: { ...createRecord("thread", "Scout"), facts: "Free", status: "resolved" } } },
    pages: [{ flags: { [ID]: { managed: true } }, text: { content: "" } }]
  });
  doc.flags[ID].record.threads = [thread.uuid, "JournalEntry.missing"];
  await app.render();
  assert.equal(app.context.attached[0].fields[0].value, "Free");
  assert.equal(app.context.attached[0].resolved, true);
  assert.equal(app.context.attached[1].missing, true);
  await app.action("feature", { uuid: thread.uuid });
  assert.equal(app.context.attached[0].featured, true);
  await app.action("detachThread", { uuid: thread.uuid });
  assert.deepEqual(doc.flags[ID].record.featured, []);
});

test("event conversion requires confirmation and appends reviewed text", async () => {
  const { app, doc } = setup();
  doc.flags[ID].record.events = [{ time: "now", text: "Scout rescued" }];
  doc.flags[ID].record.consequences = "Existing";
  await app.render();
  await app.action("convertEvent", { index: "0" });
  app.control("conversionText").value = "Captain searches for us";
  confirmation = false;
  await app.action("applyConversion");
  assert.equal(doc.flags[ID].record.consequences, "Existing");
  confirmation = true;
  await app.action("applyConversion");
  assert.equal(doc.flags[ID].record.consequences, "Existing\nCaptain searches for us");
  assert.equal(doc.flags[ID].record.events[0].text, "Scout rescued");
  assert.equal(app.context.conversion, null);
});

test("conversion can create a new thread with reviewed facts and preserve source events", async () => {
  const { app, doc } = setup();
  doc.flags[ID].record.events = [{ time: "now", text: "Scout rescued" }];
  await app.render();
  await app.action("convertEvent", { index: "0" });
  app.control("conversionType").value = "newThread";
  app.control("conversionName").value = "The missing sister";
  await app.action("applyConversion");
  const thread = docs.find(doc => doc.name === "The missing sister");
  assert.equal(thread.flags[ID].record.facts, "Scout rescued");
  assert.equal(doc.flags[ID].record.events.length, 1);
});

test("conversion appends to next-session goals or facts on a selected existing thread", async () => {
  const { app, doc } = setup();
  const thread = document({
    name: "Scout", flags: { [ID]: { record: { ...createRecord("thread", "Scout"), facts: "Already known" } } },
    pages: [{ flags: { [ID]: { managed: true } }, text: { content: "" } }]
  });
  doc.flags[ID].record.events = [{ time: "now", text: "Scout rescued" }];
  await app.render();
  await app.action("convertEvent", { index: "0" });
  app.control("conversionType").value = "nextGoals";
  app.control("conversionText").value = "Visit the river";
  await app.action("applyConversion");
  assert.equal(doc.flags[ID].record.nextGoals, "Visit the river");
  await app.action("convertEvent", { index: "0" });
  app.control("conversionType").value = "facts";
  app.control("factTarget").value = thread.uuid;
  await app.action("applyConversion");
  assert.equal(thread.flags[ID].record.facts, "Already known\nScout rescued");
  assert.equal(doc.flags[ID].record.events.length, 1);
});

test("conversion text and preview survive a reload and replacements require confirmation", async () => {
  const { app, doc } = setup();
  doc.flags[ID].record.events = [{ time: "now", text: "First" }, { time: "now", text: "Second" }];
  await app.render();
  await app.action("convertEvent", { index: "0" });
  app.control("conversionText").value = "Reviewed";
  app.control("check0").checked = true;
  await app.action("previewSummary");
  app.control("summaryBody").value = "Reviewed summary";
  app.captureDraft();
  const next = makeApp(doc);
  await next.render();
  assert.equal(next.control("conversionText").value, "Reviewed");
  assert.equal(next.control("summaryBody").value, "Reviewed summary");
  confirmation = false;
  await next.action("convertEvent", { index: "1" });
  assert.equal(next.control("conversionText").value, "Reviewed");
  await next.action("previewSummary");
  assert.equal(next.control("summaryBody").value, "Reviewed summary");
});

test("broken local storage is reported, retains in-memory input and can block closing", async () => {
  const { app } = setup();
  await app.render();
  const originalStorage = globalThis.localStorage;
  app.draftStorage = null;
  globalThis.localStorage = {
    getItem: key => disk.get(key) ?? null,
    setItem: () => { throw new Error("quota"); }
  };
  try {
    app.control("opening").value = "Unsaved";
    app.dirty = true;
    await quiet(() => app.captureDraft());
    assert.equal(app.status(), "DHC.draftUnavailable");
    assert.match(errors.at(-1), /draftError/);
    confirmation = false;
    assert.equal(await app.close(), undefined);
    assert.equal(app.control("opening").value, "Unsaved");
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("corrupt persisted drafts are not overwritten by render or input", async () => {
  const { app, doc } = setup();
  disk.set(app.drafts.key(doc.uuid), "{");
  await quiet(() => app.render());
  app.control("opening").value = "New input";
  app.captureDraft();
  assert.equal(disk.get(app.drafts.key(doc.uuid)), "{");
  assert.equal(app.status(), "DHC.draftUnavailable");
  assert.equal(app.draftCache.get(doc.uuid).values["note:opening"], "New input");
});

test("publication uses selected content and reviewed preview only, never GM fields", async () => {
  const { app, doc } = setup();
  Object.assign(doc.flags[ID].record, {
    events: [{ time: "now", text: "Public event" }, { time: "now", text: "Secret event" }],
    motives: "Secret motive", escalations: "Secret escalation", consequences: "Secret consequence"
  });
  await app.render();
  app.control("check0").checked = true;
  await app.action("previewSummary");
  assert.equal(app.control("summaryBody").value, "Public event");
  app.control("summaryBody").value = "Reviewed public text";
  confirmation = false;
  await app.action("publishSummary");
  assert.equal(docs.length, 1);
  confirmation = true;
  await app.action("publishSummary");
  assert.equal(docs.length, 2);
  const published = docs[1];
  assert.deepEqual(published.ownership, { default: 2 });
  assert.equal(published.flags, undefined);
  assert.equal(published.pages[0].text.content, "<p>Reviewed public text</p>");
  assert.equal(doc.flags[ID].record.escalations, "Secret escalation");
  assert.equal(app.context.summaryReady, false);
});

test("other GMs cannot save, convert or publish", async () => {
  const { app, doc } = setup();
  game.users.activeGM.id = "other";
  await app.render();
  await quiet(() => app.action("save"));
  assert.equal(doc.updates.length, 0);
  assert.equal(app.context.writer, false);
  assert.equal(errors.at(-1), "DHC.primaryGM");
});

test("busy UI does not launch overlapping operations", async () => {
  const { app } = setup();
  await app.render();
  app.busy = true;
  let called = false;
  await app.perform(async () => { called = true; });
  assert.equal(called, false);
});

test("real template and DOM restore drafts, switch views and save an event", async () => {
  const { app, doc } = setup();
  app.render = async () => {
    const context = await app._prepareContext();
    const { document } = parseHTML(`<html><body><form>${template(context)}</form></body></html>`);
    app.element = document.querySelector("form");
    app.context = context;
    app._onRender(context, {});
    app.rendered = true;
  };
  await app.render();
  let opening = app.element.querySelector("[data-note=opening]");
  opening.value = "Real DOM draft";
  opening.dispatchEvent(new opening.ownerDocument.defaultView.Event("input"));
  assert.match(app.element.querySelector("[data-save-status]").textContent, /draftSaved/);
  await app.action("view", { view: "play" });
  opening = app.element.querySelector("[data-note=opening]");
  assert.ok(opening.closest("label").hasAttribute("hidden"));
  assert.equal(opening.value, "Real DOM draft");
  const event = app.element.querySelector("[name=event]");
  event.value = "Real event";
  await app.action("addEvent");
  assert.equal(doc.flags[ID].record.opening, "Real DOM draft");
  assert.equal(doc.flags[ID].record.events[0].text, "Real event");
  assert.equal(app.element.querySelector("[name=event]").value, "");
  assert.equal(app.element.querySelector("[data-save-status]").textContent, "DHC.journalSaved");
});

test("actual template escapes notes and offers no publication controls to other GMs", async () => {
  const { app, doc } = setup();
  doc.name = "<script>bad</script>";
  doc.flags[ID].record.opening = "</textarea><script>bad</script>";
  game.users.activeGM.id = "other";
  const context = await app._prepareContext();
  const { document } = parseHTML(`<html><body>${template(context)}</body></html>`);
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.equal(document.querySelector("[data-action=publishSummary]"), null);
  assert.equal(document.querySelector("[data-action=convertEvent]"), null);
  assert.ok(document.querySelector("fieldset").hasAttribute("disabled"));
});

test("pinned links identify every supported document type despite identical names", async () => {
  const { app, doc } = setup();
  const types = {
    Actor: "documentActor", JournalEntry: "documentJournal", JournalEntryPage: "documentPage",
    Scene: "documentScene", RollTable: "documentTable"
  };
  for (const documentName of Object.keys(types)) {
    const linked = {
      id: documentName, uuid: `${documentName}.linked`, documentName, name: "Same name",
      getFlag: () => undefined
    };
    docs.push(linked);
    doc.flags[ID].record.links.push(linked.uuid);
  }
  const thread = document({
    name: "Thread", flags: { [ID]: { record: {
      ...createRecord("thread", "Thread"), links: ["Scene.linked"]
    } } },
    pages: [{ flags: { [ID]: { managed: true } }, text: { content: "" } }]
  });
  doc.flags[ID].record.threads.push(thread.uuid);
  doc.flags[ID].record.links.push("Scene.deleted");
  const context = await app._prepareContext();
  const { document: dom } = parseHTML(`<html><body>${template(context)}</body></html>`);
  for (const [type, key] of Object.entries(types)) {
    const button = dom.querySelector(`[data-action=openLink][data-uuid="${type}.linked"]`);
    assert.equal(button.querySelector(".dhc-document-name").textContent, "Same name");
    assert.equal(button.querySelector(".dhc-document-type").textContent, `DHC.${key}`);
    assert.equal(button.querySelector("i").getAttribute("aria-hidden"), "true");
  }
  assert.equal(dom.querySelectorAll('[data-uuid="Scene.linked"] .dhc-document-type').length, 2);
  assert.equal(dom.querySelector('[data-action=openLink][data-uuid="Scene.deleted"]'), null);
});

test("metadata and translation keys cover both languages and all note fields", async () => {
  const manifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, ID);
  assert.equal(manifest.manifest, "https://github.com/awitteck/daggerheart-cockpit/releases/latest/download/module.json");
  assert.equal(manifest.download, `https://github.com/awitteck/daggerheart-cockpit/releases/download/v${manifest.version}/daggerheart-cockpit-${manifest.version}.zip`);
  for (const path of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(lang => lang.path)]) {
    assert.ok((await readFile(new URL(`../${path}`, import.meta.url))).length > 0);
  }
  const source = await readFile(new URL("../scripts/main.mjs", import.meta.url), "utf8");
  const template = await readFile(new URL("../templates/cockpit.hbs", import.meta.url), "utf8");
  const keys = [
    ...Array.from(source.matchAll(/\bt\("([^"]+)"\)/g), match => match[1]),
    ...Array.from((source + template).matchAll(/DHC\.([A-Za-z]+)/g), match => match[1]),
    ...SESSION_FIELDS, "prep", "play", "after"
  ];
  const de = JSON.parse(await readFile(new URL("../lang/de.json", import.meta.url), "utf8")).DHC;
  const en = JSON.parse(await readFile(new URL("../lang/en.json", import.meta.url), "utf8")).DHC;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const key of keys) {
    assert.ok(de[key], `Missing German key ${key}`);
    assert.ok(en[key], `Missing English key ${key}`);
  }
});
