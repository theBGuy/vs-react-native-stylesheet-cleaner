import ts from "typescript";
import * as vscode from "vscode";

// Helper to check if document is a React file
function isReactFile(document: vscode.TextDocument): boolean {
  return document.languageId === "javascriptreact" || document.languageId === "typescriptreact";
}

// Debounce utility
function debounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  let timeoutId: NodeJS.Timeout | undefined;
  return ((...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

function findStyleSheetCreateDeclarations(sourceFile: ts.SourceFile): Record<string, ts.ObjectLiteralExpression> {
  const styles: Record<string, ts.ObjectLiteralExpression> = {};

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callExpression = node.initializer;
      const callText = callExpression.expression.getText(sourceFile);

      if (callText === "StyleSheet.create") {
        const objectLiteral = callExpression.arguments[0];
        if (ts.isObjectLiteralExpression(objectLiteral)) {
          styles[node.name.getText(sourceFile)] = objectLiteral;
        }
      } else if (callText === "createStyleSheet") {
        if (callExpression.arguments.length > 0) {
          const arg = callExpression.arguments[0];

          // Case: createStyleSheet({ ... }) - direct object literal
          if (ts.isObjectLiteralExpression(arg)) {
            styles[node.name.getText(sourceFile)] = arg;
          } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            const body = arg.body;

            // Case: ({params}) => ({ ... })
            if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
              styles[node.name.getText(sourceFile)] = body.expression;
            } else if (ts.isObjectLiteralExpression(body)) {
              // Case: ({params}) => { container: {...} } (implicit return)
              styles[node.name.getText(sourceFile)] = body;
            } else if (ts.isBlock(body)) {
              // Case: ({params}) => { return { ... } }
              const returnStatement = body.statements.find(ts.isReturnStatement);
              if (returnStatement?.expression) {
                const returnExpr = returnStatement.expression;
                if (ts.isObjectLiteralExpression(returnExpr)) {
                  styles[node.name.getText(sourceFile)] = returnExpr;
                } else if (
                  ts.isParenthesizedExpression(returnExpr) &&
                  ts.isObjectLiteralExpression(returnExpr.expression)
                ) {
                  styles[node.name.getText(sourceFile)] = returnExpr.expression;
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return styles;
}

function findStyleUsages(sourceFile: ts.SourceFile, styleSheetName: string): Set<string> {
  const usedStyles = new Set<string>();

  function visit(node: ts.Node) {
    // Case 1: styles.propertyName
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sourceFile) === styleSheetName) {
      usedStyles.add(node.name.getText(sourceFile));
    }

    // Case 2: styles['propertyName'] or styles["propertyName"]
    if (
      ts.isElementAccessExpression(node) &&
      node.expression.getText(sourceFile) === styleSheetName &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      usedStyles.add(node.argumentExpression.text);
    }

    // Case 3: const { prop1, prop2 } = styles
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      node.initializer.getText(sourceFile) === styleSheetName &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        if (ts.isBindingElement(element)) {
          // Handle renamed destructuring: { original: renamed }
          const propertyName = element.propertyName || element.name;
          if (ts.isIdentifier(propertyName)) {
            usedStyles.add(propertyName.getText(sourceFile));
          }
        }
      }
    }

    // Case 4: Spread usage - if the entire styles object is spread or passed, mark all as used
    // e.g., ...styles, someFunc(styles), <Component style={styles} />
    if (ts.isSpreadElement(node) && node.expression.getText(sourceFile) === styleSheetName) {
      // Mark that styles object itself is used (we'll handle this specially)
      usedStyles.add("__ENTIRE_STYLESHEET_USED__");
    }

    // Case 5: styles passed as argument or assigned
    if (ts.isIdentifier(node) && node.getText(sourceFile) === styleSheetName) {
      const parent = node.parent;
      // Skip if it's the declaration itself or property access (already handled)
      if (
        parent &&
        !ts.isVariableDeclaration(parent) &&
        !ts.isPropertyAccessExpression(parent) &&
        !ts.isElementAccessExpression(parent) &&
        !ts.isPropertyAssignment(parent)
      ) {
        // Styles object is used directly (passed to function, JSX prop, etc.)
        usedStyles.add("__ENTIRE_STYLESHEET_USED__");
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return usedStyles;
}

function getUnusedStyles(declaredStyles: string[], usedStyles: Set<string>): string[] {
  // If entire stylesheet is used, no styles are unused
  if (usedStyles.has("__ENTIRE_STYLESHEET_USED__")) {
    return [];
  }
  return declaredStyles.filter((style) => !usedStyles.has(style));
}

// Extracted helper to analyze styles in a document
interface StyleAnalysis {
  styleSheetName: string;
  objectLiteral: ts.ObjectLiteralExpression;
  declaredStyles: string[];
  usedStyles: Set<string>;
  unusedStyles: string[];
}

function analyzeStyles(sourceFile: ts.SourceFile): StyleAnalysis[] {
  const styleDeclarations = findStyleSheetCreateDeclarations(sourceFile);
  const results: StyleAnalysis[] = [];

  for (const [styleSheetName, objectLiteral] of Object.entries(styleDeclarations)) {
    const declaredStyles = objectLiteral.properties
      .filter((prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop) && prop.name !== undefined)
      .map((prop) => prop.name.getText(sourceFile));
    const usedStyles = findStyleUsages(sourceFile, styleSheetName);
    const unusedStyles = getUnusedStyles(declaredStyles, usedStyles);

    results.push({
      styleSheetName,
      objectLiteral,
      declaredStyles,
      usedStyles,
      unusedStyles,
    });
  }

  return results;
}

function createDiagnostics(
  unusedStyles: string[],
  document: vscode.TextDocument,
  styleNode: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): vscode.Diagnostic[] {
  return unusedStyles
    .map((styleName) => {
      const property = styleNode.properties.find(
        (prop) => ts.isPropertyAssignment(prop) && prop.name.getText(sourceFile) === styleName,
      );
      if (property) {
        const start = property.getStart(sourceFile);
        const end = property.getEnd();
        const range = new vscode.Range(document.positionAt(start), document.positionAt(end));

        const diagnostic = new vscode.Diagnostic(
          range,
          `Style '${styleName}' is unused.`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.code = "unusedStyle";
        diagnostic.source = "react-native-stylesheet-cleaner";
        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        return diagnostic;
      }
      return undefined;
    })
    .filter((diagnostic): diagnostic is vscode.Diagnostic => diagnostic !== undefined);
}

function createTextEditForStyleRemoval(
  document: vscode.TextDocument,
  styleName: string,
  styleNode: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): vscode.TextEdit | undefined {
  const property = styleNode.properties.find(
    (prop) => ts.isPropertyAssignment(prop) && prop.name.getText(sourceFile) === styleName,
  );

  if (!property) return undefined;

  const text = document.getText();

  // Use getFullStart() which includes leading trivia (whitespace) for THIS property only
  // This ensures no overlap with previous properties
  const adjustedStart = property.getFullStart();
  let adjustedEnd = property.getEnd();

  // Consume trailing whitespace and comma
  while (adjustedEnd < text.length) {
    const char = text[adjustedEnd];
    if (char === " " || char === "\t") {
      adjustedEnd++;
    } else if (char === ",") {
      adjustedEnd++;
      break;
    } else {
      break;
    }
  }

  const range = new vscode.Range(document.positionAt(adjustedStart), document.positionAt(adjustedEnd));
  return vscode.TextEdit.delete(range);
}

function collectTextEditsForUnusedStyles(
  document: vscode.TextDocument,
  analyses: StyleAnalysis[],
  sourceFile: ts.SourceFile,
): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];

  for (const analysis of analyses) {
    for (const styleName of analysis.unusedStyles) {
      const edit = createTextEditForStyleRemoval(document, styleName, analysis.objectLiteral, sourceFile);
      if (edit) {
        edits.push(edit);
      }
    }
  }

  // Sort edits by start position (reverse order) to ensure proper application
  // This prevents position shifts from affecting subsequent edits
  edits.sort((a, b) => {
    const aStart = document.offsetAt(a.range.start);
    const bStart = document.offsetAt(b.range.start);
    return bStart - aStart;
  });

  return edits;
}

async function applyEditsAndFormat(document: vscode.TextDocument, edits: vscode.TextEdit[]): Promise<boolean> {
  if (edits.length === 0) return true;

  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(document.uri, edits);

  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (success) {
    try {
      await vscode.commands.executeCommand("editor.action.formatDocument");
    } catch {
      // Format may fail, but edit succeeded
    }
    return true;
  }
  return false;
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  console.log('"react-native-stylesheet-cleaner" is now active!');

  const diagnosticCollection = vscode.languages.createDiagnosticCollection("unusedStyles");
  context.subscriptions.push(diagnosticCollection);

  const removeAllStylesCommand = vscode.commands.registerCommand(
    "extension.removeAllUnusedStyles",
    async (documentOrUri?: vscode.TextDocument | vscode.Uri) => {
      let document: vscode.TextDocument | undefined;

      if (documentOrUri instanceof vscode.Uri) {
        document = await vscode.workspace.openTextDocument(documentOrUri);
      } else {
        document = documentOrUri ?? vscode.window.activeTextEditor?.document;
      }

      if (!document) {
        vscode.window.showErrorMessage("No active editor found.");
        return;
      }

      if (!isReactFile(document)) {
        vscode.window.showErrorMessage("This command only works with React (JSX/TSX) files.");
        return;
      }

      try {
        const sourceFile = ts.createSourceFile(
          document.fileName,
          document.getText(),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );

        const analyses = analyzeStyles(sourceFile);
        const edits = collectTextEditsForUnusedStyles(document, analyses, sourceFile);

        if (edits.length === 0) {
          vscode.window.showInformationMessage("No unused styles found.");
          return;
        }

        const success = await applyEditsAndFormat(document, edits);
        if (success) {
          vscode.window.showInformationMessage("Unused styles removed successfully!");
        } else {
          vscode.window.showErrorMessage("Failed to remove unused styles.");
        }
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage("Error removing unused styles.");
      }
    },
  );

  const removeSingleStyleCommand = vscode.commands.registerCommand(
    "extension.removeSingleUnusedStyle",
    async (document: vscode.TextDocument, line: number) => {
      try {
        if (!isReactFile(document)) {
          vscode.window.showErrorMessage("This command only works with React (JSX/TSX) files.");
          return;
        }

        const sourceFile = ts.createSourceFile(
          document.fileName,
          document.getText(),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );

        const analyses = analyzeStyles(sourceFile);

        for (const analysis of analyses) {
          const unusedStyleAtLine = analysis.unusedStyles.find((style) =>
            analysis.objectLiteral.properties.some(
              (prop) =>
                ts.isPropertyAssignment(prop) &&
                prop.name.getText(sourceFile) === style &&
                document.positionAt(prop.getStart(sourceFile)).line === line,
            ),
          );

          if (unusedStyleAtLine) {
            const edit = createTextEditForStyleRemoval(document, unusedStyleAtLine, analysis.objectLiteral, sourceFile);
            if (edit) {
              const success = await applyEditsAndFormat(document, [edit]);
              if (success) {
                vscode.window.showInformationMessage(`Unused style '${unusedStyleAtLine}' removed successfully!`);
              } else {
                vscode.window.showErrorMessage("Failed to remove unused style.");
              }
            }
            return;
          }
        }
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage("Error removing unused style.");
      }
    },
  );

  function updateDiagnostics(document: vscode.TextDocument) {
    if (!isReactFile(document)) {
      return;
    }

    const sourceFile = ts.createSourceFile(
      document.fileName,
      document.getText(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const analyses = analyzeStyles(sourceFile);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const analysis of analyses) {
      diagnostics.push(...createDiagnostics(analysis.unusedStyles, document, analysis.objectLiteral, sourceFile));
    }

    diagnosticCollection.set(document.uri, diagnostics);
  }

  // Debounced version for text changes
  const debouncedUpdateDiagnostics = debounce(updateDiagnostics, 300);

  // Add event listeners to subscriptions for proper disposal
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(updateDiagnostics));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => debouncedUpdateDiagnostics(event.document)),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnosticCollection.delete(document.uri);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (!isReactFile(event.document)) {
        return;
      }

      const config = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
      const autoCleanOnSave = config.get<boolean>("autoCleanOnSave", false);

      if (!autoCleanOnSave) {
        return;
      }

      // Compute edits synchronously to avoid timing issues with waitUntil
      const document = event.document;
      try {
        const sourceFile = ts.createSourceFile(
          document.fileName,
          document.getText(),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );

        const analyses = analyzeStyles(sourceFile);
        const edits = collectTextEditsForUnusedStyles(document, analyses, sourceFile);

        if (edits.length > 0) {
          event.waitUntil(Promise.resolve(edits));
        }
      } catch (err) {
        console.error("Error in autoCleanOnSave:", err);
      }
    }),
  );

  // Initialize diagnostics for already-open documents
  vscode.workspace.textDocuments.forEach(updateDiagnostics);

  context.subscriptions.push(removeAllStylesCommand, removeSingleStyleCommand);

  // Combined CodeActionsProvider registration
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { scheme: "file", language: "typescriptreact" },
        { scheme: "file", language: "javascriptreact" },
      ],
      new UnusedStylesCodeActionProvider(),
      {
        providedCodeActionKinds: UnusedStylesCodeActionProvider.providedCodeActionKinds,
      },
    ),
  );
}

class UnusedStylesCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const unusedStyleDiagnostics = context.diagnostics.filter((diagnostic) => diagnostic.code === "unusedStyle");

    if (unusedStyleDiagnostics.length === 0) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];

    // Add individual remove actions for each diagnostic
    for (const diagnostic of unusedStyleDiagnostics) {
      actions.push(this.createRemoveSingleStyleAction(diagnostic, document));
    }

    // Add "remove all" action only once if there are unused styles
    if (unusedStyleDiagnostics.length > 0) {
      actions.push(this.createRemoveAllStylesAction(document));
    }

    return actions;
  }

  private createRemoveSingleStyleAction(
    diagnostic: vscode.Diagnostic,
    document: vscode.TextDocument,
  ): vscode.CodeAction {
    const styleNameMatch = diagnostic.message.match(/Style '(.+?)' is unused/);
    const styleName = styleNameMatch ? styleNameMatch[1] : "unknown style";
    const action = new vscode.CodeAction(`Remove unused style '${styleName}'`, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "extension.removeSingleUnusedStyle",
      title: "Remove unused style",
      arguments: [document, diagnostic.range.start.line],
    };
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    return action;
  }

  private createRemoveAllStylesAction(document: vscode.TextDocument): vscode.CodeAction {
    const action = new vscode.CodeAction("Remove all unused styles", vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "extension.removeAllUnusedStyles",
      title: "Remove all unused styles",
      arguments: [document],
    };
    return action;
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}
