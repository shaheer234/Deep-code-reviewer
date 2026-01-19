/**
 * Deep Code Reviewer - VS Code Extension
 * 
 * ARCHITECTURE OVERVIEW:
 * =====================
 * This extension provides AI-powered code review directly in VS Code. It supports two modes:
 * 
 * 1. FREE TIER: Uses a backend API (hosted by you) that proxies to OpenAI with rate limiting
 *    - Lower friction for users (no API key needed)
 *    - You control costs and model selection
 *    - Rate limited (e.g., 10 reviews/day per device)
 * 
 * 2. CUSTOM API KEY: Users can provide their own OpenAI API key for unlimited reviews
 *    - Code goes directly to OpenAI (better privacy)
 *    - No rate limits
 *    - Users pay their own costs
 * 
 * KEY DESIGN DECISIONS:
 * --------------------
 * - Dual-path architecture: Seamlessly switches between free tier and custom key
 * - Device-based tracking: Each VS Code installation gets a UUID (stored in globalState)
 *   This allows rate limiting without requiring user accounts
 * - VS Code Diagnostics API: Uses native squiggles + Problems panel (feels integrated)
 * - Code Actions: One-click fixes via VS Code's Quick Fix system
 * - Selection support: Can review entire file OR just selected text (reduces token usage)
 * 
 * INTERVIEW TALKING POINTS:
 * -------------------------
 * - "I built a dual-mode system: free tier for growth, custom key for power users"
 * - "Device-based rate limiting without requiring authentication - good UX trade-off"
 * - "Integrated with VS Code's native diagnostics system for seamless UX"
 * - "Supports both whole-file and selection-based reviews to optimize token costs"
 */

// ============================================================================
// IMPORTS & DEPENDENCIES
// ============================================================================

// VS Code API - provides all extension capabilities (commands, diagnostics, UI, etc.)
import * as vscode from 'vscode';

// OpenAI SDK - for direct API calls when user provides their own key
import OpenAI from 'openai';

// Node.js crypto - for generating unique device IDs
import { randomUUID } from 'crypto';

// ============================================================================
// GLOBAL STATE
// ============================================================================

/**
 * Output Channel: A dedicated log/console window in VS Code
 * Used to show review results, errors, and debug info
 * Created once at activation, reused throughout extension lifetime
 */
let outputChannel: vscode.OutputChannel;

/**
 * Diagnostic Collection: VS Code's system for showing errors/warnings inline
 * This is what creates the red/yellow squiggles under code
 * Each diagnostic has: range (where), message (what), severity (how bad)
 * 
 * Why a collection? VS Code manages multiple diagnostic sources (ESLint, TypeScript, etc.)
 * We register ours with a unique source ID so we can filter/clear only our diagnostics
 */
let diagCollection: vscode.DiagnosticCollection;

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Default backend API URL for free tier
 * 
 * DESIGN DECISION: Hardcoded default, but users can override via settings.json
 * This allows:
 * - Easy deployment (just update this constant)
 * - Self-hosting (users can point to their own backend)
 * - Testing (point to localhost during development)
 * 
 * TODO: Update this after deploying to Railway
 */
const DEFAULT_FREE_TIER_API_URL = 'https://deep-code-reviewer.up.railway.app';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * ReviewIssue: The structure of issues returned by the AI model
 * 
 * This matches the JSON schema we enforce in our prompts
 * Line numbers are 1-based (human-readable), but VS Code uses 0-based internally
 * 
 * INTERVIEW NOTE: This type safety ensures we catch schema mismatches at compile time
 */
type ReviewIssue = {
	line: number; // 1-based line number (what the model returns)
	severity: 'error' | 'warning' | 'info'; // Matches VS Code's DiagnosticSeverity enum
	message: string; // Human-readable description of the issue
	suggestion?: string; // Optional code fix (only for one-liners that can be auto-applied)
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Determines if a fix suggestion is simple enough for one-click application
 * 
 * CRITERIA:
 * - Must exist (not null/undefined)
 * - Must be single line (no newlines)
 * - Must be reasonably short (< 250 chars)
 * 
 * WHY THESE LIMITS?
 * - One-liners are safe to auto-apply (low risk of breaking code)
 * - Short fixes are easier to review before applying
 * - Multi-line fixes require more context (better shown in output channel)
 * 
 * DESIGN DECISION: We only enable Quick Fix for simple, low-risk changes
 * This prevents users from accidentally applying complex refactors
 */
function isOneLineFix(s?: string): boolean {
	if (!s) { return false; }
	if (s.includes("\n")) { return false; }
	if (s.length > 250) { return false; }
	return true;
}

/**
 * Gets or creates a unique device ID for this VS Code installation
 * 
 * HOW IT WORKS:
 * - First time: Generate UUID, store in VS Code's globalState (persists across restarts)
 * - Subsequent calls: Retrieve stored UUID
 * 
 * WHY DEVICE-BASED (not user-based)?
 * - No authentication required (lower friction)
 * - Works offline (UUID stored locally)
 * - Good enough for free tier (prevents casual abuse)
 * 
 * TRADE-OFFS:
 * - Users can clear storage to get new UUID (acceptable for free tier)
 * - Shared computers = shared limits (acceptable trade-off)
 * - For production at scale, would use Redis + user auth
 * 
 * STORAGE: VS Code's globalState API
 * - Persists across extension updates
 * - Scoped to VS Code installation (not workspace)
 * - Automatically cleaned up if extension is uninstalled
 */
async function getOrCreateDeviceId(context: vscode.ExtensionContext): Promise<string> {
	let deviceId = await context.globalState.get<string>('deepCode.deviceId');
	if (!deviceId) {
		deviceId = randomUUID(); // Generate a unique identifier
		await context.globalState.update('deepCode.deviceId', deviceId);
		outputChannel.appendLine(`Device ID created: ${deviceId}`);
	}
	return deviceId;
}

/**
 * Calls the free tier backend API to review code
 * 
 * ARCHITECTURE:
 * Extension → Your Backend → OpenAI API
 * 
 * WHY A BACKEND?
 * - Cost control: You control which model is used (gpt-4o-mini is cheaper)
 * - Rate limiting: Prevent abuse of your OpenAI credits
 * - Security: API keys stay on server, not in extension code
 * - Analytics: Track usage patterns, popular languages, etc.
 * 
 * REQUEST FLOW:
 * 1. Get backend URL (from settings or default)
 * 2. Send POST request with code + device ID
 * 3. Backend checks rate limit, calls OpenAI, returns results
 * 4. Parse response and return to caller
 * 
 * ERROR HANDLING:
 * - 429 (Rate Limited): Show friendly message with usage stats
 * - Other errors: Show error message, suggest using custom API key
 * 
 * INTERVIEW TALKING POINT:
 * "I built a proxy backend to enable free tier while controlling costs.
 *  The backend handles rate limiting, model selection, and cost optimization."
 */
async function reviewWithFreeTier(
	code: string,
	deviceId: string,
	model: string
): Promise<{ content: string | null; usage?: any } | null> {
	try {
		// Get API URL from settings (or use default)
		// This allows users to self-host or use a different backend
		const config = vscode.workspace.getConfiguration("deepCode");
		const apiUrl = config.get<string>("freeTierApiUrl") || DEFAULT_FREE_TIER_API_URL;

		outputChannel.appendLine(`Using free tier API: ${apiUrl}`);
		outputChannel.appendLine(`Device ID: ${deviceId}`);

		// HTTP POST to backend
		// Headers include device ID for rate limiting
		const response = await fetch(`${apiUrl}/v1/review`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Device-ID': deviceId // Backend uses this to track usage
			},
			body: JSON.stringify({ code, model })
		});

		// Handle rate limiting (429 = Too Many Requests)
		// This is the HTTP status code for "you've hit your limit"
		if (response.status === 429) {
			const error: any = await response.json().catch(() => ({}));
			const used = error.used || '?';
			const limit = error.limit || '?';
			const resetAt = error.resetAt ? new Date(error.resetAt).toLocaleTimeString() : 'midnight';

			// Show user-friendly error with upgrade path
			vscode.window.showErrorMessage(
				`Free tier limit reached (${used}/${limit} reviews today). ` +
				`Set your own API key for unlimited reviews. Limit resets at ${resetAt}.`
			);
			return null;
		}

		// Handle other HTTP errors
		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			throw new Error(`API error (${response.status}): ${errorText}`);
		}

		// Parse successful response
		// Backend returns: { content: "...", usage: {...} }
		const result: any = await response.json();

		// Log usage info to output channel (helps users track their quota)
		if (result.usage) {
			outputChannel.appendLine(`📊 Usage: ${result.usage.used}/${result.usage.limit} reviews used today`);
		}

		return {
			content: result.content || null,
			usage: result.usage
		};

	} catch (error: any) {
		outputChannel.appendLine(`❌ Free tier API error: ${error.message}`);
		vscode.window.showErrorMessage(`Free tier review failed: ${error.message}. Try setting your own API key.`);
		return null;
	}
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================

/**
 * This function is called when VS Code activates the extension
 * 
 * ACTIVATION TRIGGERS:
 * - First time a command is executed
 * - VS Code startup (if extension is enabled)
 * 
 * WHAT WE SET UP:
 * 1. Output channel (for logging/review results)
 * 2. Diagnostic collection (for squiggles)
 * 3. Register all commands (set API key, review code, apply fixes, etc.)
 * 
 * LIFECYCLE:
 * - activate() runs once when extension starts
 * - Commands are registered here but execute on-demand
 * - deactivate() runs when extension is disabled/uninstalled
 */
export function activate(context: vscode.ExtensionContext) {

	// ========================================================================
	// INITIALIZE GLOBAL RESOURCES
	// ========================================================================

	/**
	 * Create output channel for review results and logs
	 * Users can view this via: View → Output → "Deep Code Reviewer"
	 * 
	 * WHY OUTPUT CHANNEL?
	 * - Dedicated space (doesn't clutter terminal)
	 * - Can be shown/hidden programmatically
	 * - Supports formatted text (we use emojis/icons)
	 */
	outputChannel = vscode.window.createOutputChannel("Deep Code Reviewer");
	context.subscriptions.push(outputChannel); // Auto-cleanup on deactivation

	/**
	 * Create diagnostic collection for inline code issues
	 * 
	 * HOW IT WORKS:
	 * - We create diagnostics (errors/warnings) and add them to this collection
	 * - VS Code automatically shows them as squiggles + in Problems panel
	 * - Each diagnostic has: range (where), message (what), severity (how bad)
	 * 
	 * SOURCE ID: 'deep-code-review'
	 * - Allows filtering (only show our diagnostics)
	 * - Prevents conflicts with other extensions
	 */
	diagCollection = vscode.languages.createDiagnosticCollection('deep-code-review');
	context.subscriptions.push(diagCollection); // Auto-cleanup on deactivation

	// ========================================================================
	// COMMAND: Set OpenAI API Key
	// ========================================================================

	/**
	 * Command: "Deep Code Reviewer: Set OpenAI API Key"
	 * 
	 * PURPOSE: Allow users to use their own OpenAI API key for unlimited reviews
	 * 
	 * SECURITY:
	 * - Uses VS Code's Secrets API (encrypted storage)
	 * - Never logged or exposed in code
	 * - Stored per-machine (not synced across devices)
	 * 
	 * USER FLOW:
	 * 1. User runs command from palette
	 * 2. Prompt appears asking for API key (password field)
	 * 3. Key is stored securely
	 * 4. Future reviews use this key (bypass free tier)
	 */
	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.setOpenAIKey', async () => {
		const key = await vscode.window.showInputBox({
			prompt: 'Enter your OpenAI API key',
			password: true // Hide input (security)
		});
		if (!key) { return; } // User cancelled

		// Store in VS Code's secure storage (encrypted)
		await context.secrets.store('deepCode.openai.apiKey', key);
		vscode.window.showInformationMessage('OpenAI API key saved securely.');
	}));

	// ========================================================================
	// COMMAND: Apply Fix (Code Action)
	// ========================================================================

	/**
	 * Command: "Apply Fix"
	 * 
	 * HOW IT'S TRIGGERED:
	 * - User clicks lightbulb icon next to diagnostic
	 * - Or right-clicks diagnostic → "Apply Fix"
	 * - Or uses Quick Fix keyboard shortcut
	 * 
	 * WHAT IT DOES:
	 * 1. Extracts fix suggestion from diagnostic.code
	 * 2. Replaces the line with the fixed version
	 * 3. Preserves indentation (important for code formatting)
	 * 4. Removes the diagnostic (squiggle disappears)
	 * 
	 * DESIGN DECISIONS:
	 * - Only works for one-liners (safety)
	 * - Preserves indentation (matches original code style)
	 * - Removes diagnostic after fix (clean UX)
	 * 
	 * INTERVIEW NOTE: This integrates with VS Code's Code Actions system
	 * (the same system used by ESLint, TypeScript, etc.)
	 */
	vscode.commands.registerCommand("deep-code-reviewer.applyFix",
		async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
			const editor = vscode.window.showTextDocument(document);

			// Extract fix from diagnostic.code
			// VS Code stores code actions in diagnostic.code as { value: "..." }
			const fix = (diagnostic.code as { value: string })?.value || null;

			if (!fix) {
				vscode.window.showErrorMessage("No fix suggestion available.");
				return;
			}

			// Get the line to replace
			const lineNum = diagnostic.range.start.line;
			const original = document.lineAt(lineNum).text;

			// Preserve indentation (match original code style)
			const leading = (original.match(/^\s*/)?.[0]) ?? "";
			const indented = leading + fix.trim(); // Keep one-liner aligned

			// Replace the line
			(await editor).edit(b => b.replace(document.lineAt(lineNum).range, indented));

			// Remove the diagnostic (squiggle disappears after fix)
			const currDiagnostics = diagCollection.get(document.uri) || [];
			const newDiagnostics = currDiagnostics.filter(d => d !== diagnostic);
			diagCollection.set(document.uri, newDiagnostics);
		});

	// ========================================================================
	// COMMAND: Show Output
	// ========================================================================

	/**
	 * Command: "Deep Code Reviewer: Show Output"
	 * 
	 * Simple utility to open the output channel
	 * Useful if user closes it and wants to see review results again
	 */
	context.subscriptions.push(vscode.commands.registerCommand("deep-code-reviewer.showOutput", async () => {
		outputChannel.show(true);
	}));

	// ========================================================================
	// COMMAND: Review Code (Main Feature)
	// ========================================================================

	/**
	 * Command: "Deep Code Reviewer: Review Current File"
	 * 
	 * THIS IS THE CORE FEATURE - Everything else supports this
	 * 
	 * FLOW:
	 * 1. Get code (whole file OR selected text)
	 * 2. Check if user has custom API key
	 * 3a. If yes → Call OpenAI directly (unlimited)
	 * 3b. If no → Call free tier backend (rate limited)
	 * 4. Parse JSON response
	 * 5. Convert to VS Code diagnostics (squiggles)
	 * 6. Show results in output channel
	 * 7. Register code actions (lightbulb fixes)
	 * 
	 * SELECTION SUPPORT:
	 * - If user has text selected → only review that (saves tokens/cost)
	 * - If no selection → review entire file
	 * - Line numbers are adjusted to match actual file lines
	 * 
	 * DUAL-PATH ARCHITECTURE:
	 * - Path 1: Custom API key (direct to OpenAI)
	 * - Path 2: Free tier (via backend)
	 * - Both paths return same format, so rest of code is identical
	 */
	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.reviewCode', async () => {
		// ====================================================================
		// STEP 1: Get Editor & Code
		// ====================================================================

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor!');
			return;
		}

		/**
		 * SELECTION-BASED REVIEW:
		 * 
		 * WHY THIS FEATURE?
		 * - Reduces token usage (only send relevant code)
		 * - Faster reviews (less code = faster model response)
		 * - Better UX (review what you're working on, not entire file)
		 * 
		 * HOW IT WORKS:
		 * - Check if user has selected text
		 * - If yes: Extract only selected text
		 * - If no: Extract entire file
		 * - Later: Adjust line numbers to match file (not snippet)
		 */
		const selection = editor.selection;
		const hasSelection = selection && !selection.isEmpty;

		const code = hasSelection
			? editor.document.getText(selection)  // Only selected text
			: editor.document.getText();          // Entire file

		// Get model preference from settings (or default)
		const model = vscode.workspace
			.getConfiguration("deepCode")
			.get<string>("openaiModel") || "gpt-5-mini";

		// ====================================================================
		// STEP 2: Determine Review Path (Free Tier vs Custom Key)
		// ====================================================================

		/**
		 * DUAL-MODE ARCHITECTURE:
		 * 
		 * Check if user has their own API key
		 * - If yes: Use custom key (unlimited, direct to OpenAI)
		 * - If no: Use free tier (rate limited, via backend)
		 * 
		 * WHY THIS DESIGN?
		 * - Free tier: Low friction, gets users started
		 * - Custom key: Power users get unlimited, better privacy
		 * - Seamless switching: User doesn't need to change anything
		 */
		const apiKey = await context.secrets.get('deepCode.openai.apiKey');
		const useFreeTier = !apiKey;

		vscode.window.showInformationMessage(
			useFreeTier ? "Reviewing code with AI (free tier)..." : "Reviewing code with AI..."
		);

		let output: string | null = null;

		// ====================================================================
		// PATH 1: Custom API Key (Direct to OpenAI)
		// ====================================================================

		if (!useFreeTier) {
			try {
				const client = new OpenAI({ apiKey });

				/**
				 * PROMPT ENGINEERING:
				 * 
				 * We use a detailed system prompt to ensure:
				 * - Consistent JSON output format
				 * - Proper severity classification
				 * - Actionable fix suggestions
				 * - Minimal, focused fixes (not entire function rewrites)
				 * 
				 * DETERMINISTIC SETTINGS:
				 * - temperature: 0 (same input = same output)
				 * - seed: 42 (extra determinism)
				 * - response_format: json_object (forces valid JSON)
				 * 
				 * WHY DETERMINISTIC?
				 * - Consistent results (user runs review twice, gets same issues)
				 * - Easier to debug (reproducible)
				 * - Better UX (no random variations)
				 */
				const res = await client.chat.completions.create({
					model,
					temperature: 0, // Deterministic results
					seed: 42,        // Extra determinism
					messages: [
						{
							role: "system",
							content: `Return ONLY a JSON object with a single key "issues". 
					The value of "issues" must be an array of objects, each with:
					{
					"line": number,
					"severity": "error" | "warning" | "info",
					"message": string,
					"suggestion": string
					}
					
					Notes:
					- "suggestion" must be strictly valid code only (no explanations, no prose, no markdown).
					- Do NOT return the entire function unless the fix genuinely requires redefining the whole function.
					- Keep suggestions as short as possible while still fixing the issue.
					- If an undefined function is called, do not stub it with 'pass'. 
  					- Instead, define the function with minimal correct logic that makes the program runnable and preserves intent.
					- When a function is defined, check its internal safety, not only its call sites. 
  					- For example, 'divide(a, b)' must guard against 'b == 0' internally, not just flag specific calls.
					- preserve the nature of the function (eg, recursive, iterative, etc.)
					`
						},

						{
							role: "user",
							content: code
						}
					],
					response_format: { type: "json_object" } // Force JSON output
				});

				output = res.choices[0].message?.content || null;
			} catch (error: any) {
				vscode.window.showErrorMessage(`Review failed: ${error.message}`);
				outputChannel.appendLine(`❌ Custom API key review error: ${error.message}`);
				return;
			}
		}
		// ====================================================================
		// PATH 2: Free Tier (Via Backend)
		// ====================================================================
		else {
			const deviceId = await getOrCreateDeviceId(context);
			const result = await reviewWithFreeTier(code, deviceId, model);

			if (!result || !result.content) {
				// Error already shown in reviewWithFreeTier function
				return;
			}

			output = result.content;
		}

		// ====================================================================
		// STEP 3: Parse JSON Response
		// ====================================================================

		/**
		 * PARSING STRATEGY:
		 * 
		 * Model can return JSON in two formats:
		 * 1. Direct array: [{...}, {...}] (legacy, shouldn't happen)
		 * 2. Object with issues: { "issues": [{...}, {...}] } (expected)
		 * 
		 * We handle both for robustness (defensive programming)
		 */
		let issues: ReviewIssue[] = [];
		try {
			const parsed = JSON.parse(output || "{}");

			if (Array.isArray(parsed)) {
				// Legacy format (direct array)
				issues = parsed;
			} else if (parsed.issues && Array.isArray(parsed.issues)) {
				// Expected format (object with issues key)
				issues = parsed.issues;
			} else {
				vscode.window.showErrorMessage("Unexpected GPT response: " + output);
				return;
			}
		} catch {
			vscode.window.showErrorMessage("Failed to parse GPT response.");
			return;
		}

		// ====================================================================
		// STEP 4: Clear Old Diagnostics
		// ====================================================================

		/**
		 * Clear previous review results before showing new ones
		 * This prevents stale diagnostics from lingering
		 */
		diagCollection.clear();

		// ====================================================================
		// STEP 5: Convert Issues to VS Code Diagnostics
		// ====================================================================

		/**
		 * LINE NUMBER MAPPING:
		 * 
		 * If reviewing selected text, model returns line numbers relative to snippet
		 * We need to map these back to actual file line numbers
		 * 
		 * Example:
		 * - File has 100 lines
		 * - User selects lines 10-20
		 * - Model says "line 3 has an error" (relative to selection start)
		 * - We map: baseLine (9, 0-based) + issue.line (3, 1-based) = line 12 in file
		 */
		const diagnostics: vscode.Diagnostic[] = [];

		// Calculate line offset if reviewing selection
		// baseLine is 0-based, so if selection starts at line 10, baseLine = 9
		const baseLine = hasSelection ? selection.start.line : 0;

		for (const issue of issues) {
			// Convert 1-based model line to 0-based VS Code line, adjusted for selection
			const lineIndex = baseLine + issue.line - 1;

			// Validate line number (prevent out-of-bounds errors)
			if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
				continue; // Skip invalid line numbers
			}

			// Create range covering the entire line
			// VS Code uses Range(startLine, startCol, endLine, endCol)
			const range = new vscode.Range(
				lineIndex, 0, // Start of line
				lineIndex, editor.document.lineAt(lineIndex).text.length // End of line
			);

			// Create diagnostic (this is what shows the squiggle)
			const diagnostic = new vscode.Diagnostic(
				range,
				issue.message,
				issue.severity === "error"
					? vscode.DiagnosticSeverity.Error      // Red squiggle
					: issue.severity === "warning"
						? vscode.DiagnosticSeverity.Warning  // Yellow squiggle
						: vscode.DiagnosticSeverity.Information // Blue squiggle
			);

			// Store fix suggestion in diagnostic.code (if it's a simple one-liner)
			// This enables the lightbulb Quick Fix feature
			if (issue.suggestion && isOneLineFix(issue.suggestion)) {
				// VS Code expects code actions in this format
				diagnostic.code = { value: issue.suggestion } as any;
			}

			// Set source so we can filter our diagnostics
			diagnostic.source = "deep-code-review";
			diagnostics.push(diagnostic);
		}

		// Apply all diagnostics to the document
		// VS Code will automatically show squiggles and add to Problems panel
		diagCollection.set(editor.document.uri, diagnostics);

		// ====================================================================
		// STEP 6: Show Results in Output Channel
		// ====================================================================

		/**
		 * OUTPUT CHANNEL FORMATTING:
		 * 
		 * We format results nicely with:
		 * - Emojis for severity (visual scanning)
		 * - Actual file line numbers (not relative to snippet)
		 * - Suggestions with clear formatting
		 * 
		 * This gives users a readable report they can reference later
		 */
		outputChannel.clear();
		outputChannel.appendLine("🔎 Deep Code Review Results");

		// Show context if reviewing selection
		if (hasSelection) {
			outputChannel.appendLine(`(Reviewing selected text: lines ${selection.start.line + 1}-${selection.end.line + 1})`);
		}

		for (const issue of issues) {
			// Determine severity icon
			let severityIcon = "";
			switch (issue.severity) {
				case "error":
					severityIcon = "[❌ ERROR]";
					break;
				case "warning":
					severityIcon = "[⚠️ WARNING]";
					break;
				case "info":
					severityIcon = "[INFO]";
					break;
				default:
					severityIcon = "";
					break;
			}

			// Calculate actual file line number (1-based for display)
			// baseLine is 0-based, issue.line is 1-based relative to snippet
			// So actual file line (1-based) = baseLine + issue.line
			const actualFileLine = baseLine + issue.line;
			outputChannel.appendLine(`\nLine ${actualFileLine} ${severityIcon} ${issue.message}`);

			// Show suggestion if available
			if (issue.suggestion) {
				if (!isOneLineFix(issue.suggestion)) {
					// Multi-line fix: show with formatting
					outputChannel.appendLine("   💡 Multi-line Fix:\n" + issue.suggestion);
				} else {
					// One-liner: show inline
					outputChannel.appendLine(`   💡 Suggestion: ${issue.suggestion}`);
				}
			}
		}
		outputChannel.show(true); // Auto-open output channel

		// ====================================================================
		// STEP 7: Register Code Actions Provider (Lightbulb Fixes)
		// ====================================================================

		/**
		 * CODE ACTIONS PROVIDER:
		 * 
		 * This enables the lightbulb icon next to diagnostics
		 * When user clicks it, they see "Apply fix: ..." options
		 * 
		 * HOW IT WORKS:
		 * - VS Code calls provideCodeActions() for each diagnostic
		 * - We check if diagnostic has a fix (stored in diagnostic.code)
		 * - If yes, create a CodeAction that calls our applyFix command
		 * - VS Code shows it in the lightbulb menu
		 * 
		 * DESIGN DECISION:
		 * - Only show fixes for one-liners (safety)
		 * - Multi-line fixes shown in output channel only
		 * 
		 * NOTE: This is registered inside the command (not ideal, but works)
		 * In production, would register once at activation
		 */
		vscode.languages.registerCodeActionsProvider("*", {
			provideCodeActions(document, range, context, token) {
				// Filter to only our diagnostics
				return context.diagnostics
					.filter(d => d.source === "deep-code-review")
					.map(d => {
						// Check if diagnostic has a fix suggestion
						if (d.code && typeof d.code === "object" && "value" in d.code) {
							const fix = (d.code as { value: string }).value;

							// Create code action (shows in lightbulb menu)
							const action = new vscode.CodeAction(
								`Apply fix: ${fix}`,
								vscode.CodeActionKind.QuickFix
							);

							// Wire up command to execute when user clicks
							action.command = {
								command: "deep-code-reviewer.applyFix",
								title: "Apply Fix",
								arguments: [document, d] // Pass document and diagnostic
							};
							return action;
						}

						return null;
					})
					.filter(Boolean) as vscode.CodeAction[];
			}
		});
	}));

	// ========================================================================
	// ACTIVATION COMPLETE
	// ========================================================================

	console.log('Congratulations, your extension "deep-code-reviewer" is now active!');
}

/**
 * Called when extension is deactivated (disabled/uninstalled)
 * 
 * VS Code automatically cleans up subscriptions, but this is a good place
 * for any manual cleanup if needed
 */
export function deactivate() {}
