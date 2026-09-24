// The `openagentd` module seen by plugins (`import { fetch } from "openagentd"`).
const api = globalThis.__oad_api;
export const {
  definePlugin, defineProvider, log, sleep, fetch, Headers, Response, crypto, base64, utf8, url, env, fs, subprocess, listen,
  pyJsonDumps, pyRepr, parseIsoTimestamp, httpStatusMessage, gemini, native, credentialStore,
  ProviderError, AuthError, ValueError, UnconfiguredError, NetworkError, HttpError, platform, version,
} = api;
export default api;
