import ts from "typescript";

export function parseSource(source, path) {
  const kind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".ts")
      ? ts.ScriptKind.TS
      : path.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
}
const bindingsByFile = new WeakMap();
function lexicalScope(node) {
  for (let current = node.parent; current; current = current.parent)
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    )
      return current;
  return node.getSourceFile();
}
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
    values.push({
      declaration: candidate,
      initializer: candidate.initializer,
      scope: lexicalScope(candidate),
    });
    found.set(candidate.name.text, values);
  });
  bindings = found;
  bindingsByFile.set(file, bindings);
  return bindings;
}
function bindingFor(node, bindings) {
  const candidates = bindings.get(node.text);
  if (!candidates) return null;
  const scopes = [];
  for (let current = node.parent; current; current = current.parent)
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    )
      scopes.push(current);
  for (const scope of scopes) {
    const match = candidates
      .filter(
        ({ declaration, scope: bindingScope }) =>
          bindingScope === scope && declaration.getStart() < node.getStart(),
      )
      .at(-1);
    if (match) return match.initializer;
  }
  return null;
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
    const initializer = bindingFor(node, state.bindings);
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
      const parameterName = callback.parameters[0].name.text;
      return values.map((value) =>
        constantValue(
          callback.body,
          state,
          new Map(locals).set(parameterName, value),
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
function functionLabel(node) {
  if (node.name) return node.name.getText();
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name
  )
    return parent.name.getText();
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return parent.left.getText();
  if (ts.isCallExpression(parent)) {
    const argument = parent.arguments.indexOf(node),
      fixedArguments = parent.arguments
        .map((value, index) =>
          index === argument || isFunction(value)
            ? "_"
            : value.getText().replace(/\s+/g, " "),
        )
        .join(",");
    return `callback:${parent.expression.getText()}[${argument};${fixedArguments}]`;
  }
  return "anonymous";
}
function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}
function scopeIds(file) {
  const ids = new WeakMap(),
    counts = new Map();
  ids.set(file, "<module>");
  counts.set("<module>", 1);
  function assign(node, parentScope, label) {
    const id = `${ids.get(parentScope)}/${label}`;
    ids.set(node, id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  function walk(node, parentScope) {
    let scope = parentScope;
    if (isFunction(node)) {
      const label = `fn:${functionLabel(node)}`;
      // Callback identity is its complete lexical call path. Sibling callbacks
      // are absent from that path, so insertions cannot renumber descendants.
      assign(node, parentScope, label);
      scope = node;
    } else if (ts.isBlock(node) && !(node.parent && isFunction(node.parent))) {
      assign(node, parentScope, `block:${ts.SyntaxKind[node.parent.kind]}`);
      scope = node;
    }
    ts.forEachChild(node, (child) => walk(child, scope));
  }
  ts.forEachChild(file, (child) => walk(child, file));
  return { ids, counts };
}
function scopeName(node, ids) {
  for (let current = node; current; current = current.parent)
    if (ids.has(current)) return ids.get(current);
  return "<module>";
}
export function bannedNodes(source, path = "diff.ts") {
  const file = parseSource(source, path),
    { ids, counts } = scopeIds(file),
    findings = [];
  const add = (label, node, text = node.getText(file)) => {
    const scope = scopeName(node, ids);
    findings.push({
      label,
      scope,
      scopeInstances: counts.get(scope) ?? 1,
      text: text.replace(/\s+/g, " ").trim(),
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });
  };
  for (const directive of /** @type {any} */ (file).commentDirectives ?? [])
    if (
      source
        .slice(directive.range.pos, directive.range.end)
        .includes("@ts-ignore")
    )
      add(
        "@ts-ignore",
        file,
        source.slice(directive.range.pos, directive.range.end),
      );
  visit(file, (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) add("as any", node);
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) add("as never", node);
      if (
        ts.isAsExpression(node.expression) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
      )
        add("as unknown as", node);
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
      add("silent catch", node);
    if (ts.isCatchClause(node) && noOpBody(node.block, false))
      add("empty catch", node);
  });
  for (const match of source.matchAll(/Coming\s+soon/gi))
    add(["Coming", "soon"].join(" "), file, match[0]);
  return findings;
}
export function bannedCounts(source, path = "diff.ts") {
  const counts = new Map();
  for (const { label } of bannedNodes(source, path))
    counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}
export function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
export { ts };
