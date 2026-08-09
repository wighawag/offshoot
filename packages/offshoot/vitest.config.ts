import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Real git repositories and real network fetches; give them room.
		testTimeout: 120_000,
		hookTimeout: 120_000,
		// git operations in shared temp dirs; keep them from racing.
		fileParallelism: false,
	},
});
