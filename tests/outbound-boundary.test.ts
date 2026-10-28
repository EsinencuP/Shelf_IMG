import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

it('routes server source fetches through outboundFetch', () => {
  const allowed = new Set([
    'src/lib/server/outbound-fetch.ts',
    // Wakes our own worker; does not fetch a catalog, image or search provider.
    'src/lib/server/cloud-dispatch.ts',
  ]);
  const violations: string[] = [];
  for (const path of [...files('src/lib/server'), ...files('src/app/api')]) {
    const name = relative('.', path).replaceAll('\\', '/');
    if (allowed.has(name)) continue;
    const source = ts.createSourceFile(
      name,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      // Also catch aliases such as `const request = fetch` and globalThis.fetch.
      if (ts.isIdentifier(node) && node.text === 'fetch') {
        const parent = node.parent;
        const isDependencyName =
          ts.isTypeQueryNode(parent) ||
          (ts.isPropertySignature(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) &&
            parent.name === node &&
            !['globalThis', 'global'].includes(parent.expression.getText(source)));
        if (!isDependencyName) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${name}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
