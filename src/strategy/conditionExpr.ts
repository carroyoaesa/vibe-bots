/**
 * Parser/evaluador de EXPRESIONES de condición (Fase 8) - generaliza `buyConditionId`/
 * `sellConditionId` (Fase 7, un solo id de `CONDITIONS`) para soportar combinaciones de
 * 2-3 condiciones con AND/OR, exactamente la sintaxis que ya produce
 * `bots/backtests/src/runMultiCondMatrix.ts` y `runTripleCondMatrix.ts#shapeLabel`:
 *
 *  - `idA`                          (trivial, un solo id - igual a Fase 7).
 *  - `idA&idB`, `idA|idB`           (2 condiciones, AND/OR).
 *  - `AND(idA+idB+idC)`, `OR(idA+idB+idC)`   (3 condiciones, todas AND o todas OR).
 *  - `(idA&idB)|idC`, `(idA|idB)&idC` y sus permutaciones simétricas (3 condiciones,
 *    formas mixtas - un único par agrupado entre paréntesis combinado con el tercer literal).
 *
 * No soporta negaciones ni anidamiento más profundo - es toda la gramática que produce
 * el reporte de `bots/backtests` (tier 1/2/3, 8 formas lógicas para 3 literales).
 *
 * Un id simple (`idA`) sigue funcionando exactamente igual que en Fase 7 - cero
 * regresión para los símbolos sin override en `multiConditionOverrides.ts`.
 */
import { CONDITIONS, ConditionAction, IndicatorContext } from './conditions';

export type ConditionExprNode =
  | { kind: 'leaf'; id: string }
  | { kind: 'and'; children: ConditionExprNode[] }
  | { kind: 'or'; children: ConditionExprNode[] };

/** `AND(a+b+c)` -> `a&b&c`, `OR(a+b+c)` -> `a|b|c`. Cualquier otra cosa pasa sin tocar. */
function normalize(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^(AND|OR)\((.+)\)$/);
  if (!wrapped) return trimmed;

  const [, op, inner] = wrapped;
  const parts = inner.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`Expresión de condición vacía dentro de "${op}(...)": "${raw}"`);
  }
  const joiner = op === 'AND' ? '&' : '|';
  return parts.join(joiner);
}

function tokenize(expr: string, raw: string): string[] {
  const tokens = expr.match(/[A-Za-z0-9_]+|[&|()]/g);
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) {
    throw new Error(`No se pudo tokenizar la expresión de condición: "${raw}"`);
  }
  return tokens;
}

/** Recursive descent: or := and ('|' and)*  |  and := atom ('&' atom)*  |  atom := '(' or ')' | ID */
function parseTokens(tokens: string[], raw: string): ConditionExprNode {
  let pos = 0;
  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];

  function parseOr(): ConditionExprNode {
    const children = [parseAnd()];
    while (peek() === '|') {
      advance();
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0] : { kind: 'or', children };
  }

  function parseAnd(): ConditionExprNode {
    const children = [parseAtom()];
    while (peek() === '&') {
      advance();
      children.push(parseAtom());
    }
    return children.length === 1 ? children[0] : { kind: 'and', children };
  }

  function parseAtom(): ConditionExprNode {
    const tok = advance();
    if (tok === undefined) {
      throw new Error(`Expresión de condición incompleta: "${raw}"`);
    }
    if (tok === '(') {
      const node = parseOr();
      if (advance() !== ')') {
        throw new Error(`Falta paréntesis de cierre en expresión de condición: "${raw}"`);
      }
      return node;
    }
    if (tok === '&' || tok === '|' || tok === ')') {
      throw new Error(`Token inesperado "${tok}" en expresión de condición: "${raw}"`);
    }
    if (!CONDITIONS.some((c) => c.id === tok)) {
      throw new Error(`Condición desconocida "${tok}" en expresión "${raw}" (revisar catálogo en strategy/conditions.ts#CONDITIONS)`);
    }
    return { kind: 'leaf', id: tok };
  }

  const result = parseOr();
  if (pos !== tokens.length) {
    throw new Error(`Tokens sobrantes al parsear expresión de condición: "${raw}"`);
  }
  return result;
}

/**
 * Parsea una expresión de condición. Lanza un Error inmediatamente si la sintaxis no
 * matchea la gramática soportada o si algún id hoja no existe en `CONDITIONS` - esto es
 * un bug de autoría estática (typo en `multiConditionOverrides.ts`), no una falla
 * externa en runtime, así que NO debe absorberse en un fallback silencioso (a
 * diferencia del patrón fail-open usado para la llamada a Claude/Anthropic).
 */
export function parseConditionExpr(raw: string): ConditionExprNode {
  const normalized = normalize(raw);
  const tokens = tokenize(normalized, raw);
  return parseTokens(tokens, raw);
}

/** Evalúa el árbol contra el bar `i` - hoja: la condición da `action`; AND/OR: combinan sus hijos. */
export function evaluateConditionExpr(node: ConditionExprNode, ctx: IndicatorContext, i: number, action: ConditionAction): boolean {
  if (node.kind === 'leaf') {
    const condition = CONDITIONS.find((c) => c.id === node.id);
    if (!condition) throw new Error(`Condición desconocida "${node.id}" (no debería pasar parseConditionExpr)`);
    return condition.evaluate(ctx, i) === action;
  }
  if (node.kind === 'and') return node.children.every((child) => evaluateConditionExpr(child, ctx, i, action));
  return node.children.some((child) => evaluateConditionExpr(child, ctx, i, action));
}

/** Ids hoja en orden de primera aparición, sin duplicados (la gramática no repite condición, pero por las dudas). */
export function leafIds(node: ConditionExprNode): string[] {
  if (node.kind === 'leaf') return [node.id];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const child of node.children) {
    for (const id of leafIds(child)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Compone los `describe()` de cada hoja (preserva el detalle de indicadores de Fase 6.1 en `reason`). */
export function describeConditionExpr(node: ConditionExprNode, ctx: IndicatorContext, i: number): string {
  return leafIds(node)
    .map((id) => CONDITIONS.find((c) => c.id === id)!.describe(ctx, i))
    .join('; ');
}

function substituteLabels(raw: string): string {
  let label = raw;
  for (const condition of CONDITIONS) {
    label = label.replace(new RegExp(`\\b${condition.id}\\b`, 'g'), condition.label);
  }
  return label;
}

/**
 * Versión humana de la expresión cruda, reemplazando cada id hoja por su `.label` y los
 * operadores por palabras ("Y"/"O"). El orden importa: para la forma `AND(a+b+c)`/
 * `OR(a+b+c)` hay que separar por '+' ANTES de sustituir labels, porque varias labels del
 * catálogo ya contienen "+" en su propio texto (p.ej. "Cruce SMA10/SMA30 + RSI<70 +
 * Momentum>0") - sustituir primero y partir después corrompería esas labels. Ningún label
 * contiene "&" ni "|", así que para la forma infija sustituir primero y reemplazar
 * operadores después es seguro.
 */
export function labelConditionExpr(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = trimmed.match(/^(AND|OR)\((.+)\)$/);
  if (wrapped) {
    const [, op, inner] = wrapped;
    const joiner = op === 'AND' ? ' Y ' : ' O ';
    return inner.split('+').map((part) => substituteLabels(part.trim())).join(joiner);
  }
  return substituteLabels(trimmed).replace(/&/g, ' Y ').replace(/\|/g, ' O ');
}

/**
 * Precio estimado de entrada para una expresión de compra compuesta: promedio de
 * `computeEntryPrice` sobre las hojas que efectivamente dispararon BUY en `i` (si ninguna
 * disparó, promedia todas las hojas de la expresión como fallback). Para una expresión
 * trivial (1 sola hoja) es exactamente `computeEntryPrice(ctx, i, esaHoja)` - mismo
 * resultado que Fase 7, cero regresión. Compartido por `signals.ts` y `strategy/backtest.ts`.
 */
export function estimateConditionExprEntryPrice(
  node: ConditionExprNode,
  ctx: IndicatorContext,
  i: number,
  computeEntryPrice: (ctx: IndicatorContext, i: number, conditionId: string) => number | null
): number | null {
  const ids = leafIds(node);
  const triggeredIds = ids.filter((id) => CONDITIONS.find((c) => c.id === id)?.evaluate(ctx, i) === 'BUY');
  const idsToUse = triggeredIds.length > 0 ? triggeredIds : ids;
  const prices = idsToUse.map((id) => computeEntryPrice(ctx, i, id)).filter((p): p is number => p !== null);
  if (prices.length === 0) return null;
  return prices.reduce((sum, p) => sum + p, 0) / prices.length;
}
