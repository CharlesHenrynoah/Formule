/**
 * Passerelle unique des appels execute.
 * Le sélecteur ne fournit pas le code : seul un script parsé, avec run au niveau supérieur, peut partir.
 */
import ts from 'typescript';
import type { DocHint } from './execute-code.ts';

export type GateVerdict = { ok: boolean; reason: string; calls: string[] };

const FORBIDDEN = new Set(['process', 'require', 'eval', 'Function', 'fetch', 'globalThis']);

function chainOf(node: ts.Expression): string[] | null {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const head = chainOf(node.expression);
    return head ? [...head, node.name.text] : null;
  }
  return null;
}

function callShape(node: ts.CallExpression): 'object' | 'hybrid' | 'other' {
  const first = node.arguments[0];
  if (first && ts.isObjectLiteralExpression(first) && node.arguments.length === 1) return 'object';
  if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return 'hybrid';
  return 'other';
}

function expectedShape(hint: DocHint): 'object' | 'hybrid' | null {
  const sample = `${hint.signature ?? ''}\n${hint.example ?? ''}`;
  if (/\(\s*['"`]/.test(sample)) return 'hybrid';
  if (/\(\s*\{/.test(sample)) return 'object';
  return null;
}

/** Analyse syntaxique. Une expression régulière ne décide pas si run existe. */
export function admitExecute(code: string, hints: DocHint[] = []): GateVerdict {
  const source = ts.createSourceFile('run.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const parsed = ts.transpileModule(code, {
    fileName: 'run.js',
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const syntax = [...(source.parseDiagnostics ?? []), ...(parsed.diagnostics ?? [])]
    .map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' '))
    .filter(Boolean);
  if (syntax.length) return { ok: false, reason: `syntaxe : ${syntax[0]}`, calls: [] };

  const run = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'run');
  if (!run) return { ok: false, reason: 'fonction run absente au niveau supérieur', calls: [] };
  const param = run.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param) || param.text !== 'client') {
    return { ok: false, reason: 'run doit recevoir client', calls: [] };
  }

  const calls: string[] = [];
  const forbidden: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) forbidden.push(node.text);
    if (ts.isCallExpression(node)) {
      const path = chainOf(node.expression);
      if (path) {
        calls.push(path.join('.'));
        const hint = hints.find((item) => item.method === path.join('.'));
        const want = hint ? expectedShape(hint) : null;
        const got = callShape(node);
        if (want && got !== 'other' && want !== got) forbidden.push(`signature ${path.join('.')} attend ${want}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (forbidden.length) return { ok: false, reason: `permission ou signature : ${forbidden[0]}`, calls };
  return { ok: true, reason: 'admis', calls };
}
