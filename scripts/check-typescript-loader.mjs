import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceRoot = new URL('../src/', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Production imports use Vite's extensionless resolution. Resolve only an
  // existing source .ts file; package imports and JSON keep Node's own rules.
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier, context.parentURL);
    if (candidate.href.startsWith(sourceRoot) && !path.extname(candidate.pathname)) {
      candidate.pathname += '.ts';
      try {
        if ((await stat(candidate)).isFile()) return { url: candidate.href, shortCircuit: true };
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith(sourceRoot) || !new URL(url).pathname.endsWith('.ts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
  });
  const errors = diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) || [];
  if (errors.length) throw new Error(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  return { format: 'module', source: outputText, shortCircuit: true };
}
