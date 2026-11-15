/**
 * Browser-half checks that do not need a running page.
 *
 * The module is loaded through a stub `window.__ModuleLoader__`, its factory
 * receives a minimal React, and `apply()` runs against a fake slot/locale
 * context. This catches syntax errors, a missing registration and unbalanced
 * translation dictionaries without pretending to verify rendered pixels.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Minimal React surface used by the module at definition time only. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: callback => callback,
  useRef: value => ({ current: value }),
}

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value },
  },
}

await import('../client.js')

test('registers one Settings section and its icon with locale dictionaries', () => {
  assert.ok(definition, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-config-transfer')
  const module = definition.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const registrations = []
  const dictionaries = []
  const slots = {
    inject(name, callback) { assert.equal(name, registrations.length === 0 ? 'settings.section' : 'settings.section.icon'); callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  const ctx = {
    effect(callback) { return callback() },
    locale: {
      register(namespace, dicts) { dictionaries.push({ namespace, dicts }); return () => {} },
      bind() { return key => key },
    },
    slots,
  }
  module.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'configTransfer')
  const zh = Object.keys(dictionaries[0].dicts.zh).sort()
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  assert.deepEqual(zh, en, 'zh and en dictionaries must carry the same keys')
  for (const key of ['nav', 'title', 'category.bundles', 'category.plugins', 'category.mcp', 'category.presets', 'export.button', 'import.start']) {
    assert.ok(zh.includes(key), `missing dictionary key ${key}`)
  }

  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'config-transfer')
  assert.equal(registrations[0].options.order, 40)
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(registrations[1].options.name, 'settings.section.icon')
  assert.equal(registrations[1].options.id, 'config-transfer')
  assert.equal(typeof registrations[1].component, 'function')
})

test('the icon renders a 16px current-color glyph', () => {
  const module = definition.factory(() => React)
  let icon
  const ctx = {
    effect: callback => callback(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      inject(name, callback) {
        if (name === 'settings.section.icon') {
          ctx.slots.register = (options, component) => { icon = component; return () => {} }
        }
        callback()
      },
      register: () => () => {},
    },
  }
  module.apply(ctx)
  const tree = icon({ size: 18 })
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 18)
  assert.equal(tree.props['aria-hidden'], true)
  const strings = JSON.stringify(tree)
  assert.match(strings, /currentColor/)
})
