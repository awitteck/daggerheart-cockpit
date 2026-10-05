import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createRecord, validateRecord, updateFields, journalHTML, ID, VERSION, upgradeRecord, matchesSearch, publicHTML, appendNote } from "../scripts/model.mjs";
import { CockpitStore } from "../scripts/store.mjs";

function setup() {
  const docs = [];
  let writer = true;
  let fail = false;
  const env = {
    journals: () => docs,
    localize: key => key,
    assertWriter: () => { if (!writer) throw new Error("primaryGM"); },
    folder: async () => "folder",
    createJournal: async data => {
      const doc = {
        ...structuredClone(data), id: String(docs.length), uuid: `JournalEntry.${docs.length}`,
        getFlag: (scope, key) => doc.flags?.[scope]?.[key],
        pages: data.pages.map((page, index) => ({
          ...page, id: String(index), getFlag: (scope, key) => page.flags?.[scope]?.[key]
        })),
        update: async update => {
          await Promise.resolve();
          if (fail) throw new Error("disk failure");
          if (update.name) doc.name = update.name;
          doc.flags[ID].record = structuredClone(update[`flags.${ID}.record`]);
          doc.pages[0].text.content = update.pages[0]["text.content"];
        }
      };
      docs.push(doc);
      return doc;
    }
  };
  return {
    store: new CockpitStore(env), docs,
    setWriter: value => { writer = value; },
    setFail: value => { fail = value; }
  };
}

test("creates private journal-backed sessions with a readable page", async () => {
  const { store } = setup();
  const doc = await store.create("session", " Session one ");
  assert.equal(doc.name, "Session one");
  assert.deepEqual(doc.ownership, { default: 0 });
  assert.equal(doc.folder, "folder");
  assert.equal(doc.pages[0].getFlag(ID, "managed"), true);
  assert.match(doc.pages[0].text.content, /opening/);
  assert.deepEqual(store.read(doc).events, []);
});

test("next session carries goals and only previously attached, still-open threads", async () => {
  const { store } = setup();
  const previous = await store.create("session", "One");
  const open = await store.create("thread", "Open");
  const closed = await store.create("thread", "Closed");
  await store.create("thread", "Not attached");
  await store.change(closed, record => ({ ...record, status: "resolved" }));
  await store.change(previous, record => ({
    ...record, nextGoals: "Visit the river", opening: "Old opening",
    threads: [open.uuid, closed.uuid, "JournalEntry.deleted"],
    events: [{ time: "2026-10-05", text: "Old event" }]
  }));
  const next = store.read(await store.create("session", "Two", previous));
  assert.equal(next.nextGoals, "Visit the river");
  assert.deepEqual(next.threads, [open.uuid]);
  assert.equal(next.opening, "");
  assert.deepEqual(next.events, []);
});

test("saving notes and events updates flags and readable journal together", async () => {
  const { store } = setup();
  const doc = await store.create("session", "One");
  await store.change(doc, record => updateFields(record, { opening: "<script>alert(1)</script>\nHello" }));
  await store.change(doc, record => {
    record.events.push({ time: "2026-10-05", text: "Rescued the scout" });
    record.links.push("Actor.scout");
    return record;
  });
  assert.equal(store.read(doc).revision, 2);
  assert.match(doc.pages[0].text.content, /&lt;script&gt;/);
  assert.doesNotMatch(doc.pages[0].text.content, /<script>/);
  assert.match(doc.pages[0].text.content, /Rescued the scout/);
  assert.match(doc.pages[0].text.content, /@UUID\[Actor.scout\]/);
});

test("queued changes read fresh state instead of overwriting another change", async () => {
  const { store } = setup();
  const doc = await store.create("session", "One");
  await Promise.all(["First", "Second"].map(text => store.change(doc, record => {
    record.events.push({ time: "now", text });
    return record;
  })));
  assert.deepEqual(store.read(doc).events.map(event => event.text), ["First", "Second"]);
});

test("failed writes propagate and do not poison subsequent writes", async () => {
  const { store, setFail } = setup();
  const doc = await store.create("session", "One");
  setFail(true);
  await assert.rejects(store.change(doc, record => updateFields(record, { opening: "Lost" })), /disk failure/);
  assert.equal(store.read(doc).opening, "");
  setFail(false);
  await store.change(doc, record => updateFields(record, { opening: "Saved" }));
  assert.equal(store.read(doc).opening, "Saved");
});

test("non-primary GMs cannot create or change records", async () => {
  const { store, setWriter } = setup();
  const doc = await store.create("session", "One");
  setWriter(false);
  await assert.rejects(store.create("thread", "Forbidden"), /primaryGM/);
  await assert.rejects(store.change(doc, record => record), /primaryGM/);
  assert.equal(store.read(doc).revision, 0);
});

test("unknown versions, missing pages and deleted journals cannot be overwritten", async () => {
  const { store, docs } = setup();
  const doc = await store.create("session", "One");
  doc.flags[ID].record.version = 999;
  await assert.rejects(store.change(doc, record => record), /Unsupported/);
  doc.flags[ID].record.version = 1;
  doc.pages = [];
  await assert.rejects(store.change(doc, record => record), /missingPage/);
  docs.length = 0;
  await assert.rejects(store.change(doc, record => record), /missing/);
});

test("reading and editing records cannot mutate stored state before a successful write", async () => {
  const { store } = setup();
  const doc = await store.create("thread", "One");
  const copy = store.read(doc);
  copy.facts = "Changed";
  copy.links.push("Actor.x");
  assert.equal(store.read(doc).facts, "");
  assert.deepEqual(store.read(doc).links, []);
  const updated = updateFields(store.read(doc), { facts: "Fact", version: 9, kind: "session" });
  assert.equal(updated.version, VERSION);
  assert.equal(updated.kind, "thread");
});

test("legacy records upgrade lazily without altering the stored original", async () => {
  const { store } = setup();
  const doc = await store.create("session", "Legacy");
  const old = doc.flags[ID].record;
  old.version = 1;
  delete old.archived;
  delete old.featured;
  const read = store.read(doc);
  assert.equal(read.version, VERSION);
  assert.equal(read.archived, false);
  assert.deepEqual(read.featured, []);
  assert.equal(old.version, 1);
  await store.change(doc, record => record);
  assert.equal(doc.flags[ID].record.version, VERSION);
  assert.equal(doc.flags[ID].record.revision, 1);
  assert.throws(() => upgradeRecord({ ...read, version: 999 }), /Unsupported/);
});

test("rename and archive preserve notes and carryover excludes archived threads", async () => {
  const { store } = setup();
  const session = await store.create("session", "One");
  const thread = await store.create("thread", "Thread", null, { facts: "The scout is free" });
  await store.change(session, record => ({ ...record, threads: [thread.uuid], featured: [thread.uuid] }));
  await store.change(thread, record => ({ ...record, archived: true }), { name: "Renamed" });
  assert.equal(thread.name, "Renamed");
  assert.equal(store.read(thread).facts, "The scout is free");
  assert.deepEqual(store.read(await store.create("session", "Two", session)).threads, []);
  await assert.rejects(store.change(thread, record => record, { name: " " }), /nameRequired/);
});

test("search covers names, notes and events, case-insensitively", () => {
  const record = createRecord("session", "One");
  record.clues = "Footprints";
  record.events = [{ time: "now", text: "Rescued the scout" }];
  assert.ok(matchesSearch("At the river", record, "RIVER"));
  assert.ok(matchesSearch("One", record, "  footprints "));
  assert.ok(matchesSearch("One", record, "scout"));
  assert.equal(matchesSearch("One", record, "missing"), false);
});

test("note conversion appends reviewed text without erasing existing notes", () => {
  const session = createRecord("session", "One");
  session.consequences = "Old consequence";
  const next = appendNote(session, "consequences", " New consequence ");
  assert.equal(next.consequences, "Old consequence\nNew consequence");
  assert.equal(session.consequences, "Old consequence");
  const thread = createRecord("thread", "One");
  assert.equal(appendNote(thread, "facts", "True").facts, "True");
  assert.throws(() => appendNote(thread, "motives", "Not a fact"), /Invalid/);
});

test("publishing includes only preview text with observer ownership and no private flags or links", async () => {
  const { store, setWriter } = setup();
  const privateDoc = await store.create("session", "Private");
  await store.change(privateDoc, record => ({ ...record, escalations: "SECRET" }));
  const doc = await store.publish(" Public ", "<script>x</script>\n@UUID[JournalEntry.secret]");
  assert.equal(doc.name, "Public");
  assert.deepEqual(doc.ownership, { default: 2 });
  assert.equal(doc.flags, undefined);
  assert.equal(doc.folder, undefined);
  assert.equal(store.list("session").length, 1);
  assert.doesNotMatch(doc.pages[0].text.content, /SECRET|<script>|@UUID\[/);
  assert.match(doc.pages[0].text.content, /&lt;script&gt;/);
  assert.equal(store.read(privateDoc).escalations, "SECRET");
  const { document } = parseHTML(`<html><body>${publicHTML("@UUID[JournalEntry.secret] [[1d20]] <script>bad</script>")}</body></html>`);
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.doesNotMatch(document.body.textContent, /@UUID\[|\[\[1d20\]\]/);
  setWriter(false);
  await assert.rejects(store.publish("Public", "Text"), /primaryGM/);
  assert.throws(() => publicHTML(" "), /required/);
});

test("model rejects malformed notes, lists, events and status", () => {
  assert.throws(() => createRecord("other", "One"), /Invalid/);
  assert.throws(() => createRecord("session", " "), /name/);
  const session = createRecord("session", "One");
  assert.throws(() => validateRecord({ ...session, events: [null] }), /Invalid/);
  assert.throws(() => validateRecord({ ...session, links: [7] }), /Invalid/);
  assert.throws(() => updateFields(session, { opening: null }), /text/);
  const thread = createRecord("thread", "One");
  assert.throws(() => journalHTML({ ...thread, status: "bad" }, key => key), /Invalid/);
});

test("version 2 threads gain empty optional fields without changing existing facts or metadata", async () => {
  const { store } = setup();
  const doc = await store.create("thread", "Old thread");
  Object.assign(doc.flags[ID].record, {
    version: 2, facts: "Known fact", motives: "Rescue sister", development: "Treck leaves",
    revision: 4, archived: true, links: ["Actor.scout"], status: "resolved"
  });
  for (const key of ["challenges", "approaches", "intervention"]) delete doc.flags[ID].record[key];
  const record = store.read(doc);
  assert.equal(record.version, VERSION);
  assert.equal(record.revision, 4);
  assert.equal(record.facts, "Known fact");
  assert.equal(record.motives, "Rescue sister");
  assert.equal(record.development, "Treck leaves");
  assert.equal(record.archived, true);
  assert.deepEqual(record.links, ["Actor.scout"]);
  assert.equal(record.status, "resolved");
  for (const key of ["challenges", "approaches", "intervention"]) assert.equal(record[key], "");
  assert.equal(doc.flags[ID].record.version, 2);
  await store.change(doc, record => updateFields(record, {
    challenges: "Traps", approaches: "Instinct to spot traps", intervention: "Rescue costs time"
  }));
  const saved = store.read(doc);
  assert.equal(saved.revision, 5);
  assert.ok(matchesSearch(doc.name, saved, "traps"));
  assert.ok(matchesSearch(doc.name, saved, "instinct"));
  assert.ok(matchesSearch(doc.name, saved, "costs time"));
  assert.match(doc.pages[0].text.content, /Traps/);
  assert.match(doc.pages[0].text.content, /Instinct to spot traps/);
  assert.match(doc.pages[0].text.content, /Rescue costs time/);
});
