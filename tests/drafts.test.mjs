import test from "node:test";
import assert from "node:assert/strict";
import { Drafts } from "../scripts/drafts.mjs";

function storage() {
  const map = new Map();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key)
  };
}

test("drafts survive reload and stay isolated by world, user and document", () => {
  const disk = storage();
  const drafts = new Drafts(disk, "world", "gm");
  drafts.save("JournalEntry.one", 3, { "note:opening": "Draft", event: "Quick note", checked: true });
  const restored = new Drafts(disk, "world", "gm").read("JournalEntry.one");
  assert.equal(restored.revision, 3);
  assert.equal(restored.values["note:opening"], "Draft");
  assert.equal(restored.values.event, "Quick note");
  assert.equal(restored.values.checked, true);
  assert.equal(drafts.read("JournalEntry.two"), null);
  assert.equal(new Drafts(disk, "other", "gm").read("JournalEntry.one"), null);
  assert.equal(new Drafts(disk, "world", "player").read("JournalEntry.one"), null);
  drafts.remove("JournalEntry.one");
  assert.equal(drafts.read("JournalEntry.one"), null);
});

test("corrupt drafts and unavailable browser storage surface errors without deletion", () => {
  const disk = storage();
  const drafts = new Drafts(disk, "world", "gm");
  disk.setItem(drafts.key("one"), "{");
  assert.throws(() => drafts.read("one"), SyntaxError);
  assert.equal(disk.getItem(drafts.key("one")), "{");
  disk.setItem(drafts.key("one"), JSON.stringify({ version: 1, revision: 0, values: { bad: [] } }));
  assert.throws(() => drafts.read("one"), /Invalid/);
  const blocked = new Drafts({ setItem: () => { throw new Error("quota"); } }, "world", "gm");
  assert.throws(() => blocked.save("one", 0, {}), /quota/);
});
