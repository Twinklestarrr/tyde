import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const graph = new Map<string, string[]>();
for (const path of sourceFiles(sourceRoot)) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const dependencies: string[] = [];
  function add(specifier: string) {
    if (specifier.startsWith('.'))
      dependencies.push(resolve(dirname(path), specifier).replace(/\.js$/, '.ts'));
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.every((binding) => binding.isTypeOnly)
      )
        continue;
      add(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      add(statement.moduleSpecifier.text);
  }
  // Lazy loading must not hide a cycle that reappears when the command is invoked.
  function inspect(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      add(node.arguments[0].text);
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  graph.set(path, dependencies);
}

test('server runtime dependencies are acyclic, including lazy command imports', () => {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  function visit(path: string) {
    if (active.has(path)) {
      cycles.push([...stack.slice(stack.indexOf(path)), path].map((p) => relative(sourceRoot, p)));
      return;
    }
    if (visited.has(path) || !graph.has(path)) return;
    active.add(path);
    stack.push(path);
    for (const dependency of graph.get(path)!) visit(dependency);
    stack.pop();
    active.delete(path);
    visited.add(path);
  }
  for (const path of graph.keys()) visit(path);
  expect(cycles).toEqual([]);
});

test('infrastructure and domain rules do not depend on business orchestration', () => {
  const violations: string[] = [];
  for (const [path, dependencies] of graph) {
    const name = relative(sourceRoot, path);
    for (const dependency of dependencies) {
      const target = relative(sourceRoot, dependency);
      if (
        (name.startsWith('infrastructure/') && target.startsWith('modules/')) ||
        (name.endsWith('.domain.ts') && /\.(service|repository)\.ts$/.test(target)) ||
        (name.endsWith('.repository.ts') && target.endsWith('.service.ts'))
      )
        violations.push(`${name} -> ${target}`);
    }
  }
  expect(violations).toEqual([]);
});

test('server root contains bootstraps only and application code never imports CLI entrypoints', () => {
  expect(
    readdirSync(sourceRoot)
      .filter((name) => name.endsWith('.ts'))
      .sort(),
  ).toEqual(['app.ts', 'application.ts', 'main.ts']);
  const violations: string[] = [];
  for (const [path, dependencies] of graph) {
    if (relative(sourceRoot, path).startsWith('cli/')) continue;
    for (const dependency of dependencies)
      if (relative(sourceRoot, dependency).startsWith('cli/'))
        violations.push(`${relative(sourceRoot, path)} -> ${relative(sourceRoot, dependency)}`);
  }
  expect(violations).toEqual([]);
});
