import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: (_format, entryName) => {
        return `${entryName}.mjs`;
      },
    },
    rollupOptions: {
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        dir: 'dist/esm',
      },
    },
  },
  plugins: [dts({ include: 'src', outDir: 'dist/type' })],
});
