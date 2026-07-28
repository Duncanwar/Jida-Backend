// Test environment variables must be set before any module imports src/config/env.ts
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/jida_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-16-chars";
process.env.JWT_ACCESS_EXPIRES_MIN = "15";
process.env.CORS_ORIGIN = "*";
process.env.CORS_ORIGIN = "*";
process.env.APP_URL = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_TTL_HOURS = "24";
process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC = "60";
process.env.EMAIL_VERIFICATION_MAX_SENDS = "5";
// Google sign-in is exercised with a mocked verifier; the value only needs to
// be present so the endpoint is enabled rather than returning 501.
process.env.GOOGLE_CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";
