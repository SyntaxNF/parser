import { rmSync } from 'node:fs';

// Both JavaScript and declaration output must reflect the current source tree.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
