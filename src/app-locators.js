/**
 * Locators of a Take of Apps: Accessibility elements named by role and name, in the style of Playwright's
 * getByRole (ADR 0009). They hold no element; each read or action resolves them again through the helper,
 * whose `request` answers:
 *   { windows: {} }                           the App's windows: { ref, title, subrole, focused, frame, ... }
 *   { find: { within, roles, identifier } }   the elements under `within` with one of `roles` ({ role, subrole }, or
 *                                             null for any) and that `identifier` (or any): { ref, role, subrole, title,
 *                                             description, label, identifier, frame }
 *   { read: { ref } }                         the element's { value, text, frame }
 * Frames are Desktop points.
 */

// ARIA roles as the AX roles (and subroles) AppKit, SwiftUI and Chromium expose them under.
const ROLES = {
  button: [['AXButton']], link: [['AXLink']], textbox: [['AXTextField'], ['AXTextArea']], searchbox: [['AXTextField', 'AXSearchField']],
  checkbox: [['AXCheckBox']], switch: [['AXCheckBox', 'AXSwitch']], radio: [['AXRadioButton']], combobox: [['AXComboBox'], ['AXPopUpButton']],
  menu: [['AXMenu']], menubar: [['AXMenuBar']], menuitem: [['AXMenuItem'], ['AXMenuBarItem']], slider: [['AXSlider']],
  tab: [['AXRadioButton', 'AXTabButton']], tablist: [['AXTabGroup']], list: [['AXList']], listbox: [['AXList']], table: [['AXTable']],
  grid: [['AXTable']], row: [['AXRow']], cell: [['AXCell']], tree: [['AXOutline']], treeitem: [['AXRow', 'AXOutlineRow']],
  heading: [['AXHeading']], img: [['AXImage']], image: [['AXImage']], group: [['AXGroup']], toolbar: [['AXToolbar']],
  dialog: [['AXWindow', 'AXDialog'], ['AXSheet']], scrollbar: [['AXScrollBar']], progressbar: [['AXProgressIndicator']],
  text: [['AXStaticText']], window: [['AXWindow']],
};
const WORKS = 'getByRole, getByTestId, value, text, isVisible and waitFor';
const POLL_MS = 100, READ_TIMEOUT_MS = 10_000, WAIT_TIMEOUT_MS = 30_000;
const RESOLVE = Symbol('resolve'), MATCHES = Symbol('matches');

/** The AX roles an ARIA role or a raw AX role names, as `{ role, subrole }`. */
function axRoles(role) {
  if (/^AX[A-Z]/.test(role)) return [{ role }];
  const roles = ROLES[role];
  if (!roles) throw new Error(`getByRole does not know the role '${role}'; use an ARIA role (${Object.keys(ROLES).join(', ')}) or an AX role such as AXPopUpButton`);
  return roles.map(([role, subrole]) => subrole ? { role, subrole } : { role });
}

/** Whether `text` matches `name`: a RegExp, the whole string with `exact`, else a part of it in any case. */
function matches(text, name, exact) {
  if (name instanceof RegExp) return name.test(text);
  return exact ? text === name : text.toLowerCase().includes(String(name).toLowerCase());
}

/** An element's accessible name: its title, else description, else label, else a static text's value. */
const nameOf = e => e.title || e.description || e.label || (e.role === 'AXStaticText' && typeof e.value === 'string' ? e.value : '');

const quote = value => value instanceof RegExp ? String(value) : `'${String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll("'", "\\'")}'`;
const shown = element => `${element.role} ${quote(nameOf(element) || element.identifier)}`;
const where = ({ x, y, width, height }) => `${x}, ${y}, ${width}×${height}`;
const visible = element => element.frame.width > 0 && element.frame.height > 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How a chain of steps reads in a Scenario, for messages. */
function describe(steps) {
  return steps.map(step => {
    if (step.window === 'front') return 'd.page';
    if (step.window === 'first') return 'page';
    if (step.window) return `d.app.window(${quote(step.window.name)})`;
    if (step.testId !== undefined) return `.getByTestId(${quote(step.testId)})`;
    const options = step.name === undefined ? '' : `, { name: ${quote(step.name)}${step.exact ? ', exact: true' : ''} }`;
    return `.getByRole(${quote(step.role)}${options})`;
  }).join('');
}

/**
 * Locators for the App behind `helper`: `page(which)` is a window as a page offers it, `'front'` (the
 * window in front when resolved), `'first'` (the first standard window) or `{ name }` (by title).
 */
export function appLocators(helper) {
  /** The elements a chain of steps matches now. */
  async function resolve(steps) {
    const [first, ...rest] = steps, windows = await helper.request({ windows: {} });
    let found = first.window === 'front' ? [windows.find(w => w.focused) ?? windows[0]]
      : first.window === 'first' ? [windows.find(w => w.subrole === 'AXStandardWindow') ?? windows[0]]
      : windows.filter(w => matches(w.title ?? '', first.window.name, false));
    found = found.filter(Boolean);
    for (const step of rest) {
      const next = new Map();
      for (const scope of found) {
        const query = step.testId !== undefined ? { within: scope.ref, roles: null, identifier: step.testId } : { within: scope.ref, roles: axRoles(step.role), identifier: null };
        for (const element of await helper.request({ find: query })) {
          if (step.name === undefined || matches(nameOf(element), step.name, step.exact)) next.set(element.ref, element);
        }
      }
      found = [...next.values()];
    }
    return found;
  }

  /** The one element `steps` match now, or null; several fail at once, as in Playwright's strict mode. */
  async function single(steps) {
    const found = await resolve(steps);
    if (found.length > 1) {
      const listed = found.slice(0, 5).map(e => `${shown(e)} at ${where(e.frame)}`).join('; ') + (found.length > 5 ? `; and ${found.length - 5} more` : '');
      throw new Error(`${describe(steps)} matches ${found.length} elements: ${listed}. Narrow it by name, or inside a locator that holds only one`);
    }
    return found[0] ?? null;
  }

  /** The one visible element `steps` match, waiting up to `timeout` ms for it. */
  async function visibleOne(steps, timeout = READ_TIMEOUT_MS) {
    for (const deadline = Date.now() + timeout; ;) {
      const element = await single(steps);
      if (element && visible(element)) return element;
      if (Date.now() >= deadline) throw new Error(`${describe(steps)} did not become visible within ${timeout} ms${element ? ': it has no size' : ''}`);
      await sleep(POLL_MS);
    }
  }

  function locator(steps) {
    const methods = {
      getByRole: (role, { name, exact = false } = {}) => (axRoles(role), locator([...steps, { role, name, exact }])),
      getByTestId: testId => locator([...steps, { testId }]),
      async value() { return (await helper.request({ read: { ref: (await visibleOne(steps)).ref } })).value; },
      async text() { return (await helper.request({ read: { ref: (await visibleOne(steps)).ref } })).text; },
      async isVisible() { const element = await single(steps); return Boolean(element && visible(element)); },
      /** Waits until the locator is `visible` (one element with a size) or `hidden` (none, or one without). */
      async waitFor({ state = 'visible', timeout = WAIT_TIMEOUT_MS } = {}) {
        if (state !== 'visible' && state !== 'hidden') throw new Error(`waitFor needs state 'visible' or 'hidden', not '${state}'`);
        for (const deadline = Date.now() + timeout; ;) {
          const element = await single(steps);
          if (Boolean(element && visible(element)) === (state === 'visible')) return;
          if (Date.now() >= deadline) throw new Error(`${describe(steps)} did not become ${state} within ${timeout} ms`);
          await sleep(POLL_MS);
        }
      },
      toString: () => describe(steps),
      [RESOLVE]: () => visibleOne(steps),
      [MATCHES]: () => resolve(steps),
    };
    return new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target || prop === 'then') return target[prop];
        throw new Error(`${prop} does not work on a locator of an App: use ${WORKS}, and act with d.click, d.type, d.hover and d.drag`);
      },
    });
  }

  function page(which) {
    const window = locator([{ window: which }]), prefix = describe([{ window: which }]);
    const methods = { getByRole: window.getByRole, getByTestId: window.getByTestId, toString: () => prefix };
    return new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target || prop === 'then') return target[prop];
        throw new Error(`${prefix}.${prop} does not work in a Take of an App: use getByRole, getByTestId, or d.app.window(title) for another window`);
      },
    });
  }

  return { page, window: name => page({ name }) };
}

/** The ARIA role a Scenario names an AX role and subrole by, or the AX role where none fits. */
function ariaRole(role, subrole) {
  const fits = loose => Object.keys(ROLES).find(aria => ROLES[aria].some(([r, s]) => r === role && (s ? s === subrole : loose)));
  return fits(false) ?? fits(true) ?? role;
}

const relative = ({ x, y, width, height }, origin) => `${Math.round(x - origin.x)}, ${Math.round(y - origin.y)}, ${Math.round(width)}×${Math.round(height)}`;

/**
 * The lines `cuetake tree` prints for the tree the helper lists (`cuetake-capture tree`): each element,
 * indented under its parent, with its role, name, value and frame from its window's top-left corner, and
 * the locator that finds it, by test id where it has one of its own, else by role and the first line of its name.
 */
export function treeLines({ app, bundle, windows, truncated }) {
  const lines = [`${app} (${bundle}): frames in points from each window's top-left corner, which are Desktop points for the window that fills the Desktop`];
  for (const window of windows) {
    const { width, height } = window.frame;
    lines.push(`window ${quote(nameOf(window))} ${Math.round(width)}×${Math.round(height)}: d.app.window(${quote(nameOf(window))})`);
    const visit = (element, depth) => {
      const role = ariaRole(element.role, element.subrole), name = nameOf(element), own = element.identifier && !element.identifier.startsWith('_NS:');
      const value = typeof element.value === 'string' && element.value && element.value !== name ? ` = ${quote(element.value)}` : typeof element.value === 'number' ? ` = ${element.value}` : '';
      const locator = own ? `getByTestId(${quote(element.identifier)})`
        : name ? `getByRole('${role}', { name: ${quote(name.split('\n')[0])} })` : '';
      lines.push(`${'  '.repeat(depth)}${role}${name ? ` ${quote(name)}` : ''}${value} ${relative(element.frame, window.frame)}${locator ? `: ${locator}` : ''}`);
      for (const child of element.children ?? []) visit(child, depth + 1);
    };
    for (const child of window.children ?? []) visit(child, 1);
  }
  if (truncated) lines.push('… the tree is longer than 5000 elements; the rest is left out');
  return lines;
}

/** Whether `target` is a locator of an App. */
export const isAppLocator = target => typeof target?.[RESOLVE] === 'function';

/** The one visible element an App locator matches, waiting for it, with its frame in Desktop points. */
export const resolveOne = target => target[RESOLVE]();

/** Every element an App locator matches now, shown or not, without waiting. */
export const resolveAll = target => target[MATCHES]();
