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

/**
 * Attempt metadata for self-correction loop visualization
 */
interface ReviewAttempt {
	attempt: number;
	valid: boolean;
	errors: string[];
	tokens: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

/**
 * Latest review state for the Tree View.
 * We keep the most recent run so the sidebar can show a stable list of findings.
 */
let latestReviewState:
	| {
			uri: vscode.Uri;
			issues: ReviewIssue[];
			baseLine: number; // 0-based line offset (0 if whole file, selection.start.line if selection)
			selectionRange?: vscode.Range; // optional, for display context
			attempts?: ReviewAttempt[]; // Self-correction attempt metadata
			totalTokens?: number; // Total tokens across all attempts
			model?: string; // Model used for review
	  }
	| null = null;

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
// TREE VIEW (Sidebar UI)
// ============================================================================

/**
 * Tree item types:
 * - Group nodes (Errors / Warnings / Info)
 * - Issue nodes (expandable if has fix, click to jump to file+line)
 * - Fix nodes (shown when issue is expanded)
 */
type FindingsNode =
	| { kind: 'actionsRoot' }
	| { kind: 'action'; id: ActionId; label: string; description?: string }
	| { kind: 'group'; label: string; severity: ReviewIssue['severity']; count: number }
	| { kind: 'issue'; severity: ReviewIssue['severity']; issue: ReviewIssue; actualLine1Based: number; uri: vscode.Uri };

type ActionId = 'reviewFile' | 'reviewSelection' | 'setApiKey' | 'clearApiKey' | 'showOutput';

/**
 * Provides data to the VS Code Tree View contributed in package.json:
 * - contributes.views.explorer -> id: deepCodeReviewer.findings
 *
 * WHY TREE VIEW?
 * - More \"native\" than an Output Channel for browsing results
 * - Click to jump between issues quickly
 * - Scales well when there are many issues
 */
class FindingsTreeDataProvider implements vscode.TreeDataProvider<FindingsNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<FindingsNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: FindingsNode): vscode.TreeItem {
		if (element.kind === 'actionsRoot') {
			const item = new vscode.TreeItem('Actions', vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon('tools');
			item.contextValue = 'deepCodeReviewer.actionsRoot';
			return item;
		}

		if (element.kind === 'action') {
			const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
			item.description = element.description;
			item.contextValue = 'deepCodeReviewer.action';

			// Map action id to commands (all are registered in activate()).
			const commandById: Record<ActionId, string> = {
				reviewFile: 'deep-code-reviewer.reviewCode',
				reviewSelection: 'deep-code-reviewer.reviewCode', // same command, relies on selection
				setApiKey: 'deep-code-reviewer.setOpenAIKey',
				clearApiKey: 'deep-code-reviewer.clearOpenAIKey',
				showOutput: 'deep-code-reviewer.showOutput'
			};

			item.command = {
				command: commandById[element.id],
				title: element.label
			};

			item.iconPath =
				element.id === 'reviewFile' || element.id === 'reviewSelection'
					? new vscode.ThemeIcon('search')
					: element.id === 'showOutput'
						? new vscode.ThemeIcon('output')
						: element.id === 'clearApiKey'
							? new vscode.ThemeIcon('trash')
							: new vscode.ThemeIcon('key');

			return item;
		}

		if (element.kind === 'group') {
			const item = new vscode.TreeItem(`${element.label} (${element.count})`, vscode.TreeItemCollapsibleState.Expanded);
			item.contextValue = 'deepCodeReviewer.group';
			return item;
		}

		// Issue node - flat list, no expansion
		if (element.kind === 'issue') {
			const line = element.actualLine1Based;
		
			// Truncate label to ~60 chars to prevent Tree View truncation
			// Full details shown in webview panel when clicked
			const maxLabelLength = 60;
			const truncatedMessage = element.issue.message.length > maxLabelLength
				? element.issue.message.substring(0, maxLabelLength - 3) + '...'
				: element.issue.message;
			
			// Issues are not expandable - clicking opens webview panel
			const item = new vscode.TreeItem(
				`Line ${line}: ${truncatedMessage}`,
				vscode.TreeItemCollapsibleState.None
			);
			
			// Tooltip shows full message
			item.tooltip = `Line ${line}: ${element.issue.message}`;
			
			// Show hint if fix is available
			if (element.issue.suggestion) {
				item.description = '💡 Click for details';
			}

		// Use the same icon language as VS Code diagnostics
		item.iconPath =
			element.severity === 'error'
				? new vscode.ThemeIcon('error')
				: element.severity === 'warning'
					? new vscode.ThemeIcon('warning')
					: new vscode.ThemeIcon('info');

		// Clicking opens the issue location
		item.command = {
			command: 'deep-code-reviewer.openIssue',
			title: 'Open Issue',
			arguments: [element.uri, line]
		};

		// Context menu visibility
		item.contextValue = 'deepCodeReviewer.issue';

			return item;
		}

		// Fallback (should never happen)
		return new vscode.TreeItem('Unknown', vscode.TreeItemCollapsibleState.None);
	}

	getChildren(element?: FindingsNode): FindingsNode[] {
		if (!element) {
			// Top-level always shows an \"Actions\" section, even before first review.
			const topLevel: FindingsNode[] = [{ kind: 'actionsRoot' }];

			// If no review has happened yet, we only show Actions.
			if (!latestReviewState) {
				return topLevel;
			}

			const { issues } = latestReviewState;
			const errors = issues.filter(i => i.severity === 'error');
			const warnings = issues.filter(i => i.severity === 'warning');
			const infos = issues.filter(i => i.severity === 'info');

			const nodes: FindingsNode[] = [...topLevel];
			if (errors.length) { nodes.push({ kind: 'group', label: 'Errors', severity: 'error', count: errors.length }); }
			if (warnings.length) { nodes.push({ kind: 'group', label: 'Warnings', severity: 'warning', count: warnings.length }); }
			if (infos.length) { nodes.push({ kind: 'group', label: 'Info', severity: 'info', count: infos.length }); }
			return nodes;
		}

		// Actions section
		if (element.kind === 'actionsRoot') {
			const actions: FindingsNode[] = [
				{ kind: 'action', id: 'reviewFile', label: 'Review current file', description: 'Runs AI review on the active file' },
				{ kind: 'action', id: 'reviewSelection', label: 'Review selection', description: 'Select code first to review only that snippet' },
				{ kind: 'action', id: 'showOutput', label: 'Show output', description: 'Opens the Deep Code Reviewer output channel' },
				{ kind: 'action', id: 'setApiKey', label: 'Set / update OpenAI API key', description: 'Use your own key for unlimited reviews' },
				{ kind: 'action', id: 'clearApiKey', label: 'Clear OpenAI API key', description: 'Switch back to free tier mode' }
			];
			return actions;
		}

		if (!latestReviewState) {
			return [];
		}

		const { uri, issues, baseLine } = latestReviewState;

		// Group node: list issues of that severity
		if (element.kind === 'group') {
			return issues
				.filter(i => i.severity === element.severity)
				.map(i => {
					const actualLine1Based = baseLine + i.line; // baseLine is 0-based, issue.line is 1-based
					return { kind: 'issue', severity: i.severity, issue: i, actualLine1Based, uri } satisfies FindingsNode;
				});
		}

		// Issues are not expandable - clicking opens webview panel
		return [];
	}
}

let findingsProvider: FindingsTreeDataProvider | null = null;

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
		}
	return deviceId;
}

// ============================================================================
// SELF-CORRECTION LOOP FUNCTIONS (For Custom API Key Path)
// ============================================================================

/**
 * VALIDATE REVIEW JSON RESPONSE
 * 
 * Same validation logic as backend - ensures consistency across both paths
 * Validates that OpenAI response matches expected schema
 */
function validateReviewJson(jsonString: string): { isValid: boolean; errors: string[] } {
	const errors: string[] = [];

	try {
		const parsed = JSON.parse(jsonString);

		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			errors.push('Response must be a JSON object (not array or primitive)');
			return { isValid: false, errors };
		}

		if (!('issues' in parsed)) {
			errors.push('Missing required key: "issues"');
			return { isValid: false, errors };
		}

		if (!Array.isArray(parsed.issues)) {
			errors.push('"issues" must be an array');
			return { isValid: false, errors };
		}

		parsed.issues.forEach((issue: any, index: number) => {
			const prefix = `Issue #${index + 1}`;

			if (typeof issue !== 'object' || issue === null) {
				errors.push(`${prefix}: Must be an object`);
				return;
			}

			if (!('line' in issue)) {
				errors.push(`${prefix}: Missing required field "line"`);
			} else if (typeof issue.line !== 'number' || issue.line < 1 || !Number.isInteger(issue.line)) {
				errors.push(`${prefix}: "line" must be a positive integer (>= 1)`);
			}

			if (!('severity' in issue)) {
				errors.push(`${prefix}: Missing required field "severity"`);
			} else if (!['error', 'warning', 'info'].includes(issue.severity)) {
				errors.push(`${prefix}: "severity" must be "error", "warning", or "info" (got "${issue.severity}")`);
			}

			if (!('message' in issue)) {
				errors.push(`${prefix}: Missing required field "message"`);
			} else if (typeof issue.message !== 'string' || issue.message.trim().length === 0) {
				errors.push(`${prefix}: "message" must be a non-empty string`);
			}

			if ('suggestion' in issue && typeof issue.suggestion !== 'string') {
				errors.push(`${prefix}: "suggestion" must be a string (if provided)`);
			}
		});

		if (errors.length > 0) {
			return { isValid: false, errors };
		}

		return { isValid: true, errors: [] };

	} catch (parseError: any) {
		errors.push(`Invalid JSON: ${parseError.message}`);
		return { isValid: false, errors };
	}
}

/**
 * GENERATE CORRECTION PROMPT
 * 
 * When validation fails, generate a prompt that tells the model what's wrong
 * and asks it to fix ONLY the validation errors
 */
function generateCorrectionPrompt(originalPrompt: string, validationErrors: string[]): string {
	const errorList = validationErrors.map((err, i) => `  ${i + 1}. ${err}`).join('\n');

	return `${originalPrompt}

IMPORTANT: Your previous response failed validation. Please correct it.

Validation Errors:
${errorList}

Please return a corrected JSON object that fixes ONLY these validation errors.
- Keep the same structure and content
- Fix ONLY the fields mentioned in the errors above
- Do NOT add new issues or change valid ones
- Ensure all required fields are present and correctly typed`;
}

/**
 * CALL OPENAI WITH SELF-CORRECTION LOOP (For Custom API Key Path)
 * 
 * Same logic as backend - ensures consistent behavior across both paths
 * Retries up to 3 times if validation fails
 */
async function callOpenAIWithSelfCorrection(
	client: OpenAI,
	model: string,
	systemPrompt: string,
	code: string
): Promise<{ content: string | null; attempts: ReviewAttempt[]; success: boolean; totalTokens: number }> {
	const attempts: ReviewAttempt[] = [];
	let currentPrompt = systemPrompt;
	let totalTokens = 0;

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await client.chat.completions.create({
				model,
				seed: 42,
				messages: [
					{ role: 'system', content: currentPrompt },
					{ role: 'user', content: code }
				],
				response_format: { type: 'json_object' }
			});

			const content = response.choices[0].message?.content || '';
			const tokens = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
			totalTokens += tokens.total_tokens;

			const validation = validateReviewJson(content);

			attempts.push({
				attempt,
				valid: validation.isValid,
				errors: validation.errors,
				tokens: {
					prompt_tokens: tokens.prompt_tokens,
					completion_tokens: tokens.completion_tokens,
					total_tokens: tokens.total_tokens
				}
			});

			if (validation.isValid) {
				return {
					content,
					attempts,
					success: true,
					totalTokens
				};
			}

			if (attempt < 3) {
				currentPrompt = generateCorrectionPrompt(systemPrompt, validation.errors);
			}

		} catch (error: any) {
			attempts.push({
				attempt,
				valid: false,
				errors: [`API error: ${error.message}`],
				tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
			});

			if (error.status === 429) {
				break;
			}
		}
	}

	return {
		content: null,
		attempts,
		success: false,
		totalTokens
	};
}

// ============================================================================
// FREE TIER BACKEND INTEGRATION
// ============================================================================

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
): Promise<{ content: string | null; usage?: any; attempts?: ReviewAttempt[]; totalTokens?: number } | null> {
	try {
		// Get API URL from settings (or use default)
		// This allows users to self-host or use a different backend
		const config = vscode.workspace.getConfiguration("deepCode");
		const apiUrl = config.get<string>("freeTierApiUrl") || DEFAULT_FREE_TIER_API_URL;

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
		// Backend returns: { content: "...", usage: {...}, attempts: [...], totalTokens: number }
		const result: any = await response.json();

		return {
			content: result.content || null,
			usage: result.usage,
			attempts: result.attempts || [],
			totalTokens: result.totalTokens || 0
		};

	} catch (error: any) {
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
	// TREE VIEW REGISTRATION (Sidebar Findings)
	// ========================================================================

	/**
	 * Register the Tree View provider so results appear in the Explorer sidebar.
	 * The view id must match package.json -> contributes.views.explorer[].id
	 */
	findingsProvider = new FindingsTreeDataProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('deepCodeReviewer.findings', findingsProvider)
	);

	/**
	 * Webview panel for showing full issue details
	 * Stores the current panel so we can update it when clicking different issues
	 */
	let issueDetailsPanel: vscode.WebviewPanel | undefined = undefined;

	/**
	 * Generate HTML content for the webview panel
	 * Shows full issue description and proposed fix with proper formatting
	 * Also displays self-correction loop stats (attempts, tokens, validation log)
	 */
	function getIssueDetailsWebviewContent(
		issue: ReviewIssue,
		lineNumber: number,
		uri: vscode.Uri,
		reviewState: typeof latestReviewState
	): string {
		const severityLabel = issue.severity.charAt(0).toUpperCase() + issue.severity.slice(1);
		const severityColor = issue.severity === 'error' ? '#f48771' : issue.severity === 'warning' ? '#cca700' : '#3794ff';
		
		// Escape HTML to prevent XSS
		const escapeHtml = (text: string) => {
			return text
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		const messageHtml = escapeHtml(issue.message).replace(/\n/g, '<br>');
		const fixHtml = issue.suggestion ? escapeHtml(issue.suggestion).replace(/\n/g, '<br>') : '<em>No fix suggestion available</em>';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Issue Details</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 20px;
			line-height: 1.6;
		}
		.header {
			border-bottom: 2px solid ${severityColor};
			padding-bottom: 10px;
			margin-bottom: 20px;
		}
		.line-number {
			font-weight: bold;
			font-size: 1.2em;
			color: ${severityColor};
		}
		.severity {
			display: inline-block;
			padding: 4px 8px;
			border-radius: 3px;
			background-color: ${severityColor};
			color: white;
			font-size: 0.9em;
			margin-left: 10px;
		}
		.section {
			margin-bottom: 25px;
		}
		.section-title {
			font-weight: bold;
			font-size: 1.1em;
			margin-bottom: 10px;
			color: var(--vscode-textLink-foreground);
		}
		.description {
			background-color: var(--vscode-textBlockQuote-background);
			border-left: 3px solid ${severityColor};
			padding: 15px;
			border-radius: 4px;
			white-space: pre-wrap;
			word-wrap: break-word;
		}
		.fix-code {
			background-color: var(--vscode-textCodeBlock-background);
			border: 1px solid var(--vscode-panel-border);
			padding: 15px;
			border-radius: 4px;
			font-family: var(--vscode-editor-font-family);
			white-space: pre-wrap;
			word-wrap: break-word;
			overflow-x: auto;
		}
		.file-path {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
			margin-top: 10px;
		}
		.stats-box {
			background-color: var(--vscode-textBlockQuote-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			padding: 15px;
			margin-bottom: 20px;
		}
		.stats-row {
			display: flex;
			justify-content: space-between;
			margin-bottom: 8px;
			font-size: 0.9em;
		}
		.stats-label {
			color: var(--vscode-descriptionForeground);
		}
		.stats-value {
			font-weight: bold;
			color: var(--vscode-foreground);
		}
		.validation-log {
			margin-top: 15px;
			padding-top: 15px;
			border-top: 1px solid var(--vscode-panel-border);
		}
		.attempt-item {
			margin-bottom: 10px;
			padding: 8px;
			background-color: var(--vscode-editor-background);
			border-radius: 3px;
			font-size: 0.85em;
		}
		.attempt-valid {
			color: #4ec9b0;
		}
		.attempt-invalid {
			color: #f48771;
		}
		.attempt-error {
			margin-left: 20px;
			margin-top: 4px;
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}
	</style>
</head>
<body>
	<div class="header">
		<span class="line-number">Line ${lineNumber}</span>
		<span class="severity">${severityLabel}</span>
		<div class="file-path">${escapeHtml(uri.fsPath)}</div>
	</div>

	${reviewState?.attempts && reviewState.attempts.length > 0 ? `
	<div class="section">
		<div class="section-title">📊 Review Stats</div>
		<div class="stats-box">
			${reviewState.model ? `
			<div class="stats-row">
				<span class="stats-label">Model:</span>
				<span class="stats-value">${escapeHtml(reviewState.model)}</span>
			</div>
			` : ''}
			<div class="stats-row">
				<span class="stats-label">Attempts:</span>
				<span class="stats-value">${reviewState.attempts.length}/3</span>
			</div>
			<div class="stats-row">
				<span class="stats-label">Status:</span>
				<span class="stats-value">${reviewState.attempts[reviewState.attempts.length - 1].valid ? '✓ Validated' : '❌ Failed'}</span>
			</div>
			${reviewState.totalTokens ? `
			<div class="stats-row">
				<span class="stats-label">Total Tokens:</span>
				<span class="stats-value">${reviewState.totalTokens.toLocaleString()}</span>
			</div>
			` : ''}
			${reviewState.attempts.length > 1 ? `
			<div class="validation-log">
				<div style="font-weight: bold; margin-bottom: 10px; color: var(--vscode-textLink-foreground);">Validation Log:</div>
				${reviewState.attempts.map((attempt, idx) => `
				<div class="attempt-item">
					<span class="${attempt.valid ? 'attempt-valid' : 'attempt-invalid'}">
						${attempt.valid ? '✓' : '❌'} Attempt ${attempt.attempt}: ${attempt.valid ? 'Valid ✓' : 'Invalid'}
					</span>
					${attempt.errors && attempt.errors.length > 0 ? `
					<div class="attempt-error">
						${attempt.errors.map(err => `• ${escapeHtml(err)}`).join('<br>')}
					</div>
					` : ''}
					${attempt.tokens && attempt.tokens.total_tokens > 0 ? `
					<div class="attempt-error" style="margin-top: 4px;">
						Tokens: ${attempt.tokens.total_tokens.toLocaleString()} (${attempt.tokens.prompt_tokens} input + ${attempt.tokens.completion_tokens} output)
					</div>
					` : ''}
				</div>
				`).join('')}
			</div>
			` : ''}
		</div>
	</div>
	` : ''}

	<div class="section">
		<div class="section-title">📝 Description</div>
		<div class="description">${messageHtml}</div>
	</div>

	<div class="section">
		<div class="section-title">💡 Proposed Fix</div>
		<div class="fix-code">${fixHtml}</div>
	</div>
</body>
</html>`;
	}

	/**
	 * Command: Open Issue
	 * 
	 * Called when user clicks an issue in the Tree View
	 * - Opens webview panel with full issue details (description + fix)
	 * - Also jumps to the line in the editor
	 */
	context.subscriptions.push(
		vscode.commands.registerCommand('deep-code-reviewer.openIssue', async (uri: vscode.Uri, line1Based: number) => {
			// Find the issue details from latestReviewState
			if (!latestReviewState || latestReviewState.uri.toString() !== uri.toString()) {
				vscode.window.showErrorMessage('Issue details not available.');
				return;
			}

			// latestReviewState is guaranteed non-null here (checked above)
			const state = latestReviewState;
			const issue = state.issues.find(i => {
				const actualLine = state.baseLine + i.line;
				return actualLine === line1Based;
			});

			if (!issue) {
				vscode.window.showErrorMessage('Issue not found.');
				return;
			}

			// Jump to line in editor
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc, { preview: true });
			const line0Based = Math.max(0, line1Based - 1);
			const pos = new vscode.Position(line0Based, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

			// Create or update webview panel
			if (issueDetailsPanel) {
				// Update existing panel
				issueDetailsPanel.webview.html = getIssueDetailsWebviewContent(issue, line1Based, uri, state);
				issueDetailsPanel.title = `Issue Details - Line ${line1Based}`;
				issueDetailsPanel.reveal();
			} else {
				// Create new panel
				issueDetailsPanel = vscode.window.createWebviewPanel(
					'deepCodeReviewerIssueDetails',
					`Issue Details - Line ${line1Based}`,
					vscode.ViewColumn.Beside,
					{
						enableScripts: false, // No JS needed for now
						retainContextWhenHidden: true // Keep content when panel is hidden
					}
				);

				issueDetailsPanel.webview.html = getIssueDetailsWebviewContent(issue, line1Based, uri, state);

				// Clean up when panel is closed
				issueDetailsPanel.onDidDispose(() => {
					issueDetailsPanel = undefined;
				}, null, context.subscriptions);
			}
		})
	);

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
	// COMMAND: Clear OpenAI API Key
	// ========================================================================

	/**
	 * Command: \"Deep Code Reviewer: Clear OpenAI API Key\"
	 *
	 * PURPOSE:
	 * - Lets users switch back to free tier mode (backend) without digging into settings
	 * - Helpful when they want to stop using their paid key on a shared machine
	 */
	context.subscriptions.push(vscode.commands.registerCommand('deep-code-reviewer.clearOpenAIKey', async () => {
		await context.secrets.delete('deepCode.openai.apiKey');
		vscode.window.showInformationMessage('OpenAI API key cleared. Using free tier mode (if available).');
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

	/**
	 * Command: Apply fix from Tree View
	 * 
	 * Similar to applyFix but called directly from Tree View fix nodes
	 * Takes URI, line number, and fix text directly
	 */
	context.subscriptions.push(vscode.commands.registerCommand("deep-code-reviewer.applyFixFromTree",
		async (uri: vscode.Uri, lineNumber: number, fix: string) => {
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document);

			// Get the line to replace (lineNumber is 1-based, convert to 0-based)
			const lineIndex = lineNumber - 1;
			if (lineIndex < 0 || lineIndex >= document.lineCount) {
				vscode.window.showErrorMessage("Invalid line number.");
				return;
			}

			const original = document.lineAt(lineIndex).text;

			// Preserve indentation (match original code style)
			const leading = (original.match(/^\s*/)?.[0]) ?? "";
			const indented = leading + fix.trim(); // Keep one-liner aligned

			// Replace the line
			await editor.edit(b => b.replace(document.lineAt(lineIndex).range, indented));

			vscode.window.showInformationMessage("Fix applied successfully!");
			
			// Refresh Tree View to remove the fixed issue
			if (latestReviewState && latestReviewState.uri.toString() === uri.toString()) {
				// Remove the fixed issue from state
				latestReviewState.issues = latestReviewState.issues.filter(
					i => !(i.line === lineNumber && i.suggestion === fix)
				);
				findingsProvider?.refresh();
			}
		}));

	// ========================================================================
	// CODE ACTIONS PROVIDER (Lightbulb fixes)
	// ========================================================================

	/**
	 * Register once at activation (cleaner than registering on every review).
	 * This provider turns our diagnostics into Quick Fix entries.
	 */
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider("*", {
			provideCodeActions(document, range, context, token) {
				return context.diagnostics
					.filter(d => d.source === "deep-code-review")
					.map(d => {
						if (d.code && typeof d.code === "object" && "value" in d.code) {
							const fix = (d.code as { value: string }).value;
							const action = new vscode.CodeAction(`Apply fix: ${fix}`, vscode.CodeActionKind.QuickFix);
							action.command = {
								command: "deep-code-reviewer.applyFix",
								title: "Apply Fix",
								arguments: [document, d]
							};
							return action;
						}
						return null;
					})
					.filter(Boolean) as vscode.CodeAction[];
			}
		})
	);

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
				 * SELF-CORRECTION LOOP:
				 * 
				 * We wrap the OpenAI call with automatic retry logic:
				 * 1. Call OpenAI API
				 * 2. Validate JSON response structure
				 * 3. If invalid → retry with correction prompt (up to 3 attempts)
				 * 4. Return result + attempt metadata
				 * 
				 * WHY SELF-CORRECTION?
				 * - Models sometimes return invalid JSON or wrong structure
				 * - Prevents user-facing errors ("invalid response" messages)
				 * - Shows production-ready reliability engineering
				 * - Demonstrates AI engineering best practices
				 */
				const systemPrompt = `Return ONLY a JSON object with a single key "issues". 
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
- preserve the nature of the function (eg, recursive, iterative, etc.)`;

				const result = await callOpenAIWithSelfCorrection(client, model, systemPrompt, code);

				if (!result.success) {
					vscode.window.showErrorMessage(
						`Review failed after ${result.attempts.length} attempts. ` +
						`The AI model returned invalid responses. Please try again.`
					);
					return;
				}

				output = result.content;
				// Store attempts metadata for webview display
				latestReviewState = latestReviewState || {
					uri: editor.document.uri,
					issues: [],
					baseLine: 0
				};
				latestReviewState.attempts = result.attempts;
				latestReviewState.totalTokens = result.totalTokens;
				latestReviewState.model = model;
			} catch (error: any) {
				vscode.window.showErrorMessage(`Review failed: ${error.message}`);
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
			// Store attempts metadata for webview display (backend already did self-correction)
			latestReviewState = latestReviewState || {
				uri: editor.document.uri,
				issues: [],
				baseLine: 0
			};
			if (result.attempts) {
				latestReviewState.attempts = result.attempts;
			}
			if (result.totalTokens) {
				latestReviewState.totalTokens = result.totalTokens;
			}
			latestReviewState.model = model;
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
		// STEP 4: Calculate Line Offset & Update Tree View
		// ====================================================================

		/**
		 * LINE NUMBER MAPPING:
		 * 
		 * If reviewing selected text, model returns line numbers relative to snippet
		 * We need to map these back to actual file line numbers for Tree View
		 * 
		 * Example:
		 * - File has 100 lines
		 * - User selects lines 10-20
		 * - Model says "line 3 has an error" (relative to selection start)
		 * - We map: baseLine (9, 0-based) + issue.line (3, 1-based) = line 12 in file
		 */
		const baseLine = hasSelection ? selection.start.line : 0;

		// Update Tree View state so the sidebar reflects the latest review
		// Preserve attempts metadata if it was already set (from self-correction loop)
		latestReviewState = {
			uri: editor.document.uri,
			issues,
			baseLine,
			selectionRange: hasSelection ? new vscode.Range(selection.start, selection.end) : undefined,
			attempts: latestReviewState?.attempts,
			totalTokens: latestReviewState?.totalTokens,
			model: latestReviewState?.model
		};
		findingsProvider?.refresh();

		// Note: All results are now shown in Tree View - no output channel or diagnostics needed
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
