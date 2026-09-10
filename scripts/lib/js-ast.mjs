import ts from "typescript";

export function parseSource(source, path) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.JS,
  );
}
const bindingsByFile = new WeakMap();
function bindingsFor(node) {
  const file = node.getSourceFile();
  let bindings = bindingsByFile.get(file);
  if (bindings) return bindings;
  const found = new Map();
  visit(file, (candidate) => {
    if (
      !ts.isVariableDeclaration(candidate) ||
      !candidate.initializer ||
      !ts.isIdentifier(candidate.name) ||
      !(candidate.parent.flags & ts.NodeFlags.Const)
    )
      return;
    const values = found.get(candidate.name.text) ?? [];
    values.push(candidate.initializer);
    found.set(candidate.name.text, values);
  });
  bindings = new Map(
    [...found]
      .filter(([, values]) => values.length === 1)
      .map(([name, values]) => [name, values[0]]),
  );
  bindingsByFile.set(file, bindings);
  return bindings;
}
function constantValue(node, state, locals = new Map()) {
  if (!node || ++state.steps > 1000) return null;
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  )
    return node.text;
  if (ts.isParenthesizedExpression(node))
    return constantValue(node.expression, state, locals);
  if (ts.isIdentifier(node)) {
    if (locals.has(node.text)) return locals.get(node.text);
    const initializer = state.bindings.get(node.text);
    if (!initializer || state.active.has(initializer)) return null;
    state.active.add(initializer);
    const value = constantValue(initializer, state, locals);
    state.active.delete(initializer);
    return value;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = constantValue(span.expression, state, locals);
      if (part === null || Array.isArray(part)) return null;
      value += part + span.literal.text;
    }
    return value;
  }
  if (
    ts.isTaggedTemplateExpression(node) &&
    ts.isPropertyAccessExpression(node.tag) &&
    ts.isIdentifier(node.tag.expression) &&
    node.tag.expression.text === "String" &&
    node.tag.name.text === "raw"
  ) {
    if (ts.isNoSubstitutionTemplateLiteral(node.template))
      return node.template.rawText ?? node.template.text;
    let value = node.template.head.rawText ?? node.template.head.text;
    for (const span of node.template.templateSpans) {
      const part = constantValue(span.expression, state, locals);
      if (part === null || Array.isArray(part)) return null;
      value += part + (span.literal.rawText ?? span.literal.text);
    }
    return value;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantValue(node.left, state, locals),
      right = constantValue(node.right, state, locals);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = [];
    for (const element of node.elements) {
      const spread = ts.isSpreadElement(element);
      const value = constantValue(
        spread ? element.expression : element,
        state,
        locals,
      );
      if (value === null || (spread && !Array.isArray(value))) return null;
      if (spread) values.push(...value);
      else values.push(value);
    }
    return values;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    const target = node.expression.expression,
      name = node.expression.name.text;
    if (
      ts.isIdentifier(target) &&
      target.text === "String" &&
      name === "fromCharCode"
    ) {
      const codes = node.arguments.map((argument) =>
        Number(constantValue(argument, state, locals)),
      );
      return codes.some(
        (code) => !Number.isInteger(code) || code < 0 || code > 65535,
      )
        ? null
        : String.fromCharCode(...codes);
    }
    if (name === "join" && node.arguments.length <= 1) {
      const values = constantValue(target, state, locals);
      const separator = node.arguments.length
        ? constantValue(node.arguments[0], state, locals)
        : ",";
      return !Array.isArray(values) || separator === null
        ? null
        : values.join(separator);
    }
    if (
      name === "map" &&
      node.arguments.length === 1 &&
      (ts.isArrowFunction(node.arguments[0]) ||
        ts.isFunctionExpression(node.arguments[0]))
    ) {
      const values = constantValue(target, state, locals),
        callback = node.arguments[0];
      if (
        !Array.isArray(values) ||
        callback.parameters.length !== 1 ||
        !ts.isIdentifier(callback.parameters[0].name) ||
        ts.isBlock(callback.body)
      )
        return null;
      return values.map((value) =>
        constantValue(
          callback.body,
          state,
          new Map(locals).set(callback.parameters[0].name.text, value),
        ),
      );
    }
    if (name === "toUpperCase" && node.arguments.length === 0) {
      const value = constantValue(target, state, locals);
      return typeof value === "string" ? value.toUpperCase() : null;
    }
  }
  return null;
}
export function constantString(node) {
  const value = constantValue(node, {
    active: new Set(),
    bindings: bindingsFor(node),
    steps: 0,
  });
  return typeof value === "string" ? value : null;
}
function undefinedExpression(node, allowNull = true) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    (allowNull && node.kind === ts.SyntaxKind.NullKeyword) ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}
function noOpBody(body, allowNull = true) {
  if (!ts.isBlock(body)) return undefinedExpression(body, allowNull);
  const statements = body.statements.filter(
    (statement) => !ts.isEmptyStatement(statement),
  );
  if (statements.length === 0) return true;
  if (statements.length !== 1) return false;
  const statement = statements[0];
  return (
    (ts.isExpressionStatement(statement) &&
      undefinedExpression(statement.expression, allowNull)) ||
    (ts.isReturnStatement(statement) &&
      (!statement.expression ||
        undefinedExpression(statement.expression, allowNull)))
  );
}
export function bannedCounts(source, path = "diff.ts") {
  const file = parseSource(source, path),
    counts = new Map();
  const add = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const directive of file.commentDirectives ?? [])
    if (
      source
        .slice(directive.range.pos, directive.range.end)
        .includes("@ts-ignore")
    )
      add("@ts-ignore");
  visit(file, (node) => {
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) add("as any");
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) add("as never");
      if (
        ts.isAsExpression(node.expression) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
      )
        add("as unknown as");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments.length === 1 &&
      (ts.isArrowFunction(node.arguments[0]) ||
        ts.isFunctionExpression(node.arguments[0])) &&
      noOpBody(node.arguments[0].body)
    )
      add("silent catch");
    if (ts.isCatchClause(node) && noOpBody(node.block, false))
      add("empty catch");
  });
  counts.set(
    ["Coming", "soon"].join(" "),
    [...source.matchAll(/Coming\s+soon/gi)].length,
  );
  return counts;
}
export function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
export { ts };
