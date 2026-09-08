import { afterEach } from 'vitest'

// Runs for every test file, but only does anything under jsdom. Node-environment
// files keep their current behaviour and pay nothing for this.
if (typeof document !== 'undefined') {
  const [{ cleanup }, matchers, { expect }] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/matchers'),
    import('vitest'),
  ])
  expect.extend(matchers.default ?? matchers)
  afterEach(() => cleanup())

  // Node 22 defines a disabled experimental `localStorage` global, which wins
  // over jsdom's when Vitest copies the window onto globalThis. The cloud layer
  // reads localStorage on nearly every call, so install a real one.
  if (!globalThis.localStorage) {
    const store = new Map<string, string>()
    const storage: Storage = {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => Array.from(store.keys())[index] ?? null,
      removeItem: (key) => {
        store.delete(key)
      },
      setItem: (key, value) => {
        store.set(key, String(value))
      },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    })
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    })
  }

  // jsdom implements neither of these and several screens call them.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
}
