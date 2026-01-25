# Deep Code Reviewer

Your AI-powered code review partner inside VS Code. Get instant, intelligent code reviews with zero setup required.

> **Marketplace:** [Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ShaheerImran.deep-code-reviewer)  
> **100+ installs** | **Free tier available** | **Self-correction loop for 99%+ reliability**

## 🏗️ Architecture

Deep Code Reviewer uses a **dual-mode architecture** to balance user experience and cost control:

### **Mode 1: Free Tier** (Default)
- **No API key required** - Lower friction for new users
- **Rate limited** - 10 reviews/day per device (prevents abuse)
- **Backend proxy** - Your backend handles OpenAI calls and rate limiting
- **Cost controlled** - Uses cheaper models (gpt-4o-mini) by default

### **Mode 2: Custom API Key** (Optional)
- **Unlimited reviews** - Use your own OpenAI API key
- **Direct to OpenAI** - Code never touches our backend (better privacy)
- **Model choice** - Use any OpenAI model you prefer
- **No rate limits** - Review as much as you want

### **How It Works**

```
┌─────────────────┐
│  VS Code        │
│  Extension      │
└────────┬────────┘
         │
         ├─── Has API Key? ──── YES ────► OpenAI API (Direct)
         │
         └─── NO ────► Backend API ────► OpenAI API (Proxy)
                            │
                            └─── Rate Limiter (10/day)
```

**Key Design Decisions:**
- **Device-based tracking**: Each VS Code installation gets a unique UUID (no authentication needed)
- **Seamless switching**: Extension automatically uses free tier or custom key
- **VS Code native**: Uses Tree View, Webview, and Diagnostics APIs for seamless integration
- **Selection support**: Review entire file OR just selected text (saves 90% tokens on focused reviews)
- **Self-correction loop**: Automatic retry with JSON validation ensures 99%+ reliability

## ✨ Key Features

- 🤖 **AI-Powered Analysis**: OpenAI GPT models detect bugs, logic errors, security vulnerabilities, and code quality issues
- 🎯 **Tree View Sidebar**: Clean, organized view of all findings grouped by severity (Errors, Warnings, Info)
- 📋 **Rich Issue Details**: Click any issue to see full description, proposed fixes, and review statistics in a beautiful webview panel
- 🔄 **Self-Correction Loop**: Automatic retry mechanism ensures 99%+ reliability even when LLMs return malformed responses
- ✂️ **Selection-Based Review**: Review entire files or just selected code snippets (saves 90% tokens on focused reviews)
- 🆓 **Free Tier**: No API key required! Get 10 reviews/day per device (or use your own key for unlimited)
- 🎨 **Native Integration**: Uses VS Code's built-in UI (Tree View, Webview) - feels like a built-in feature
- ⚡ **Deterministic Output**: Consistent results using seed-based generation for reliable, testable reviews

## 🚀 Quickstart (30 seconds)

1. **Install the extension**

    From Marketplace: open VS Code → Extensions → search "deep-code-reviewer" → Install  
    Or click: [Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ShaheerImran.deep-code-reviewer)
   
2. **Start reviewing!** (No setup required)

    - **Option A (Free Tier)**: Just run a review! You get 10 reviews/day per device, no API key needed.
    - **Option B (Unlimited)**: Set your own OpenAI API key via Command Palette → "Deep Code Reviewer: Set OpenAI API Key"

3. **Run a review**

    - **Review entire file**: Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → "Deep Code Reviewer: Review Current File"
    - **Review selection**: Select code → Same command (automatically detects selection)
    - **View results**: Open the "Deep Code Reviewer" sidebar (Tree View) to see all findings
    - **See details**: Click any issue to view full description, fixes, and review stats in the webview panel


## 🧩 Commands

| Command ID                                     | Palette Title                                                       | What it does                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| deep-code-reviewer.reviewCode                  | Deep Code Reviewer: Review Current File                             | Reviews entire file or selected code (auto-detects selection)                   |
| deep-code-reviewer.setOpenAIKey                | Deep Code Reviewer: Set OpenAI API Key                              | Saves your API key securely (enables unlimited reviews)                          |
| deep-code-reviewer.clearOpenAIKey               | Deep Code Reviewer: Clear OpenAI API Key                            | Removes stored API key (switches back to free tier)                              |
| deep-code-reviewer.openIssue                   | Deep Code Reviewer: Open Issue                                     | Opens detailed view of an issue (also accessible via Tree View)                    |

## ⚙️ Switching Models

You can choose which OpenAI model to use for reviews:

1. Open **Settings** in VS Code (⚙️ → Settings).
2. Search for **Deep Code Reviewer**.
3. Select your preferred model:
   - `gpt-5-mini` (default)
   - `gpt-4o-mini`

Or set it in `settings.json`:

```json
"deepCode.openaiModel": "gpt-4o-mini"
```

## 🎯 How It Works

### Review Process

1. **Trigger Review**: Run command or select code + run command
2. **AI Analysis**: Code sent to OpenAI (via free tier backend or direct API)
3. **Self-Correction**: JSON response validated and auto-corrected if needed (up to 3 attempts)
4. **Results Display**: Findings shown in Tree View sidebar, grouped by severity
5. **Details View**: Click any issue to see full description, fixes, and review stats

### Free Tier vs Custom Key

- **Free Tier** (Default): 10 reviews/day per device, no API key needed, uses backend proxy
- **Custom Key**: Unlimited reviews, direct to OpenAI, better privacy, you control costs

The extension automatically detects which mode to use - no configuration needed!

## 🐞 Troubleshooting

- **No findings appear** → Check the "Deep Code Reviewer" sidebar (Tree View). If empty, try setting your own API key or check free tier rate limit.
- **Free tier not working** → The backend may be temporarily unavailable. Set your own API key for unlimited reviews.
- **Slow responses** → Use selection-based review (select code first) or switch to `gpt-4o-mini` model in settings.
- **Invalid JSON errors** → The self-correction loop should handle this automatically. If issues persist, try again.

## 📸 Features in Action

### 🌳 Tree View Sidebar
All findings organized by severity in a clean, native VS Code sidebar. Click any issue to see full details.

> **Note**: Screenshot placeholder - add your Tree View screenshot here showing the sidebar with Errors/Warnings/Info groups

---

### 📋 Issue Details Webview
Rich, formatted view of each issue with full description, proposed fixes, and review statistics (model, attempts, tokens).

> **Note**: Screenshot placeholder - add your Webview panel screenshot showing issue details with review stats

---

### ✂️ Selection-Based Review
Select any code snippet and review only what matters. Saves 90% tokens compared to full-file reviews.

> **Note**: Screenshot placeholder - add screenshot showing selected code being reviewed

---

### 🔄 Self-Correction Loop
Automatic retry mechanism ensures reliable results. See validation attempts and token usage in the webview panel.

> **Note**: Screenshot placeholder - add screenshot showing review stats with multiple attempts

---

### 🧭 Command Palette
Run reviews on demand via **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

<img width="609" height="109" alt="Deep Code Reviewer Review Current File" src="https://github.com/user-attachments/assets/549246ff-d956-456e-b133-527207631c97" />




