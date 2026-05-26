// Empty CommonJS module used as a webpack replacement for OTel / gRPC /
// aitp imports in the Edge runtime bundle. Edge middleware can neither
// bundle those packages (Node built-ins like fs/path) nor require them
// at runtime, and our middleware doesn't actually call into them — the
// only reason webpack sees them is via static tracing of
// instrumentation.ts. See next.config.ts for the wire-up.
module.exports = {};
