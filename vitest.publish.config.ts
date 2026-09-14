import { defineConfig } from 'vitest/config';
export default defineConfig({test:{environment:'node',include:['src/lib/__tests__/instagram-publish.test.ts','src/lib/__tests__/instagram-commercial.test.ts']}});
