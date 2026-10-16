import { defineConfig } from 'vitest/config';
export default defineConfig({
	tsconfig: new URL('./tsconfig.json', import.meta.url).pathname,
	test: { include: ['tests/**/*.test.{ts,mjs}'], environment: 'node' },
});
