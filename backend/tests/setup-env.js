// Test settings, set before any module reads its config.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres:///kaho_studio_test";
process.env.SECRETS_KEY = "a".repeat(64);
process.env.INTERNAL_API_TOKEN = "t".repeat(48);
process.env.ALLOWED_ORIGINS = "http://localhost:5173";
process.env.PORT = "8020";
process.env.LOG_LEVEL = "silent";
process.env.WEBHOOK_SECRET = "hook-secret";
process.env.MAX_CALL_DURATION_SECS = "600";
for (const key of ["PLIVO_FROM_NUMBER", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "REDIS_URL",
  "TRANSFER_NUMBER", "TOOL_WEBHOOK_URL"]) delete process.env[key];
// Fake Plivo and a fake voice server, started by tests/fakes.js.
process.env.PLIVO_API_BASE = "http://127.0.0.1:18765";
process.env.PUBLIC_HOST = "127.0.0.1:18766";
process.env.PUBLIC_SCHEME = "http";
process.env.PLIVO_DIAL_TIMEOUT_MS = "3000";
process.env.STREAM_WAIT_SECS = "2";
process.env.MAX_STREAMS_PER_USER = "2";
