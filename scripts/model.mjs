export const ID = "daggerheart-cockpit";
export const VERSION = 2;
export const SESSION_FIELDS = ["opening", "situations", "clues", "escalations", "questions", "consequences", "feedback", "nextGoals"];
export const THREAD_FIELDS = ["facts", "motives", "development"];

export function documentPresentation(doc) {
  const types = {
    Actor: { typeKey: "documentActor", icon: "fa-solid fa-user" },
    JournalEntry: { typeKey: "documentJournal", icon: "fa-solid fa-book-open" },
    JournalEntryPage: { typeKey: "documentPage", icon: "fa-solid fa-file-lines" },
    Scene: { typeKey: "documentScene", icon: "fa-solid fa-map" },
    RollTable: { typeKey: "documentTable", icon: "fa-solid fa-dice" }
  };
  return types[doc.documentName] ?? { typeKey: "documentOther", icon: "fa-solid fa-file" };
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function createRecord(kind, name, previous = null) {
  if (!["session", "thread"].includes(kind)) throw new Error("Invalid record type.");
  if (!name.trim()) throw new Error("A name is required.");
  const record = { version: VERSION, revision: 0, kind, links: [], archived: false };
  if (kind === "session") {
    Object.assign(record, Object.fromEntries(SESSION_FIELDS.map(key => [key, ""])), {
      events: [], threads: [], spotlight: [], featured: [],
      nextGoals: previous?.nextGoals ?? ""
    });
  } else {
    Object.assign(record, Object.fromEntries(THREAD_FIELDS.map(key => [key, ""])), { status: "open" });
  }
  return record;
}

export function upgradeRecord(record) {
  const next = structuredClone(record);
  if (next?.version === 1) {
    next.version = VERSION;
    next.archived = false;
    if (next.kind === "session") next.featured = [];
  }
  return validateRecord(next);
}

export function validateRecord(record) {
  if (!record || record.version !== VERSION || !Number.isSafeInteger(record.revision) ||
      record.revision < 0 || typeof record.archived !== "boolean" ||
      !["session", "thread"].includes(record.kind)) {
    throw new Error("Unsupported or damaged cockpit data. The original journal has not been changed.");
  }
  const fields = record.kind === "session" ? SESSION_FIELDS : THREAD_FIELDS;
  if (fields.some(key => typeof record[key] !== "string") ||
      !Array.isArray(record.links) || record.links.some(uuid => typeof uuid !== "string")) {
    throw new Error("Invalid cockpit record.");
  }
  if (record.kind === "session") {
    if (!Array.isArray(record.events) || record.events.some(event =>
      typeof event?.text !== "string" || typeof event?.time !== "string"
    ) || !Array.isArray(record.threads) || record.threads.some(uuid => typeof uuid !== "string") ||
      !Array.isArray(record.spotlight) || record.spotlight.some(uuid => typeof uuid !== "string") ||
      !Array.isArray(record.featured) || record.featured.some(uuid =>
        typeof uuid !== "string" || !record.threads.includes(uuid))) {
      throw new Error("Invalid session data.");
    }

  } else if (!["open", "resolved"].includes(record.status)) throw new Error("Invalid thread status.");
  return record;
}

export function matchesSearch(name, record, query) {
  validateRecord(record);
  const fields = record.kind === "session" ? SESSION_FIELDS : THREAD_FIELDS;
  const text = [name, ...fields.map(key => record[key]), ...(record.events ?? []).map(event => event.text)].join("\n");
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function appendNote(record, field, text) {
  const allowed = record.kind === "session" ? ["consequences", "nextGoals"] : ["facts"];
  if (!allowed.includes(field) || !text.trim()) throw new Error("Invalid note conversion.");
  return updateFields(record, { [field]: [record[field], text.trim()].filter(Boolean).join("\n") });
}

export function publicHTML(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("A summary is required.");
  // Plain text only, including Foundry enrichment syntax: public text never resolves secret UUID links.
  return `<p>${escapeHTML(text).replace(/@/g, "@&#8203;").replace(/\[\[/g, "[&#8203;[").replace(/\n/g, "<br>")}</p>`;
}

export function updateFields(record, values) {
  validateRecord(record);
  const next = structuredClone(record);
  const allowed = record.kind === "session" ? SESSION_FIELDS : THREAD_FIELDS;
  for (const field of allowed) {
    if (Object.hasOwn(values, field)) {
      if (typeof values[field] !== "string") throw new Error("Notes must be text.");
      next[field] = values[field];
    }
  }
  return next;
}

export function journalHTML(record, localize) {
  validateRecord(record);
  const text = value => escapeHTML(value).replace(/\n/g, "<br>");
  const fields = record.kind === "session" ? SESSION_FIELDS : THREAD_FIELDS;
  let html = fields.map(key =>
    `<h2>${escapeHTML(localize(key))}</h2><p>${text(record[key])}</p>`
  ).join("");
  if (record.kind === "thread") html += `<p>${escapeHTML(localize(record.status))}</p>`;
  if (record.kind === "session") {
    html += `<h2>${escapeHTML(localize("events"))}</h2><ul>` +
      record.events.map(event => `<li>${escapeHTML(event.time)}: ${text(event.text)}</li>`).join("") + "</ul>";
  }
  const uuids = [...record.links, ...(record.threads ?? [])];
  if (uuids.length) html += `<h2>${escapeHTML(localize("links"))}</h2><ul>` +
    uuids.map(uuid => `<li>@UUID[${escapeHTML(uuid)}]</li>`).join("") + "</ul>";
  return html;
}
