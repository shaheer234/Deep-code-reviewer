# Deep code reviewer
 
 Your AI-assisted code review partner inside VS Code.  
> **Marketplace:** [Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ShaheerImran.deep-code-reviewer)

## ✨ Key Features

- LLM-powered analysis (OpenAI gpt-5-mini / gpt-4o-mini) finds bugs, logic errors, and risky patterns.
- Inline diagnostics using the VS Code Diagnostics API (squiggles + Problems panel).
- One-click fixes via Code Actions, with severity-ranked recommendations.
- Deterministic & parseable output for consistent results.

## 🚀 Quickstart (60 seconds)

1. **Install the extension**

    From Marketplace: open VS Code → Extensions → search “deep-code-reviewer” → Install  
    Or click: [Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ShaheerImran.deep-code-reviewer)
   
3. **Set your OpenAI API key**

    Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → Deep Code Reviewer: Set OpenAI API Key  
    (stored securely via VS Code Secrets)

4. **Run a review**

    Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → Deep Code Reviewer: Review Current File  
    You’ll see findings inline and in the Problems panel. Use Apply Fix when available.


## 🧩 Commands

| Command ID                                     | Palette Title                                                       | What it does                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| deep-code-reviewer.setOpenAIKey                | Deep Code Reviewer: Set OpenAI API Key                              | Saves your API key securely                                                      |
| deep-code-reviewer.reviewCode                  | Deep Code Reviewer: Review Current File                             | Sends current file for AI review and surfaces diagnostics                        |
| deep-code-reviewer.showOutput                  | Deep Code Reviewer: Show Output                                     | Opens the extension’s output channel (verbose logs/explanations)                 |
| deep-code-reviewer.applyFix                    | Apply Fix                                                           | Applies an available quick fix (when offered)                                    |

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

## 🐞 Troubleshooting

- **No diagnostics appear** → Ensure API key is set via `Set OpenAI API Key`.  
- **Unstable output** → Extension enforces temperature=0, retry if model responds with invalid JSON.  
- **Slow responses** → Switch to a smaller file or use `gpt-4o-mini`.

## 📸 Screenshots & Visuals

A quick look at Deep Code Reviewer in action inside VS Code:

### 🔎 Inline Diagnostics & Problems Panel
LLM-detected issues are surfaced as squiggles inline and listed in the **Problems** panel.

![Diagnostics & Problems Panel](https://github.com/user-attachments/assets/503ae251-2e0e-4c19-976d-f7cb1545e62b)

---

### 💡 One-Click Fixes
Quickly resolve issues with a single click using **Code Actions**.

![Quick Fix Demo](https://github.com/user-attachments/assets/96816700-0208-4cf9-aa0b-3b8d6431a349)

---

### 📜 Output Channel
See detailed explanations, structured JSON, and logs in the **Deep Code Reviewer** output channel.
<img width="905" height="348" alt="Pasted Graphic 3" src="https://github.com/user-attachments/assets/dcbb90d6-b1eb-4ddc-ae38-b3509eba853f" />

---

### 🧭 Command Palette
Run reviews on demand via **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`).

<img width="609" height="109" alt="Deep Code Reviewer Review Current File" src="https://github.com/user-attachments/assets/549246ff-d956-456e-b133-527207631c97" />




