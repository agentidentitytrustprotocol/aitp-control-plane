process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/aitp_cp_test';
process.env.ENROLLMENT_SECRET =
  process.env.ENROLLMENT_SECRET ?? 'integration-test-secret';
process.env.CP_BASE_URL = process.env.CP_BASE_URL ?? 'http://localhost:4000';
