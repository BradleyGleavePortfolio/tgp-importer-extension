import ts from "typescript";

export function parseSource(source, path) {
    return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
        path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
}
export function constantString(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
    if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) {
            const part = constantString(span.expression);
            if (part === null) return null;
            value += part + span.literal.text;
        }
        return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = constantString(node.left), right = constantString(node.right);
        return left === null || right === null ? null : left + right;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression) &&
        node.arguments.length <= 1) {
        const separator = node.arguments.length ? constantString(node.arguments[0]) : ",";
        const values = node.expression.expression.elements.map(constantString);
        return separator === null || values.includes(null) ? null : values.join(separator);
    }
    return null;
}
export function bannedCounts(source, path = "diff.ts") {
    const file = parseSource(source, path), counts = new Map();
    const add = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const directive of file.commentDirectives ?? [])
        if (source.slice(directive.range.pos, directive.range.end).includes("@ts-ignore")) add("@ts-ignore");
    visit(file, (node) => {
        if (ts.isAsExpression(node)) {
            if (node.type.kind === ts.SyntaxKind.AnyKeyword) add("as any");
            if (node.type.kind === ts.SyntaxKind.NeverKeyword) add("as never");
            if (ts.isAsExpression(node.expression) &&
                node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) add("as unknown as");
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "catch" && node.arguments.length === 1 &&
            ts.isArrowFunction(node.arguments[0])) {
            const body = node.arguments[0].body;
            if (body.kind === ts.SyntaxKind.NullKeyword) add("silent catch null");
            if (ts.isIdentifier(body) && body.text === "undefined") add("silent catch undefined");
            if (ts.isBlock(body) && body.statements.length === 0) add("silent catch block");
        }
        if (ts.isCatchClause(node) && node.block.statements.length === 0) add("empty catch");
    });
    counts.set(["Coming", "soon"].join(" "), [...source.matchAll(/Coming\s+soon/gi)].length);
    return counts;
}
export function visit(node, callback) {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
}
export { ts };
