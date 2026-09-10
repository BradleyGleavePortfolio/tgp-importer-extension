import ts from "typescript";

export function parseSource(source, path) {
    return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
        path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
}
export function constantString(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = constantString(node.left), right = constantString(node.right);
        return left === null || right === null ? null : left + right;
    }
    return null;
}
export function visit(node, callback) {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
}
export { ts };
