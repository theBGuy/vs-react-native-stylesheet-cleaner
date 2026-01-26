import * as assert from "node:assert";
import * as path from "node:path";
import ts from "typescript";
import * as vscode from "vscode";

// Re-implement the core functions here for unit testing
// These mirror the implementation in extension.ts

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

          if (ts.isObjectLiteralExpression(arg)) {
            styles[node.name.getText(sourceFile)] = arg;
          } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            const body = arg.body;

            if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
              styles[node.name.getText(sourceFile)] = body.expression;
            } else if (ts.isObjectLiteralExpression(body)) {
              styles[node.name.getText(sourceFile)] = body;
            } else if (ts.isBlock(body)) {
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
          const propertyName = element.propertyName || element.name;
          if (ts.isIdentifier(propertyName)) {
            usedStyles.add(propertyName.getText(sourceFile));
          }
        }
      }
    }

    // Case 4: Spread usage
    if (ts.isSpreadElement(node) && node.expression.getText(sourceFile) === styleSheetName) {
      usedStyles.add("__ENTIRE_STYLESHEET_USED__");
    }

    // Case 5: styles passed as argument or assigned
    if (ts.isIdentifier(node) && node.getText(sourceFile) === styleSheetName) {
      const parent = node.parent;
      if (
        parent &&
        !ts.isVariableDeclaration(parent) &&
        !ts.isPropertyAccessExpression(parent) &&
        !ts.isElementAccessExpression(parent) &&
        !ts.isPropertyAssignment(parent)
      ) {
        usedStyles.add("__ENTIRE_STYLESHEET_USED__");
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return usedStyles;
}

function getUnusedStyles(declaredStyles: string[], usedStyles: Set<string>): string[] {
  if (usedStyles.has("__ENTIRE_STYLESHEET_USED__")) {
    return [];
  }
  return declaredStyles.filter((style) => !usedStyles.has(style));
}

function parseCode(code: string): ts.SourceFile {
  return ts.createSourceFile("test.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function getStyleNames(objectLiteral: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string[] {
  return objectLiteral.properties
    .filter((prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop))
    .map((prop) => prop.name.getText(sourceFile));
}

suite("StyleSheet Declaration Detection", () => {
  test("detects StyleSheet.create", () => {
    const code = `
      const styles = StyleSheet.create({
        container: { flex: 1 },
        text: { color: 'red' }
      });
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);

    assert.ok(declarations.styles, "Should find styles declaration");
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    assert.deepStrictEqual(styleNames, ["container", "text"]);
  });

  test("detects createStyleSheet with direct object", () => {
    const code = `
      const styles = createStyleSheet({
        container: { flex: 1 },
        button: { padding: 10 }
      });
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);

    assert.ok(declarations.styles, "Should find styles declaration");
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    assert.deepStrictEqual(styleNames, ["container", "button"]);
  });

  test("detects createStyleSheet with arrow function returning parenthesized object", () => {
    const code = `
      const styles = createStyleSheet((theme) => ({
        container: { backgroundColor: theme.background },
        text: { color: theme.text }
      }));
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);

    assert.ok(declarations.styles, "Should find styles declaration");
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    assert.deepStrictEqual(styleNames, ["container", "text"]);
  });

  test("detects createStyleSheet with arrow function and block body", () => {
    const code = `
      const styles = createStyleSheet((theme) => {
        return {
          container: { flex: 1 },
          header: { height: 50 }
        };
      });
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);

    assert.ok(declarations.styles, "Should find styles declaration");
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    assert.deepStrictEqual(styleNames, ["container", "header"]);
  });

  test("detects multiple stylesheet declarations", () => {
    const code = `
      const styles = StyleSheet.create({
        container: { flex: 1 }
      });
      const otherStyles = StyleSheet.create({
        wrapper: { padding: 10 }
      });
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);

    assert.ok(declarations.styles, "Should find styles declaration");
    assert.ok(declarations.otherStyles, "Should find otherStyles declaration");
  });
});

suite("Style Usage Detection", () => {
  test("detects property access: styles.container", () => {
    const code = `
      const styles = StyleSheet.create({ container: {}, unused: {} });
      const Component = () => <View style={styles.container} />;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("container"), "Should detect styles.container");
    assert.ok(!usedStyles.has("unused"), "Should not detect unused style");
  });

  test("detects bracket notation with string literal: styles['container']", () => {
    const code = `
      const styles = StyleSheet.create({ container: {}, unused: {} });
      const Component = () => <View style={styles['container']} />;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("container"), "Should detect styles['container']");
  });

  test("detects destructuring: const { container } = styles", () => {
    const code = `
      const styles = StyleSheet.create({ container: {}, text: {}, unused: {} });
      const { container, text } = styles;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("container"), "Should detect destructured container");
    assert.ok(usedStyles.has("text"), "Should detect destructured text");
    assert.ok(!usedStyles.has("unused"), "Should not detect unused style");
  });

  test("detects renamed destructuring: const { container: myContainer } = styles", () => {
    const code = `
      const styles = StyleSheet.create({ container: {} });
      const { container: myContainer } = styles;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("container"), "Should detect the original property name");
  });

  test("detects spread usage and marks all as used", () => {
    const code = `
      const styles = StyleSheet.create({ a: {}, b: {}, c: {} });
      const combined = [...styles];
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("__ENTIRE_STYLESHEET_USED__"), "Should mark entire stylesheet as used");
  });

  test("detects styles passed to function and marks all as used", () => {
    const code = `
      const styles = StyleSheet.create({ a: {}, b: {} });
      someFunction(styles);
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("__ENTIRE_STYLESHEET_USED__"), "Should mark entire stylesheet as used");
  });

  test("detects styles passed as JSX prop and marks all as used", () => {
    const code = `
      const styles = StyleSheet.create({ a: {}, b: {} });
      const Component = () => <Child allStyles={styles} />;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("__ENTIRE_STYLESHEET_USED__"), "Should mark entire stylesheet as used");
  });

  test("handles multiple usage patterns in same file", () => {
    const code = `
      const styles = StyleSheet.create({
        container: {},
        text: {},
        button: {},
        header: {},
        unused: {}
      });
      const Component = () => (
        <View style={styles.container}>
          <Text style={styles['text']} />
        </View>
      );
      const { button } = styles;
    `;
    const sourceFile = parseCode(code);
    const usedStyles = findStyleUsages(sourceFile, "styles");

    assert.ok(usedStyles.has("container"), "Should detect property access");
    assert.ok(usedStyles.has("text"), "Should detect bracket notation");
    assert.ok(usedStyles.has("button"), "Should detect destructuring");
    assert.ok(!usedStyles.has("unused"), "Should not detect unused");
  });
});

suite("Unused Styles Calculation", () => {
  test("returns unused styles", () => {
    const declared = ["container", "text", "button", "unused"];
    const used = new Set(["container", "text"]);
    const unused = getUnusedStyles(declared, used);

    assert.deepStrictEqual(unused, ["button", "unused"]);
  });

  test("returns empty array when all styles used", () => {
    const declared = ["container", "text"];
    const used = new Set(["container", "text"]);
    const unused = getUnusedStyles(declared, used);

    assert.deepStrictEqual(unused, []);
  });

  test("returns empty array when entire stylesheet is used", () => {
    const declared = ["a", "b", "c"];
    const used = new Set(["__ENTIRE_STYLESHEET_USED__"]);
    const unused = getUnusedStyles(declared, used);

    assert.deepStrictEqual(unused, []);
  });

  test("returns all styles when none used", () => {
    const declared = ["a", "b", "c"];
    const used = new Set<string>();
    const unused = getUnusedStyles(declared, used);

    assert.deepStrictEqual(unused, ["a", "b", "c"]);
  });
});

suite("Integration Tests", () => {
  test("full flow: detects unused styles in component", () => {
    const code = `
      import { StyleSheet, View, Text } from 'react-native';

      const MyComponent = () => {
        return (
          <View style={styles.container}>
            <Text style={styles.text}>Hello</Text>
          </View>
        );
      };

      const styles = StyleSheet.create({
        container: { flex: 1 },
        text: { fontSize: 16 },
        unusedButton: { padding: 10 },
        unusedHeader: { height: 50 }
      });
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    const usedStyles = findStyleUsages(sourceFile, "styles");
    const unusedStyles = getUnusedStyles(styleNames, usedStyles);

    assert.deepStrictEqual(unusedStyles, ["unusedButton", "unusedHeader"]);
  });

  test("full flow: no unused styles when destructuring is used", () => {
    const code = `
      const styles = StyleSheet.create({
        a: {},
        b: {},
        c: {}
      });
      const { a, b, c } = styles;
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    const usedStyles = findStyleUsages(sourceFile, "styles");
    const unusedStyles = getUnusedStyles(styleNames, usedStyles);

    assert.deepStrictEqual(unusedStyles, []);
  });

  test("full flow: no unused styles when styles object is passed around", () => {
    const code = `
      const styles = StyleSheet.create({
        a: {},
        b: {},
        c: {}
      });
      applyStyles(styles);
    `;
    const sourceFile = parseCode(code);
    const declarations = findStyleSheetCreateDeclarations(sourceFile);
    const styleNames = getStyleNames(declarations.styles, sourceFile);
    const usedStyles = findStyleUsages(sourceFile, "styles");
    const unusedStyles = getUnusedStyles(styleNames, usedStyles);

    assert.deepStrictEqual(unusedStyles, []);
  });
});

suite("AutoCleanOnSave Integration Tests", () => {
  const testFileContent = `import { StyleSheet, View, Text } from 'react-native';

const MyComponent = () => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Hello</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  text: { fontSize: 16 },
  unusedButton: { padding: 10 },
  unusedHeader: { height: 50 }
});
`;

  let testDocument: vscode.TextDocument;
  let originalConfig: boolean | undefined;

  suiteSetup(async () => {
    // Store original config value
    const config = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    originalConfig = config.get<boolean>("autoCleanOnSave");
  });

  suiteTeardown(async () => {
    // Restore original config value
    const config = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    await config.update("autoCleanOnSave", originalConfig, vscode.ConfigurationTarget.Global);
  });

  test("configuration can be read correctly", async () => {
    // Test setting to true - need to re-fetch config after update
    await vscode.workspace
      .getConfiguration("react-native-stylesheet-cleaner")
      .update("autoCleanOnSave", true, vscode.ConfigurationTarget.Global);

    // Re-fetch configuration to get updated value
    const configAfterTrue = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    const valueTrue = configAfterTrue.get<boolean>("autoCleanOnSave");
    console.log("Config value after setting to true:", valueTrue);
    console.log("Full config inspect:", configAfterTrue.inspect("autoCleanOnSave"));
    assert.strictEqual(valueTrue, true, "Config should be true after setting to true");

    // Test setting to false
    await vscode.workspace
      .getConfiguration("react-native-stylesheet-cleaner")
      .update("autoCleanOnSave", false, vscode.ConfigurationTarget.Global);

    const configAfterFalse = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    const valueFalse = configAfterFalse.get<boolean>("autoCleanOnSave");
    assert.strictEqual(valueFalse, false, "Config should be false after setting to false");
  });

  test("extension activates for TSX files", async () => {
    // Create a new untitled document with TSX content
    testDocument = await vscode.workspace.openTextDocument({
      language: "typescriptreact",
      content: testFileContent,
    });

    assert.strictEqual(testDocument.languageId, "typescriptreact", "Document should be typescriptreact");
  });

  test("diagnostics are created for unused styles", async () => {
    // Open the document in an editor to trigger diagnostics
    await vscode.window.showTextDocument(testDocument);

    // Wait for diagnostics to be computed (debounced at 300ms)
    await new Promise((resolve) => setTimeout(resolve, 500));

    const diagnostics = vscode.languages.getDiagnostics(testDocument.uri);
    const unusedStyleDiagnostics = diagnostics.filter(
      (d) => d.source === "react-native-stylesheet-cleaner" && d.code === "unusedStyle",
    );

    assert.strictEqual(unusedStyleDiagnostics.length, 2, "Should have 2 unused style diagnostics");

    const messages = unusedStyleDiagnostics.map((d) => d.message);
    assert.ok(
      messages.some((m) => m.includes("unusedButton")),
      "Should have diagnostic for unusedButton",
    );
    assert.ok(
      messages.some((m) => m.includes("unusedHeader")),
      "Should have diagnostic for unusedHeader",
    );

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("removeAllUnusedStyles command works", async () => {
    // Create a fresh document
    const doc = await vscode.workspace.openTextDocument({
      language: "typescriptreact",
      content: testFileContent,
    });

    await vscode.window.showTextDocument(doc);

    // Execute the remove all command
    await vscode.commands.executeCommand("extension.removeAllUnusedStyles", doc);

    // Wait for edits to be applied
    await new Promise((resolve) => setTimeout(resolve, 300));

    const newContent = doc.getText();

    // Verify unused styles are removed
    assert.ok(!newContent.includes("unusedButton"), "unusedButton should be removed");
    assert.ok(!newContent.includes("unusedHeader"), "unusedHeader should be removed");

    // Verify used styles are still present
    assert.ok(newContent.includes("container"), "container should still exist");
    assert.ok(newContent.includes("text"), "text should still exist");

    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  test("autoCleanOnSave removes unused styles on save", async () => {
    // Enable autoCleanOnSave
    await vscode.workspace
      .getConfiguration("react-native-stylesheet-cleaner")
      .update("autoCleanOnSave", true, vscode.ConfigurationTarget.Global);

    // Wait for config to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify config is set (re-fetch to get fresh value)
    const freshConfig = vscode.workspace.getConfiguration("react-native-stylesheet-cleaner");
    const configValue = freshConfig.get<boolean>("autoCleanOnSave");
    console.log("autoCleanOnSave config value:", configValue);
    console.log("Config inspect:", freshConfig.inspect("autoCleanOnSave"));

    // Create a temporary file (untitled documents can't trigger onWillSaveTextDocument properly)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const testFilePath = workspaceFolder
      ? path.join(workspaceFolder.uri.fsPath, "test-autoclean.tsx")
      : path.join(__dirname, "test-autoclean.tsx");

    const testUri = vscode.Uri.file(testFilePath);

    // Write test content to file
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(testUri, encoder.encode(testFileContent));

    try {
      // Open the file
      const doc = await vscode.workspace.openTextDocument(testUri);
      const editor = await vscode.window.showTextDocument(doc);

      // Wait for extension to process the file
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify file has unused styles before save
      const contentBefore = doc.getText();
      assert.ok(contentBefore.includes("unusedButton"), "File should have unusedButton before save");
      assert.ok(contentBefore.includes("unusedHeader"), "File should have unusedHeader before save");

      // Make the document dirty by adding and removing a space
      // This ensures onWillSaveTextDocument is triggered
      await editor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(0, 0), " ");
      });
      await editor.edit((editBuilder) => {
        editBuilder.delete(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)));
      });

      console.log("Document dirty state:", doc.isDirty);

      // Save the document - this should trigger autoCleanOnSave
      const saved = await doc.save();
      assert.ok(saved, "Document should save successfully");

      // Wait for edits to be applied
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Re-read the file to get the updated content
      const updatedDoc = await vscode.workspace.openTextDocument(testUri);
      const contentAfter = updatedDoc.getText();

      // Log for debugging
      console.log("Content after save:", contentAfter);

      // Verify unused styles are removed
      assert.ok(!contentAfter.includes("unusedButton"), "unusedButton should be removed after save");
      assert.ok(!contentAfter.includes("unusedHeader"), "unusedHeader should be removed after save");

      // Verify used styles are still present
      assert.ok(contentAfter.includes("container"), "container should still exist after save");
      assert.ok(contentAfter.includes("text"), "text should still exist after save");

      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally {
      // Cleanup: delete the test file
      try {
        await vscode.workspace.fs.delete(testUri);
      } catch {
        // Ignore cleanup errors
      }

      // Disable autoCleanOnSave
      await vscode.workspace
        .getConfiguration("react-native-stylesheet-cleaner")
        .update("autoCleanOnSave", false, vscode.ConfigurationTarget.Global);
    }
  });
});
