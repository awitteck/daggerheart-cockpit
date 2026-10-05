# Daggerheart Cockpit

An early GM-only module targeting Foundry VTT **14** and the **Daggerheart**
system. No system patches, external services, build step or runtime dependencies.
The interface supports German and English.

## Install

In Foundry's **Install Module → Manifest URL**, paste:

```text
https://github.com/awitteck/daggerheart-cockpit/releases/latest/download/module.json
```

GitHub `blob/.../module.json` addresses are HTML pages, not JSON manifests.
The release manifest includes the downloadable module ZIP.

Alternatively, install manually:

1. Copy this entire directory to `Data/modules/daggerheart-cockpit`.
2. Restart Foundry, open your Daggerheart world and enable **Daggerheart Cockpit**
   in Manage Modules.
3. Open **Configure Settings → Module Settings → Daggerheart Cockpit**, or press
   **Ctrl+Shift+K**. You can also use a script macro:

   ```js
   game.modules.get("daggerheart-cockpit").api.open();
   ```

## Workflow

- Enter a name and create a session. **Preparation** shows the opening,
  situations, clues, possible escalations and character questions.
- Create campaign threads separately, grouped into **Background** (established
  facts and people/goals), **Options for action** (challenges and possible
  approaches/rolls), and **Developments** (without and with intervention).
  All note fields are optional. Describe what is at stake and possible reactions,
  not a mandatory roll sequence or predetermined outcome. A success with Fear
  remains a success. Toggle a thread between open and resolved.
  In session cards, background is separately collapsible; nonempty challenges,
  approaches and developments are immediately visible when the card is expanded.
- Select your session and attach relevant threads. Drag Actors, Journals,
  Scenes or RollTables from the sidebar to pin their document links. Links show
  a document-type icon and label (Actor, Journal, Journal page, Scene or Roll table),
  including inside thread cards, so identical names remain distinguishable.
- **At the table** shows pinned documents, expandable thread cards, the event
  log and manual character spotlight. Highlight important threads for today;
  highlighted cards move to the top. Resolved threads remain recognizable.
  Delete individual events using **Delete event** and confirm the permanent
  removal. Converted notes, edited summary previews and published summaries are
  not deleted. Event selections and pending conversions follow the remaining
  events rather than shifting to the wrong entry.
- **After the session** shows consequences, feedback, next-session goals and
  the event log. Convert an event into a consequence, next goal, established
  fact on a selected thread, or a new thread. Review/edit the text and confirm.
  Original events are retained. Newly created threads can be attached using
  the existing Attach control.
- Create a **player summary** by explicitly selecting events and/or consequences
  and goals. Nothing is selected by default. Create an editable preview, review
  it for secrets, then confirm publication. A separate observer-readable journal
  is created; the private source journal is untouched. Foundry document/inline
  roll enrichment syntax is rendered as inert text, not executable links.
- With the previous session selected, create the next session to carry forward
  its goals and its attached threads that are still open and not archived.
- Search names, note fields and event text from the sidebar. **Manage record**
  lets you rename or archive/unarchive entries without deleting any notes.
  Archived entries are hidden from the list unless Show archived is enabled.

Text fields require explicit journal saving. Other record-changing actions also
save the note fields, including fields hidden in the current view. Switching
views or records and closing retains drafts rather than discarding them.
**Refresh** explicitly discards the selected record's draft after confirmation
if there is unsaved text. No dice events, Fear spending or character resources
are automated.

## Draft recovery and upgrading

The status line distinguishes journal saves, unsaved drafts backed up locally
and unavailable browser storage. Notes, quick input, conversion text and summary
previews are backed up on input using localStorage, scoped by world, user and
document UUID. Reopening a record restores its draft. This is **browser-local**,
not a cloud/world backup: it does not follow you to another device and clearing
browser storage removes it. Use journal saving regularly.

Recovered drafts retain their original revision. If the journal has since changed,
saves are rejected instead of overwriting newer notes. Copy the desired text, use
Refresh to discard the stale draft, then reapply it. Storage/quota/corrupt-draft
errors are notified; corrupt drafts are not automatically overwritten. If local
backup fails, closing with unsaved text asks for confirmation.

Back up the world, replace the module directory with version **0.4.0**, restart
Foundry and reload the browser. Existing 0.1.x and 0.2.x journal data is upgraded
in memory when read and persisted as version 3 on its next successful save. New
thread fields start empty; notes, links, events, spotlight, archives, highlights
and thread associations are preserved. Local drafts remain usable with their
original revision checks. Unknown versions are
not overwritten. After saving upgraded data, do not downgrade the module without
restoring the pre-upgrade world backup.

## Shared campaign book and player notes (0.4.0)

1. As primary GM, select a session, expand **Player notes** and click
   **Enable player notes for this session**. Confirm the visibility warning.
   This creates a separate shared notebook JournalEntry for each non-GM user,
   not just connected users. Enabling again adds notebooks for newly added players.
   No private notes or linked GM documents are copied. The session name is public,
   so use a spoiler-free name.
2. Players open **Configure Settings → Module Settings → Player notes** or press
   **Alt+Shift+N**. A script macro can also open it:

   ```js
   game.modules.get("daggerheart-cockpit").api.openPlayerNotes();
   ```

3. Select a session as the origin of new entries. Add a title, text, category
   (**People/NPCs**, **Places**, **Clues/theories**, **Events/agreements**) and source
   (**Observed**, **Reported**, **Theory**). Save the entry to share it with everyone.
   **New entry** clears the editor after confirmation when needed. Your own saved
   entries have edit/delete buttons; deletion requires confirmation.
4. The campaign book lists entries from **all enabled sessions**, grouped by
   category and sorted by title. Search covers title, text, author and session
   name. Multiple players can write about the same NPC; their contributions
   remain separate and attributed, rather than overwriting each other.
5. A collapsible free-text session contribution remains available for general
   observations and older notebook content. It is saved separately from entries.
6. Use **Reload contributions** to fetch the latest view while retaining your
   own draft. Notes are not automatically live-re-rendered during typing. Drafts
   are browser-local and revision-checked; **Discard draft** explicitly discards
   the selected notebook's unsaved editor and free-text contribution.
7. The GM's **After the session** summary selection includes that session's
   saved book entries and free-text contributions. Select desired items, generate
   the editable preview, then confirm publication. Category/source labels remain
   visible in the selection; source and author are carried into the preview.
   No entry is automatically promoted to an established campaign fact.

The player view never reads private cockpit records. Notebooks contain only a
public session name/id, author metadata and shared text. No Actors, Scenes or
other documents are generated from entries. All entries are public to the group,
not suitable for secrets. Source labels describe player knowledge, not GM truth.

Each notebook has default **OBSERVER** ownership and **OWNER** only for its author.
Foundry enforces access to other players' documents; GMs retain Foundry's normal
administrative access. Players can also access their own notebook via the native
journal interface; direct edits to its generated page are not synchronized back
to flags and will be replaced on the next module save. Do not give other players
OWNER permissions on someone else's notebook. Shared notebooks are outside the
private cockpit folder and remain readable without this module.

## Persistence and permissions

Each session/thread is an ordinary JournalEntry in a module-marked folder, with
default ownership `NONE`. Structured records live in module flags; a managed
text page is updated alongside them so notes remain readable when the module is
disabled. Do not edit the generated text page directly: the next cockpit save
will regenerate it. Additional journal pages can be used for free-form notes.

Only Foundry's active primary GM can write through the cockpit. Other GMs can
read. Writes are queued and revision checks reject stale note edits from another
window. This does not protect against direct edits by other modules or the journal
editor. Unknown data versions and missing managed pages are rejected rather than
silently replaced.

Linked documents keep their existing ownership. The cockpit does **not** change
their permissions or expose the GM cockpit to players. Published summaries are separate
journals outside the private campaign folder, with default observer ownership
and no source flags or document associations. Publishing again creates another
journal; edit or delete old public summaries using Foundry's journal interface.
Keep secrets in private documents; hiding an interface element is not access
control. Changing a cockpit journal's ownership manually can expose its notes and
flags to players. Local drafts also contain GM notes; world/user scoping is not
encryption. Avoid shared browser profiles for private campaign material.

## Development and verification

Run `npm ci`, `npx playwright install chromium`, and `npm test` (Node.js 18+). Development-only Handlebars and
LinkeDOM dependencies validate the actual template and DOM interaction alongside
in-memory Foundry persistence tests. Installed modules have no runtime npm
dependencies and require no build.

The Playwright layout check measures equal navigation button dimensions and label
overflow in German and English at narrow and wide widths. It requires Chromium's
system libraries; use a supported Playwright environment for development.

The manifest marks Foundry v14 as verified based on user testing in a running
installation. Automated checks do not replace testing every workflow in Foundry.
Before using it for a live campaign, check in a disposable world:

1. Open via settings, shortcut and macro; create a session and a thread.
2. Save, reload the browser and confirm notes, events and links survive.
3. Drop each supported document type; delete a linked document and confirm the
   missing-link warning. Check both German and English.
4. Switch through all three views with unsaved notes; reload the browser and
   reopen the record to confirm restoration. Also try unavailable browser storage.
5. Expand/highlight thread cards, resolve/archive a thread and create the next
   session; confirm only eligible threads and next-session goals carry forward.
6. Convert events to each of the four destinations; check append behavior.
7. Select just one public event, review/edit the summary and publish. Join as a
   player to verify that only the separate summary is visible, not source journals.
8. Search, rename, archive and restore entries. Check other GMs' read-only behavior.
9. Edit the same record in two cockpit windows; confirm stale/recovered saves are
   rejected. Copy the text before using Refresh to discard a stale draft.
10. Disable the module and check the readable journal pages.
11. Enable player notes for a spoiler-free session. Join as two different players:
    create entries in each category, edit/delete your own and confirm the other
    player's notebook is read-only. Open an older session and check cross-session
    grouping/search and draft recovery. Verify the private GM journals remain hidden.
12. As GM, reload contributions, select one player entry and publish a reviewed
    summary; confirm unselected text and private GM fields are absent.

The module uses ApplicationV2 and HandlebarsApplicationMixin. Campaign logic and
journal persistence are separate from the interface. It only reads character
Actors' standard `type` and does not rely on Daggerheart's private implementation.
