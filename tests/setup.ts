// Test environment variables must be set before any module imports src/config/env.ts
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/jida_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-at-least-16-chars";
process.env.JWT_ACCESS_EXPIRES_MIN = "15";
process.env.CORS_ORIGIN = "*";
