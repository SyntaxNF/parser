import { readdirSync } from 'node:fs';
import path from 'node:path';

// Keep template checkouts separate from application repositories and build output.
export const templateRoot = path.resolve(process.env.SNF_TEMPLATE_ROOT ?? path.resolve(import.meta.dirname, '../../templates'));

export function templateFiles(root = templateRoot): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.snf')) files.push(file);
    }
  };
  visit(root);
  if (!files.length) throw new Error(`No SNF templates found in ${root}`);
  return files.sort();
}

export const templateName = (file: string): string => path.relative(templateRoot, file);
