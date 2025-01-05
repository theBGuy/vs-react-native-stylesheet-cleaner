### Project Overview

**Project Name**: react-native-stylesheet-cleaner

**Description**: This VS Code extension helps clean up unused styles in React Native projects. It identifies and removes unused styles from your stylesheets, making your code cleaner and more maintainable.

### Features

1. **Identify Unused Styles**: Scans your React Native stylesheets and identifies styles that are not used anywhere in your code.
2. **Remove Unused Styles**: Provides commands to remove all unused styles or a single unused style.
3. **Diagnostics**: Highlights unused styles in your code with warnings.
4. **Auto Clean on Save**: Optionally, automatically clean unused styles when you save your file.

### Requirements

- Visual Studio Code version 1.96.0 or higher.
- Works with JavaScript React (`.jsx`) and TypeScript React (`.tsx`) files.

### Extension Settings

This extension contributes the following settings:

- `react-native-stylesheet-cleaner.autoCleanOnSave`: Enable/disable automatic cleaning of unused styles on file save.

### Commands

- `extension.removeAllUnusedStyles`: Remove all unused styles from the current document.
- `extension.removeSingleUnusedStyle`: Remove a single unused style from the current document.

### Known Issues

- None reported yet.

### Release Notes

#### 1.0.0

- Initial release of react-native-stylesheet-cleaner.
- Features include identifying and removing unused styles, diagnostics, and optional auto clean on save.

### Example Usage

1. **Identify Unused Styles**: Open a React Native file and see warnings for unused styles.
2. **Remove Unused Styles**: Use the command palette or context menu to remove unused styles.
3. **Auto Clean on Save**: Enable the `autoCleanOnSave` setting to automatically clean unused styles on save.

### Usage Instructions

1. **Install the Extension**: Search for `react-native-stylesheet-cleaner` in the VS Code extensions marketplace and install it.
2. **Configure Settings**: Go to your VS Code settings and configure the `autoCleanOnSave` option if desired.
3. **Use Commands**: Use the command palette (`Ctrl+Shift+P`) to run `Remove All Unused Styles` or `Remove Single Unused Style`.

### Example Configuration

```json
{
  "react-native-stylesheet-cleaner.autoCleanOnSave": true
}
```

### Contribution

Feel free to open issues or submit pull requests on the [GitHub repository](https://github.com/your-repo/react-native-stylesheet-cleaner).

