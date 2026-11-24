import { defineConfig } from 'vitest/config';
// Needs the Docker test stack:  docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,   // files share one database / one reset-able test event
    sequence: { concurrent: false },
  },
});
