import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberWorkbenchScroll } from '../web/scroll-state.js';

function fixture(saved = new Map(), identity = () => 'session:preset') {
  const listeners = new Map();
  const windowListeners = new Map();
  const elements = new Map([['used-prompts', { scrollTop: 0 }], ['regex-list', { scrollTop: 0 }]]);
  const root = {
    scrollingElement: { scrollTop: 0 }, documentElement: {},
    getElementById: id => elements.get(id) ?? null,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const original = globalThis.window;
  globalThis.window = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: name => windowListeners.delete(name),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  const cleanup = rememberWorkbenchScroll(root, identity, storage);
  return { root, elements, listeners, windowListeners, saved, preserveOnNavigation: () => cleanup.preserveOnNavigation(), cleanup: () => { cleanup(); globalThis.window = original; } };
}

test('scroll positions survive iframe remount and stay scoped to the active preset', () => {
  const saved = new Map();
  const first = fixture(saved);
  first.root.scrollingElement.scrollTop = 420;
  first.elements.get('used-prompts').scrollTop = 80;
  first.windowListeners.get('pagehide')();
  first.cleanup();
  const second = fixture(saved);
  assert.equal(second.root.scrollingElement.scrollTop, 420);
  assert.equal(second.elements.get('used-prompts').scrollTop, 80);
  second.cleanup();
  const other = fixture(saved, () => 'session:other');
  assert.equal(other.root.scrollingElement.scrollTop, 0);
  other.cleanup();
});

test('scroll state tolerates blocked storage and removes lifecycle listeners', () => {
  const original = globalThis.window;
  const windowListeners = new Map();
  globalThis.window = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: name => windowListeners.delete(name),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  const listeners = new Map();
  const root = {
    scrollingElement: { scrollTop: 3 }, documentElement: {}, getElementById: () => null,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  try {
    const cleanup = rememberWorkbenchScroll(root, () => 's', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
    cleanup();
    assert.equal(listeners.size, 0);
    assert.equal(windowListeners.size, 0);
  } finally { globalThis.window = original; }
});

test('opening the editor preserves the last workbench position when navigation scrolls to its top button', () => {
  const saved = new Map();
  const ui = fixture(saved);
  ui.root.scrollingElement.scrollTop = 701;
  ui.windowListeners.get('pagehide')();
  ui.root.scrollingElement.scrollTop = 0;
  ui.preserveOnNavigation();
  ui.windowListeners.get('pagehide')();
  ui.cleanup();
  assert.equal(JSON.parse([...saved.values()][0]).page, 701);
});


test('canceled navigation and back-forward restoration resume scroll recording', () => {
  for (const event of ['wheel', 'pointerdown', 'keydown', 'touchstart', 'pageshow']) {
    const ui = fixture();
    try {
      ui.root.scrollingElement.scrollTop = 701;
      ui.windowListeners.get('pagehide')();
      ui.preserveOnNavigation();
      (event === 'pageshow' ? ui.windowListeners : ui.listeners).get(event)();
      ui.root.scrollingElement.scrollTop = 920;
      ui.windowListeners.get('pagehide')();
      assert.equal(JSON.parse([...ui.saved.values()][0]).page, 920, event);
    } finally { ui.cleanup(); }
    assert.equal(ui.listeners.size, 0);
    assert.equal(ui.windowListeners.size, 0);
  }
});
