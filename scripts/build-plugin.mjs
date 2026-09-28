import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Publish readable JavaScript because plugin dependency installs ignore scripts.
// Do not copy tests, source maps, identities, local state, or dependencies.
const target = new URL('../plugin/runtime/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const name of readdirSync(new URL('../dist/', import.meta.url)).filter(name => name.endsWith('.js'))) {
  const source = readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
  writeFileSync(new URL(name, target), source.replace(/^\/\/# sourceMappingURL=.*\n?/gm, ''));
}
