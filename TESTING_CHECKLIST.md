# Testing Checklist - Deep Code Reviewer

## ✅ Build Status
- [x] TypeScript compilation: **PASSED**
- [x] ESLint: **PASSED**
- [x] Extension build: **PASSED**

## 🧪 Manual Testing Steps

### 1. **Install & Load Extension**
- [ ] Open VS Code in this project directory
- [ ] Press `F5` to launch Extension Development Host
- [ ] Verify extension loads without errors
- [ ] Check Output → "Deep Code Reviewer" channel for activation message

### 2. **Tree View Appears**
- [ ] Look in Explorer sidebar (left panel)
- [ ] Should see **"Deep Code Reviewer"** panel
- [ ] Should see **"Actions"** section at top (collapsed or expanded)
- [ ] Click Actions → should expand to show:
  - Review current file
  - Review selection  
  - Show output
  - Set / update OpenAI API key
  - Clear OpenAI API key

### 3. **Test Free Tier (No API Key)**
- [ ] Make sure you DON'T have an API key set
- [ ] Open any code file (e.g., `src/extension.ts`)
- [ ] In Tree View → Actions → Click **"Review current file"**
- [ ] Should show message: "Reviewing code with AI (free tier)..."
- [ ] Should make request to backend (if running) or show error
- [ ] After review, Tree View should show:
  - Errors (N)
  - Warnings (M)  
  - Info (K)
- [ ] Click an issue → should jump to that line in editor
- [ ] Check Output channel → should show formatted results

### 4. **Test Selection-Based Review**
- [ ] Select some code (e.g., a function)
- [ ] Tree View → Actions → Click **"Review selection"**
- [ ] Should only review selected code
- [ ] Line numbers in results should match actual file lines (not relative to selection)
- [ ] Output channel should show: "(Reviewing selected text: lines X-Y)"

### 5. **Test Custom API Key**
- [ ] Tree View → Actions → Click **"Set / update OpenAI API key"**
- [ ] Enter your OpenAI API key (password field)
- [ ] Should save successfully
- [ ] Run review again → should say "Reviewing code with AI..." (no "free tier")
- [ ] Should call OpenAI directly (check network/console)
- [ ] Tree View → Actions → Click **"Clear OpenAI API key"**
- [ ] Should switch back to free tier

### 6. **Test Diagnostics (Squiggles)**
- [ ] Run a review on a file with issues
- [ ] Should see red/yellow/blue squiggles under problematic lines
- [ ] Hover over squiggle → should show issue message
- [ ] Problems panel (bottom) → should list all issues
- [ ] Issues should be grouped by severity

### 7. **Test Quick Fixes (Lightbulb)**
- [ ] Find an issue with a one-liner suggestion
- [ ] Should see lightbulb icon next to the line
- [ ] Click lightbulb → should show "Apply fix: ..."
- [ ] Click fix → should replace the line
- [ ] Squiggle should disappear after fix

### 8. **Test Tree View Refresh**
- [ ] Run review on File A → Tree View shows issues
- [ ] Switch to File B → Tree View should update (or show empty)
- [ ] Run review on File B → Tree View should update with new issues
- [ ] Switch back to File A → Tree View should show File A's issues

### 9. **Test Error Handling**
- [ ] Free tier: Set invalid backend URL → should show error
- [ ] Free tier: Hit rate limit → should show friendly 429 message
- [ ] Custom key: Invalid API key → should show error
- [ ] No active editor → should show "No active editor!" error

### 10. **Test Output Channel**
- [ ] Tree View → Actions → Click **"Show output"**
- [ ] Should open Output channel
- [ ] Should show formatted review results with:
  - Severity icons (❌ ⚠️ ℹ️)
  - Line numbers
  - Messages
  - Suggestions (if available)

## 🐛 Known Issues / Edge Cases to Test

- [ ] Very large files (> 1000 lines)
- [ ] Empty files
- [ ] Files with no issues (should show empty Tree View)
- [ ] Multiple files open → Tree View should track current file
- [ ] File changes after review → Tree View should still work

## 📝 Notes

- **Backend Testing**: If testing free tier, you'll need backend running locally or deployed
- **API Key**: For custom key testing, use a test key (don't commit real keys!)
- **Network**: Check browser DevTools → Network tab to see API calls

## 🎯 Success Criteria

✅ All checklist items pass  
✅ No console errors  
✅ Tree View updates correctly  
✅ Diagnostics appear/disappear correctly  
✅ Quick fixes work  
✅ Both free tier and custom key paths work  

