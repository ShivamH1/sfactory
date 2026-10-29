export class SfactoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SfactoryError";
    this.code = code;
  }
}
export function fail(code, message) { throw new SfactoryError(code, message); }
