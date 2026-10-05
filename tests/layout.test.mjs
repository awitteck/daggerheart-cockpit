import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import Handlebars from "handlebars";

test("session navigation buttons have equal dimensions in both languages at narrow and wide widths", async () => {
  const css = await readFile(new URL("../styles/cockpit.css", import.meta.url), "utf8");
  const template = Handlebars.compile(await readFile(new URL("../templates/cockpit.hbs", import.meta.url), "utf8"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const lang of ["de", "en"]) {
      const translations = JSON.parse(await readFile(new URL(`../lang/${lang}.json`, import.meta.url), "utf8")).DHC;
      Handlebars.registerHelper("localize", key => translations[key.slice(4)] ?? key);
      const html = template({
        selected: { name: "Session", uuid: "JournalEntry.one" },
        isSession: true,
        record: { events: [] },
        views: ["prep", "play", "after"].map(key => ({
          key, label: translations[key], active: key === "prep"
        }))
      });
      await page.setContent(`<style>
        * { box-sizing: border-box; }
        button { width: auto; height: 32px; padding: 0 12px; font: 16px sans-serif; white-space: nowrap; }
        .dh-cockpit { height: 800px; }
        ${css}
      </style><div class="dh-cockpit">${html}</div>`);
      for (const width of [950, 600]) {
        await page.setViewportSize({ width, height: 900 });
        const sizes = await page.locator('[data-action="view"]').evaluateAll(buttons =>
          buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return { width: rect.width, height: rect.height, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth };
          })
        );
        assert.equal(sizes.length, 3);
        for (const size of sizes) {
          assert.ok(Math.abs(size.width - sizes[0].width) < 1, `${lang}, ${width}px: unequal button widths ${JSON.stringify(sizes)}`);
          assert.ok(Math.abs(size.height - sizes[0].height) < 1, `${lang}, ${width}px: unequal button heights`);
          assert.ok(size.scrollWidth <= size.clientWidth, `${lang}, ${width}px: label overflows`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});
