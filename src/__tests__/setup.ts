// Vitest global setup. jest-dom matchers are registered for the UI tests that
// opt into the jsdom environment via the `// @vitest-environment jsdom` pragma.
// Importing the matcher registration is harmless in the node environment.
import '@testing-library/jest-dom/vitest'

// jsdom does not implement the canvas 2D context — `getContext` THROWS
// "Not implemented" rather than returning null, which surfaces intermittently as
// an unhandled error from the timeline/meter render loops and flakes UI tests.
// Stub it to return null so components that guard on a null context (as ours do)
// no-op cleanly, matching a real browser with no drawing surface.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => null
}
