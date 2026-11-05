import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

test('holiday fetch compiles when a deployment builder supplies partial web globals', () => {
  const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(configFile.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
  expect(config.errors).toEqual([]);
  const virtualPath = fileURLToPath(
    new URL('../../src/__fetch_environment_check__.d.ts', import.meta.url),
  );
  const entry = fileURLToPath(
    new URL('../../src/modules/attendance/holiday-calendar.service.ts', import.meta.url),
  );
  const options = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === virtualPath
      ? ts.createSourceFile(
          path,
          'export {}; declare global { var onmessage: unknown; }',
          languageVersion,
        )
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: [entry, virtualPath], options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => '\n',
    }),
  ).toBe('');
}, 15000);
