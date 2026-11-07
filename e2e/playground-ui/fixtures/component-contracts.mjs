import assert from "node:assert/strict";

/** Compare real surfaces, rather than trusting a component name or its CSS token. */
export async function componentContract(page) {
  const evidence = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const collect = (selector) =>
      [...document.querySelectorAll(selector)].filter(visible).map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        // biome-ignore lint/performance/useDomNodeTextContent: the visual contract must exclude CSS-hidden captions.
        const visibleText = element.innerText?.trim() ?? "";
        return {
          label: element.getAttribute("aria-label") ?? element.className,
          width: rect.width,
          height: rect.height,
          font: style.fontSize,
          wrap: element.classList.contains("ui-wrap"),
          variant: element.dataset.variant,
          icon:
            element.classList.contains("ui-icon-button") ||
            element.classList.contains("ui-menu-trigger") ||
            (!!element.querySelector("svg") && visibleText === ""),
        };
      });
    const raw = [...document.querySelectorAll("button,input,select,textarea")]
      .filter(visible)
      .filter((element) => !element.closest(".cm-editor,.react-flow,.global-scrollbars"))
      .filter((element) => !element.matches(".ui-button,.ui-input,.ui-select,.ui-textarea"))
      .map((element) => element.outerHTML.slice(0, 200));
    return {
      bars: collect(".ui-bar"),
      buttons: collect(".ui-button,.ui-menu-trigger"),
      fields: collect('.ui-input:not([type="checkbox"]),.ui-select'),
      checkboxes: collect('.ui-input[type="checkbox"]'),
      icons: collect(".ui-icon-button .editor-icon"),
      adapterFields: collect(".cm-search input.cm-textfield,.cm-search .cm-button"),
      adapterIcons: collect('.cm-search button[name="close"],.react-flow__controls-button'),
      raw,
      reference: collect(".tree-heading,.pane-tabbar"),
      editorHeights: [...document.querySelectorAll(".document-workspace .document-editor")]
        .filter(visible)
        .map((element) => element.getBoundingClientRect().height),
    };
  });
  assert.deepEqual(evidence.raw, [], "Workspace controls use the shared primitives");
  for (const bar of evidence.bars)
    assert.ok(bar.wrap ? bar.height >= 36 : Math.abs(bar.height - 36) < 0.1, `Bar geometry: ${JSON.stringify(bar)}`);
  for (const header of evidence.reference)
    assert.equal(header.height, 36, `Screenshot reference alignment: ${header.label}`);
  for (const button of evidence.buttons) {
    if (button.icon) {
      assert.equal(button.width, 26, `Square icon width: ${button.label}`);
      assert.equal(button.height, 26, `Square icon height: ${button.label}`);
    } else if (["default", "primary", "danger"].includes(button.variant))
      assert.equal(button.height, 26, `Text control height: ${button.label}`);
    else if (["row", "menu"].includes(button.variant))
      assert.equal(button.height, 28, `Row control height: ${button.label}`);
    if (!["cell", "link"].includes(button.variant)) assert.equal(button.font, "12px", `Control font: ${button.label}`);
  }
  for (const field of evidence.fields) {
    assert.equal(field.height, 26, `Field height: ${field.label}`);
    assert.equal(field.font, "12px", `Field font: ${field.label}`);
  }
  for (const box of evidence.checkboxes) {
    assert.equal(box.width, 12, `Checkbox width: ${box.label}`);
    assert.equal(box.height, 12, `Checkbox height: ${box.label}`);
  }
  for (const icon of evidence.icons) {
    assert.equal(icon.width, 16, `Shared icon width: ${icon.label}`);
    assert.equal(icon.height, 16, `Shared icon height: ${icon.label}`);
  }
  for (const field of evidence.adapterFields) {
    assert.equal(field.height, 26, `Editor adapter control height: ${field.label}`);
    assert.equal(field.font, "12px", `Editor adapter control font: ${field.label}`);
  }
  for (const icon of evidence.adapterIcons) {
    assert.equal(icon.width, 26, `Adapter icon button width: ${icon.label}`);
    assert.equal(icon.height, 26, `Adapter icon button height: ${icon.label}`);
  }
  for (const height of evidence.editorHeights) assert.ok(height >= 32, "Shared view containers preserve editor space");
  return evidence;
}
