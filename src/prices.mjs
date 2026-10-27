/** USD per million tokens. Estimates for the board's cost figure only; override with config.prices. */
export const DEFAULT_PRICES = Object.freeze({
  "claude-fable-5-1":  { input: 10.0, output: 50.0, cacheRead: 0.25 },
  "claude-opus-5-5":   { input: 4.0,  output: 20.0, cacheRead: 0.20 },
  "claude-sonnet-5-5": { input: 2.0,  output: 10.0, cacheRead: 0.20 },
  "claude-haiku-5-5":  { input: 0.10, output: 0.50, cacheRead: 0.01 },
});
