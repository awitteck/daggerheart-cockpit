import test from "node:test";
import assert from "node:assert/strict";
import { ID, createRecord } from "../scripts/model.mjs";
import { PlayerNotesStore } from "../scripts/player-notes.mjs";

function setup() {
  let user = { id: "gm", isGM: true };
  const users = [user, { id: "one", name: "One", isGM: false }, { id: "two", name: "Two", isGM: false }];
  const docs = [];
  const store = new PlayerNotesStore({
    journals: () => docs, users: () => users, currentUser: () => user,
    localize: key => key,
    assertWriter: () => { if (user.id !== "gm") throw new Error("primaryGM"); },
    createJournal: async data => {
      const doc = {
        ...structuredClone(data), id: String(docs.length),
        getFlag: (scope, key) => doc.flags?.[scope]?.[key],
        testUserPermission: (user, permission) => permission === "OWNER" && doc.ownership[user.id] === 3,
        pages: data.pages.map((page, index) => ({
          ...structuredClone(page), id: String(index), getFlag: (scope, key) => page.flags?.[scope]?.[key]
        })),
        update: async update => {
          if (doc.fail) throw new Error("disk");
          doc.flags[ID].playerNotes = structuredClone(update[`flags.${ID}.playerNotes`]);
          doc.pages[0].text.content = update.pages[0]["text.content"];
        }
      };
      docs.push(doc);
      return doc;
    }
  });
  return { store, docs, users, setUser: id => { user = users.find(user => user.id === id); } };
}

test("GM provisions separate observer journals, own player ownership and no private campaign data", async () => {
  const { store, docs, users } = setup();
  const session = { id: "session", name: "One", flags: { [ID]: { record: {
    ...createRecord("session", "One"), escalations: "Secret"
  } } } };
  await store.enable(session);
  assert.equal(docs.length, 2);
  for (const doc of docs) {
    const record = store.read(doc);
    assert.deepEqual(doc.ownership, { default: 2, [record.userId]: 3 });
    assert.equal(doc.folder, undefined);
    assert.equal(doc.flags[ID].record, undefined);
    assert.doesNotMatch(JSON.stringify(doc), /Secret/);
  }
  await Promise.all([store.enable(session), store.enable(session)]);
  assert.equal(docs.length, 2);
  users.push({ id: "three", name: "Three", isGM: false });
  await store.enable(session);
  assert.equal(docs.length, 3);
});

test("players can save their own text, not other players' notebooks or provision new ones", async () => {
  const { store, docs, setUser } = setup();
  await store.enable({ id: "session", name: "One" });
  setUser("one");
  await store.save(docs[0], 0, "My theory");
  assert.equal(store.read(docs[0]).body, "My theory");
  assert.equal(store.read(docs[0]).revision, 1);
  assert.match(docs[0].pages[0].text.content, /My theory/);
  await assert.rejects(store.save(docs[1], 0, "Overwrite"), /ownNotesOnly/);
  await assert.rejects(store.enable({ id: "another", name: "Another" }), /primaryGM/);
  setUser("two");
  await store.save(docs[1], 0, "Independent");
  assert.equal(store.read(docs[0]).body, "My theory");
  assert.equal(store.read(docs[1]).body, "Independent");
});

test("stale writes, failures, absent documents and corrupt versions preserve saved notes", async () => {
  const { store, docs, setUser } = setup();
  await store.enable({ id: "session", name: "One" });
  setUser("one");
  await store.save(docs[0], 0, "Saved");
  await assert.rejects(store.save(docs[0], 0, "Stale"), /conflict/);
  docs[0].fail = true;
  await assert.rejects(store.save(docs[0], 1, "Lost"), /disk/);
  assert.equal(store.read(docs[0]).body, "Saved");
  docs[0].fail = false;
  docs[0].flags[ID].playerNotes.version = 999;
  await assert.rejects(store.save(docs[0], 1, "Lost"), /Unsupported/);
  await assert.rejects(store.save(null, 0, ""), /noOwnNotebook/);
});

test("player contributions render as inert text and stay associated with the right session", async () => {
  const { store, docs, setUser } = setup();
  await store.enable({ id: "session", name: "One" });
  await store.enable({ id: "other", name: "Other" });
  setUser("one");
  await store.save(docs[0], 0, "<script>bad</script> @UUID[JournalEntry.private]");
  assert.doesNotMatch(docs[0].pages[0].text.content, /<script>|@UUID\[/);
  assert.equal(store.list("session").length, 2);
  assert.equal(store.list("other").length, 2);
});

test("categorized entries allow add, edit and delete only by the notebook author", async () => {
  const { store, docs, setUser } = setup();
  await store.enable({ id: "session", name: "One" });
  setUser("one");
  await store.saveEntry(docs[0], 0, {
    id: "npc", title: "Ylva", text: "Suspicious", category: "person", source: "theory"
  });
  await store.saveEntry(docs[0], 1, {
    id: "moor", title: "Moor", text: "Dangerous", category: "place", source: "observed"
  });
  await store.saveEntry(docs[0], 2, {
    id: "npc", title: "Ylva", text: "Helped us", category: "person", source: "observed"
  });
  assert.equal(store.read(docs[0]).entries.length, 2);
  assert.equal(store.read(docs[0]).entries[0].text, "Helped us");
  assert.match(docs[0].pages[0].text.content, /Ylva/);
  await assert.rejects(store.saveEntry(docs[1], 0, {
    id: "bad", title: "Overwrite", text: "No", category: "clue", source: "reported"
  }), /ownNotesOnly/);
  await assert.rejects(store.saveEntry(docs[0], 3, {
    id: "bad", title: "Bad", text: "No", category: "invalid", source: "theory"
  }), /Invalid/);
  await assert.rejects(store.removeEntry(docs[0], 1, "npc"), /conflict/);
  await store.removeEntry(docs[0], 3, "npc");
  assert.deepEqual(store.read(docs[0]).entries.map(entry => entry.id), ["moor"]);
});

test("legacy free text notebooks upgrade lazily and preserve original text", async () => {
  const { store, docs, setUser } = setup();
  await store.enable({ id: "session", name: "One" });
  const original = docs[0].flags[ID].playerNotes;
  original.version = 1;
  original.body = "Old text";
  delete original.entries;
  assert.equal(store.read(docs[0]).version, 2);
  assert.deepEqual(store.read(docs[0]).entries, []);
  assert.equal(original.version, 1);
  setUser("one");
  await store.saveEntry(docs[0], 0, { id: "new", title: "Place", text: "A valley", category: "place", source: "observed" });
  assert.equal(store.read(docs[0]).body, "Old text");
  assert.match(docs[0].pages[0].text.content, /Old text/);
});
