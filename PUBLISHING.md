# Publishing Guide - Deep Code Reviewer

## 📦 Pre-Publishing Checklist

- [x] README.md updated with new features
- [x] package.json version bumped (0.0.2 → 0.1.0)
- [x] package.json description updated
- [ ] Code compiled and tested
- [ ] Screenshots added to README (placeholders added, need actual screenshots)
- [ ] CHANGELOG.md updated (optional but recommended)

## 🚀 Publishing to VS Code Marketplace

### Step 1: Install VS Code Extension Manager (vsce)

```bash
npm install -g @vscode/vsce
```

### Step 2: Login to Marketplace

```bash
vsce login ShaheerImran
```

You'll need your Personal Access Token from:
- Go to: https://dev.azure.com/shaheerimran/_usersSettings/tokens
- Create new token with "Marketplace (Manage)" scope

### Step 3: Build the Extension

```bash
npm run package
```

This will:
- Run TypeScript type checking
- Run ESLint
- Build with esbuild (production mode)
- Output to `dist/extension.js`

### Step 4: Publish

```bash
vsce publish
```

This will:
- Package the extension
- Upload to VS Code Marketplace
- Create a new version (0.1.0)

### Step 5: Verify

- Check: https://marketplace.visualstudio.com/items?itemName=ShaheerImran.deep-code-reviewer
- Wait 5-10 minutes for the update to appear
- Test installation in a fresh VS Code instance

## 📝 Version Bumping

For future updates:

1. Update version in `package.json`:
   - Patch: `0.1.0` → `0.1.1` (bug fixes)
   - Minor: `0.1.0` → `0.2.0` (new features)
   - Major: `0.1.0` → `1.0.0` (breaking changes)

2. Run `npm run package` to build

3. Run `vsce publish` to publish

## 🖼️ Adding Screenshots

1. Take screenshots of:
   - Tree View sidebar with findings
   - Webview panel showing issue details
   - Selection-based review in action
   - Review stats showing self-correction loop

2. Upload to GitHub:
   - Create a new issue or PR
   - Drag screenshots to upload
   - Copy the asset URLs

3. Update README.md:
   - Replace placeholder text with actual image markdown
   - Use format: `![Description](https://github.com/user-attachments/assets/...)`

## 📋 CHANGELOG.md (Optional)

Create a CHANGELOG.md file to track versions:

```markdown
# Changelog

## [0.1.0] - 2024-01-XX

### Added
- Tree View sidebar for organized findings display
- Webview panel for rich issue details
- Self-correction loop for 99%+ reliability
- Selection-based review (review selected code snippets)
- Free tier support (10 reviews/day, no API key needed)
- Review statistics (model, attempts, tokens) in webview

### Changed
- Removed Code Actions/Quick Fixes (replaced with webview panel)
- Removed Output Channel (replaced with Tree View)
- Updated UI to use native VS Code Tree View and Webview APIs

### Fixed
- Improved error handling for malformed JSON responses
- Better line number mapping for selection-based reviews
```

## ⚠️ Common Issues

### "Extension not found"
- Make sure you're logged in: `vsce login ShaheerImran`
- Check publisher name matches exactly

### "Version already exists"
- Bump version in package.json
- Run `vsce publish` again

### "Build errors"
- Run `npm run check-types` to see TypeScript errors
- Run `npm run lint` to see ESLint errors
- Fix all errors before publishing

## 🔗 Useful Links

- VS Code Extension API: https://code.visualstudio.com/api
- Marketplace Publishing: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code Extension Manager: https://github.com/microsoft/vscode-vsce

