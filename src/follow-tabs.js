/**
 * Follows the Tabs a Take shows (ADR 0008): the first page, and every page a Tab, or an iframe in it,
 * opens as a new tab or a popup window. Pages the Scenario opens itself with `context.newPage()` are
 * not followed. `watch(tab)` is called as each Tab opens; `start(tab)` then begins recording it, one Tab
 * at a time. A Tab another came in front of while it started goes back behind.
 *
 * Which Tab is in front follows the browser: a new Tab comes in front when it opens, and when it closes
 * the Tab that opened it comes back (or, if that one closed too, its nearest open opener). Any other
 * Tab comes back only through `switchTo`. Times are epoch milliseconds.
 */
export function followTabs(first, { watch = () => {}, start = async () => {} } = {}) {
  const tabs = [], fronts = [];
  let front = null, starting = Promise.resolve();
  const toFront = tab => {
    if (front === tab) return;
    front = tab;
    fronts.push({ ms: Date.now(), tab: tab.id });
  };
  const add = (page, opener) => {
    const tab = { id: tabs.length, page, opener: opener?.id ?? null, openedMs: Date.now(), closedMs: null, viewport: page.viewportSize(), url: page.url() };
    tabs.push(tab);
    watch(tab);
    page.on('popup', popup => toFront(add(popup, tab)));
    page.on('close', () => {
      tab.closedMs = Date.now();
      if (front !== tab) return;
      let back = tabs[tab.opener];
      while (back?.closedMs) back = tabs[back.opener];
      back ??= tabs.findLast(other => !other.closedMs);
      if (!back) return;
      toFront(back);
      back.page.bringToFront().catch(() => {});
    });
    // A Tab that closes before it could be recorded is left out; any other failure stops the Take.
    tab.ready = starting = starting.catch(() => {}).then(() => start(tab)).then(async () => {
      tab.recorded = true;
      if (front !== tab) await front.page.bringToFront().catch(() => {});
    }, error => {
      if (!page.isClosed()) throw error;
      tab.recorded = false;
    });
    tab.ready.catch(() => {});
    return tab;
  };
  front = add(first, null);
  const of = page => tabs.find(tab => tab.page === page);
  return {
    get front() { return front; },
    fronts,
    list: () => tabs,
    of,
    /** Resolves once the Tab showing `page` records. */
    ready: page => of(page)?.ready ?? Promise.reject(new Error('This page is not a Tab of the Take')),
    async switchTo(page) {
      const tab = of(page);
      if (!tab) throw new Error('d.switchTo needs a Tab of the Take: the first page or one the demo opened. Capture does not follow pages opened with context.newPage()');
      if (tab.closedMs) throw new Error(`Tab ${tab.id} has closed`);
      await page.bringToFront();
      toFront(tab);
    },
  };
}
