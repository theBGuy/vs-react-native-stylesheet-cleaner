// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import ts from "typescript";

function findStyleSheetCreateDeclarations(
  sourceFile: ts.SourceFile
): Record<string, ts.ObjectLiteralExpression> {
  const styles: Record<string, ts.ObjectLiteralExpression> = {};

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText() === "StyleSheet.create"
    ) {
      const objectLiteral = node.initializer.arguments[0];
      if (ts.isObjectLiteralExpression(objectLiteral)) {
        styles[node.name.getText()] = objectLiteral;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return styles;
}

function findStyleUsages(
  sourceFile: ts.SourceFile,
  styleSheetName: string
): Set<string> {
  const usedStyles = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText() === styleSheetName
    ) {
      usedStyles.add(node.name.getText());
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return usedStyles;
}

function getUnusedStyles(
  declaredStyles: string[],
  usedStyles: Set<string>
): string[] {
  return declaredStyles.filter((style) => !usedStyles.has(style));
}

function createDiagnostics(
  unusedStyles: string[],
  document: vscode.TextDocument,
  styleNode: ts.ObjectLiteralExpression
): vscode.Diagnostic[] {
  return unusedStyles
    .map((styleName) => {
      const property = styleNode.properties.find(
        (prop) =>
          ts.isPropertyAssignment(prop) && prop.name.getText() === styleName
      );
      if (property) {
        const start = property.getStart();
        const end = property.getEnd();
        const range = new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        );

        const diagnostic = new vscode.Diagnostic(
          range,
          `Style '${styleName}' is unused.`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "unusedStyle";
        diagnostic.source = "react-native-stylesheet-cleaner";
        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        return diagnostic;
      }
      return undefined;
    })
    .filter(
      (diagnostic): diagnostic is vscode.Diagnostic => diagnostic !== undefined
    );
}

function removeStyleFromDocument(
  document: vscode.TextDocument,
  styleName: string,
  styleNode: ts.ObjectLiteralExpression,
  edit: vscode.WorkspaceEdit
) {
  const property = styleNode.properties.find(
    (prop) => ts.isPropertyAssignment(prop) && prop.name.getText() === styleName
  );

  if (property) {
    const start = property.getFullStart();
    const end = property.getEnd();
    const nextChar = document.getText(
      new vscode.Range(document.positionAt(end), document.positionAt(end + 1))
    );

    const previousChar = document.getText(
      new vscode.Range(
        document.positionAt(start - 1),
        document.positionAt(start)
      )
    );

    let adjustedStart = start;
    let adjustedEnd = end;

    if (previousChar.trim() === "") {
      adjustedStart -= 1; // Handle newline before the property
    }

    // Include the trailing comma or newline if present
    if (nextChar === "," || nextChar.trim() === "") {
      adjustedEnd += 1;
    }

    const range = new vscode.Range(
      document.positionAt(adjustedStart),
      document.positionAt(adjustedEnd)
    );

    edit.delete(document.uri, range);
  }
}

function removeSingleUnusedStyleFromDocument(
  document: vscode.TextDocument,
  styleName: string,
  styleNode: ts.ObjectLiteralExpression
) {
  const edit = new vscode.WorkspaceEdit();
  removeStyleFromDocument(document, styleName, styleNode, edit);

  vscode.workspace.applyEdit(edit).then((success) => {
    if (success) {
      vscode.commands.executeCommand("editor.action.formatDocument");
      vscode.window.showInformationMessage(
        `Unused style '${styleName}' removed successfully!`
      );
    } else {
      vscode.window.showErrorMessage("Failed to remove unused style.");
    }
  });
}

function removeUnusedStylesFromDocument(
  document: vscode.TextDocument,
  unusedStyles: string[],
  styleNode: ts.ObjectLiteralExpression
) {
  const edit = new vscode.WorkspaceEdit();

  for (const styleName of unusedStyles) {
    removeStyleFromDocument(document, styleName, styleNode, edit);
  }

  vscode.workspace.applyEdit(edit).then((success) => {
    if (success) {
      vscode.commands.executeCommand("editor.action.formatDocument");
      vscode.window.showInformationMessage(
        "Unused styles removed successfully!"
      );
    } else {
      vscode.window.showErrorMessage("Failed to remove unused styles.");
    }
  });
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  console.log('"react-native-stylesheet-cleaner" is now active!');

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("unusedStyles");
  context.subscriptions.push(diagnosticCollection);

  const removeAllStylesCommand = vscode.commands.registerCommand(
    "extension.removeAllUnusedStyles",
    async (documentOrUri?: vscode.TextDocument | vscode.Uri) => {
      let _document: vscode.TextDocument | undefined;

      if (documentOrUri instanceof vscode.Uri) {
        _document = await vscode.workspace.openTextDocument(documentOrUri);
      } else {
        _document = documentOrUri ?? vscode.window.activeTextEditor?.document;
      }

      if (!_document) {
        vscode.window.showErrorMessage("No active editor found.");
        return;
      }

      if (typeof _document.getText !== 'function') {
        vscode.window.showErrorMessage("Invalid document object.");
        return;
      }

      try {
        const sourceFile = ts.createSourceFile(
          _document.fileName,
          _document.getText(),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        );

        const styleDeclarations = findStyleSheetCreateDeclarations(sourceFile);

        for (const [styleSheetName, objectLiteral] of Object.entries(
          styleDeclarations
        )) {
          const declaredStyles = objectLiteral.properties
            .filter(
              (prop): prop is ts.PropertyAssignment =>
                ts.isPropertyAssignment(prop) && prop.name !== undefined
            )
            .map((prop) => prop.name.getText());
          const usedStyles = findStyleUsages(sourceFile, styleSheetName);
          const unusedStyles = getUnusedStyles(declaredStyles, usedStyles);

          removeUnusedStylesFromDocument(
            _document,
            unusedStyles,
            objectLiteral
          );
        }
      } catch (err) {
        console.error(err);
      }
    }
  );

  const removeSingleStyleCommand = vscode.commands.registerCommand(
    "extension.removeSingleUnusedStyle",
    async (document: vscode.TextDocument, line: number) => {
      const sourceFile = ts.createSourceFile(
        document.fileName,
        document.getText(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const styleDeclarations = findStyleSheetCreateDeclarations(sourceFile);
      for (const [styleSheetName, objectLiteral] of Object.entries(
        styleDeclarations
      )) {
        const declaredStyles = objectLiteral.properties
          .filter(
            (prop): prop is ts.PropertyAssignment =>
              ts.isPropertyAssignment(prop) && prop.name !== undefined
          )
          .map((prop) => prop.name.getText());
        const usedStyles = findStyleUsages(sourceFile, styleSheetName);
        const unusedStyles = getUnusedStyles(declaredStyles, usedStyles);

        const unusedStyleAtLine = unusedStyles.find((style) =>
          objectLiteral.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText() === style &&
              document.positionAt(prop.getStart()).line === line
          )
        );

        if (unusedStyleAtLine) {
          removeSingleUnusedStyleFromDocument(
            document,
            unusedStyleAtLine,
            objectLiteral
          );
        }
      }
    }
  );

  function updateDiagnostics(document: vscode.TextDocument) {
    if (
      document.languageId === "javascriptreact" ||
      document.languageId === "typescriptreact"
    ) {
      const sourceFile = ts.createSourceFile(
        document.fileName,
        document.getText(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const styleDeclarations = findStyleSheetCreateDeclarations(sourceFile);
      const diagnostics: vscode.Diagnostic[] = [];

      for (const [styleSheetName, objectLiteral] of Object.entries(
        styleDeclarations
      )) {
        const declaredStyles = objectLiteral.properties
          .filter(
            (prop): prop is ts.PropertyAssignment =>
              ts.isPropertyAssignment(prop) && prop.name !== undefined
          )
          .map((prop) => prop.name.getText());
        const usedStyles = findStyleUsages(sourceFile, styleSheetName);
        const unusedStyles = getUnusedStyles(declaredStyles, usedStyles);

        diagnostics.push(
          ...createDiagnostics(unusedStyles, document, objectLiteral)
        );
      }

      diagnosticCollection.set(document.uri, diagnostics);
    }
  }

  vscode.workspace.onDidOpenTextDocument(updateDiagnostics);
  vscode.workspace.onDidChangeTextDocument((event) =>
    updateDiagnostics(event.document)
  );

  vscode.workspace.onWillSaveTextDocument(async (event) => {
    const config = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    const autoCleanOnSave = config.get<boolean>("autoCleanOnSave", false);

    if (autoCleanOnSave) {
      const document = event.document;
      const sourceFile = ts.createSourceFile(
        document.fileName,
        document.getText(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const styleDeclarations = findStyleSheetCreateDeclarations(sourceFile);

      for (const [styleSheetName, objectLiteral] of Object.entries(
        styleDeclarations
      )) {
        const declaredStyles = objectLiteral.properties
          .filter(
            (prop): prop is ts.PropertyAssignment =>
              ts.isPropertyAssignment(prop) && prop.name !== undefined
          )
          .map((prop) => prop.name.getText());
        const usedStyles = findStyleUsages(sourceFile, styleSheetName);
        const unusedStyles = getUnusedStyles(declaredStyles, usedStyles);

        removeUnusedStylesFromDocument(
          document,
          unusedStyles,
          objectLiteral
        );
      }
    }
  });

  context.subscriptions.push(removeAllStylesCommand, removeSingleStyleCommand);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "typescriptreact" },
      new UnusedStylesCodeActionProvider(),
      {
        providedCodeActionKinds:
          UnusedStylesCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "javascriptreact" },
      new UnusedStylesCodeActionProvider(),
      {
        providedCodeActionKinds:
          UnusedStylesCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
}

class UnusedStylesCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((diagnostic) => diagnostic.code === "unusedStyle")
      .flatMap((diagnostic) => [
        this.createRemoveSingleStyleAction(diagnostic, document),
        this.createRemoveAllStylesAction(document),
      ]);
  }

  private createRemoveSingleStyleAction(
    diagnostic: vscode.Diagnostic,
    document: vscode.TextDocument
  ): vscode.CodeAction {
    const styleNameMatch = diagnostic.message.match(/Style '(.+?)' is unused/);
    const styleName = styleNameMatch ? styleNameMatch[1] : "unknown style";
    const action = new vscode.CodeAction(
      `Remove unused style '${styleName}'`,
      vscode.CodeActionKind.QuickFix
    );
    action.command = {
      command: "extension.removeSingleUnusedStyle",
      title: "Remove unused style",
      arguments: [document, diagnostic.range.start.line],
    };
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    return action;
  }

  private createRemoveAllStylesAction(
    document: vscode.TextDocument
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "Remove all unused styles",
      vscode.CodeActionKind.QuickFix
    );
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
