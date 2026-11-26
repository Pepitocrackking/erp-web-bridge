// Las pruebas lanzan ráfagas de peticiones desde 127.0.0.1 (p. ej. 160 confirmaciones simultáneas).
// Con los límites reales se llevarían 429, así que aquí se suben. Las pruebas de rate limiting
// (rate-limit.int.spec.ts) fijan sus propios límites antes de crear la aplicación.
process.env.RATE_LIMIT_DEFAULT = "1000000";
process.env.RATE_LIMIT_SYNC = "1000000";
process.env.RATE_LIMIT_STRICT = "1000000";
