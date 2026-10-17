import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const FACTORY_ID = 'dsh-plugin-phone-bridge'

/**
 * Build the browser modules the bundle asks for.
 * @returns module stubs.
 */
function createModules() {
  const Icon = function Icon() {}
  const primitives = {
    Button: function Button() {},
    Modal: function Modal() {},
    Pill: function Pill() {},
    IconRefreshOutlineRegular: Icon,
    IconTrashOutlineRegular: Icon,
    IconCopyOutlineRegular: Icon,
  }
  return {
    react: {
      useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
      useEffect: () => {},
      useCallback: (callback) => callback,
      useRef: (value) => ({ current: value }),
    },
    jsxRuntime: {
      Fragment: Symbol.for('react.fragment'),
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
    },
    primitives,
  }
}

/**
 * Load the browser bundle exactly as the client module system would.
 * @returns exports and module stubs.
 */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const modules = createModules()
  let registration = null
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  vm.runInNewContext(source, {
    window,
    Symbol,
    Object,
    URL,
    Response,
    Error,
    Array,
    String,
    Number,
    Date,
    Math,
    JSON,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
  }, { filename: 'client.js' })
  assert.ok(registration, 'the bundle registers one module')
  assert.equal(registration.id, FACTORY_ID)
  const require = (specifier) => {
    if (specifier === 'react') return modules.react
    if (specifier === 'react/jsx-runtime') return modules.jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return modules.primitives
    throw new Error(`unexpected module request: ${specifier}`)
  }
  return { exports: registration.factory(require), modules }
}

/** Minimal browser Cordis context recording contributions. */
function createClientContext() {
  const dictionaries = new Map()
  const registrations = []
  return {
    dictionaries,
    registrations,
    ctx: {
      locale: {
        register(namespace, dictionary) {
          dictionaries.set(namespace, dictionary)
          return () => dictionaries.delete(namespace)
        },
        bind() {
          return (key) => key
        },
      },
      slots: {
        inject(name, callback) {
          callback()
          return () => {}
        },
        register(entry, component) {
          registrations.push({ entry, component })
          return () => {}
        },
      },
      effect(callback) {
        const disposer = callback()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
    },
  }
}

test('the bundle registers apply/inject and both dictionaries', async () => {
  const { exports } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
  const { ctx, dictionaries } = createClientContext()
  exports.apply(ctx)
  assert.equal(exports.NS, 'plugin.phoneBridge')
  assert.deepEqual([...dictionaries.keys()], ['plugin.phoneBridge'])
  assert.equal(dictionaries.get('plugin.phoneBridge').en.nav, 'Phone')
  assert.equal(dictionaries.get('plugin.phoneBridge').zh.nav, '手机')
  assert.equal(dictionaries.get('plugin.phoneBridge').en['pair.title'], 'Pair a phone')
})

test('registers exactly one Settings → Phone section', async () => {
  const { exports } = await loadBundle()
  const { ctx, registrations } = createClientContext()
  exports.apply(ctx)
  assert.equal(registrations.length, 1)
  const [{ entry, component }] = registrations
  assert.equal(entry.name, 'settings.section')
  assert.equal(entry.id, 'phone')
  assert.equal(entry.order, 40)
  assert.equal(entry.locale, 'plugin.phoneBridge')
  assert.equal(typeof component, 'function')
  assert.equal(entry.label(), 'nav')
})

test('pure formatting helpers are exported for tests and diagnostics', async () => {
  const { exports } = await loadBundle()
  assert.equal(exports.internals.formatCountdown(119_000), '1:59')
  assert.equal(exports.internals.formatCountdown(0), '0:00')
  assert.equal(exports.internals.formatCountdown(-5), '0:00')
  assert.equal(exports.internals.formatCountdown(120_000), '2:00')
  assert.match(exports.internals.friendlyError({ code: 'listener-offline' }, (key) => key), /status\.notConnected/)
  assert.match(exports.internals.friendlyError({ code: 'store-unavailable' }, (key) => key), /pair\.unavailable/)
})

test('the package manifest exposes the web client and the settings dependency', async () => {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const pkg = JSON.parse(raw)
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(pkg.files.includes('lib'))
})
