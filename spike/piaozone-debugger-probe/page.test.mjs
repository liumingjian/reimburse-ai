import assert from 'node:assert/strict';
import test from 'node:test';
import * as page from './page.js';

const rect = (left, top, width, height) => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

const leaf = (text, box, tab = null) => ({
  tagName: 'SPAN',
  textContent: text,
  children: [],
  getBoundingClientRect: () => box,
  scrollIntoView: () => {},
  contains(candidate) { return candidate === this; },
  closest(selector) {
    assert.equal(selector, '[role="tab"]');
    return tab;
  },
});

const tab = (box, children) => ({
  tagName: 'DIV',
  textContent: '',
  children,
  getBoundingClientRect: () => box,
  scrollIntoView: () => {},
  contains(candidate) { return candidate === this || children.includes(candidate); },
});

function evaluate(expression, nodes) {
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'body *');
      return nodes;
    },
    elementFromPoint(x, y) {
      return [...nodes].reverse().find((node) => {
        const box = node.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      }) ?? null;
    },
  };
  const window = { innerWidth: 1280, innerHeight: 900 };
  return new Function('document', 'window', 'getComputedStyle', `return ${expression};`)(
    document,
    window,
    () => ({ visibility: 'visible', display: 'block' }),
  );
}

test('收票信息 prefers an authored form-tab role over a same-named heading', () => {
  const navigation = leaf('收票信息', rect(271, 130, 82, 30));
  const navigationTab = tab(rect(271, 130, 82, 30), [navigation]);
  navigation.closest = (selector) => {
    assert.equal(selector, '[role="tab"]');
    return navigationTab;
  };
  // Simulate a scrolled section heading that happens to enter the upper viewport band.
  const sectionHeading = leaf('收票信息', rect(100, 130, 120, 30));
  const nodes = [navigationTab, navigation, sectionHeading];

  // The live step-four failure: generic exact text sees both structural alternatives and refuses to click.
  assert.deepEqual(evaluate(page.textPoint('收票信息'), nodes), { ok: false, count: 2 });

  assert.deepEqual(evaluate(page.formSectionPoint('收票信息'), nodes), {
    ok: true,
    x: 312,
    y: 145,
    inView: true,
    onTarget: true,
    hitTag: 'SPAN',
    hitText: '收票信息',
    strategy: 'role-tab',
    roleTabCount: 1,
    topNavigationCount: 2,
  });
});

test('收票信息 uses the established top-navigation fallback when no role is authored', () => {
  const navigation = leaf('收票信息', rect(271, 130, 82, 30));
  const sectionHeading = leaf('收票信息', rect(100, 420, 120, 30));
  const nodes = [navigation, sectionHeading];

  assert.deepEqual(evaluate(page.formSectionPoint('收票信息'), nodes), {
    ok: true,
    x: 312,
    y: 145,
    inView: true,
    onTarget: true,
    hitTag: 'SPAN',
    hitText: '收票信息',
    strategy: 'top-navigation-band',
    roleTabCount: 0,
    topNavigationCount: 1,
  });
});

test('收票信息 fails closed when the top-navigation fallback is ambiguous', () => {
  const nodes = [
    leaf('收票信息', rect(271, 130, 82, 30)),
    leaf('收票信息', rect(370, 130, 82, 30)),
    leaf('收票信息', rect(100, 420, 120, 30)),
  ];

  assert.deepEqual(evaluate(page.formSectionPoint('收票信息'), nodes), {
    ok: false,
    count: 2,
    strategy: 'top-navigation-band',
    roleTabCount: 0,
    topNavigationCount: 2,
  });
});

test('收票信息 fails closed when two authored tabs have the same caption', () => {
  const first = leaf('收票信息', rect(271, 130, 82, 30));
  const second = leaf('收票信息', rect(370, 130, 82, 30));
  const firstTab = tab(rect(271, 130, 82, 30), [first]);
  const secondTab = tab(rect(370, 130, 82, 30), [second]);
  first.closest = () => firstTab;
  second.closest = () => secondTab;

  assert.deepEqual(evaluate(page.formSectionPoint('收票信息'), [firstTab, first, secondTab, second]), {
    ok: false,
    count: 2,
    strategy: 'role-tab',
    roleTabCount: 2,
    topNavigationCount: 2,
  });
});
