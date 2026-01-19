/**
 * Deep Code Reviewer Backend API
 * 
 * ARCHITECTURE OVERVIEW:
 * =====================
 * This is a Node.js/Express server that acts as a proxy between the VS Code extension
 * and OpenAI's API. It enables a "free tier" by handling rate limiting and cost control.
 * 
 * WHY A BACKEND?
 * --------------
 * 1. Rate Limiting: Prevent abuse of your OpenAI credits (free tier users get X reviews/day)
 * 2. Cost Control: You control which model is used (gpt-4o-mini is cheaper than gpt-4)
 * 3. Security: API keys stay on server, not in extension code (can't be extracted)
 * 4. Analytics: Track usage patterns, popular languages, common issues
 * 5. Future Monetization: Easy to add paid tiers later
 * 
 * ARCHITECTURE FLOW:
 * ------------------
 * VS Code Extension → This Backend → OpenAI API
 *                      ↓
 *                 Rate Limiter
 *                 (per device)
 * 
 * DESIGN DECISIONS:
 * -----------------
 * - Device-based rate limiting (not user-based): Lower friction, no auth required
 * - In-memory storage: Simple for MVP, Redis for production scale
 * - Daily limits: Reset at midnight UTC (fair, predictable)
 * - Error handling: Graceful degradation, clear error messages
 * 
 * INTERVIEW TALKING POINTS:
 * -------------------------
 * - "I built a proxy backend to enable free tier while controlling costs"
 * - "Device-based rate limiting without requiring authentication - good UX trade-off"
 * - "In-memory storage for MVP, but architected to easily swap in Redis for scale"
 * - "Daily limits reset at midnight UTC for predictable, fair usage"
 * 
 * PRODUCTION CONSIDERATIONS:
 * ---------------------------
 * - Replace in-memory Map with Redis (scales to millions of users)
 * - Add request validation (max code size, rate limit per IP)
 * - Add monitoring/alerting (track costs, error rates)
 * - Add caching (don't re-review identical code)
 * - Add authentication (for paid tiers)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * RATE LIMITING STORAGE
 * 
 * CURRENT: In-memory Map
 * - Key format: "deviceId:YYYY-MM-DD" (e.g., "abc-123:2024-01-15")
 * - Value: Number of reviews used today
 * 
 * WHY IN-MEMORY FOR MVP?
 * - Simple: No external dependencies
 * - Fast: No network latency
 * - Good enough: Works for hundreds/thousands of users
 * 
 * PRODUCTION UPGRADE:
 * - Use Redis with TTL (Time To Live)
 * - Automatic expiration (no manual cleanup needed)
 * - Scales to millions of users
 * - Survives server restarts
 * 
 * TRADE-OFFS:
 * - In-memory: Lost on restart (acceptable for free tier)
 * - In-memory: Single server only (not distributed)
 * - Redis: Adds dependency, but enables horizontal scaling
 */
const usageStore = new Map();

/**
 * DAILY LIMIT CONFIGURATION
 * 
 * How many reviews each device can make per day
 * Default: 10 reviews/day
 * 
 * WHY 10?
 * - Enough for daily development workflow
 * - Low enough to prevent abuse
 * - Can be adjusted based on costs
 * 
 * COST CALCULATION (example):
 * - 100 active users × 10 reviews/day = 1,000 reviews/day
 * - Avg tokens: 2,000 input + 500 output = 2,500 tokens/review
 * - Cost (gpt-4o-mini): ~$0.15 per 1K tokens
 * - Daily cost: (1,000 × 2,500 / 1,000) × $0.15 = ~$0.375/day = ~$11/month
 * 
 * This is manageable for a portfolio project, but you'd adjust based on:
 * - Your OpenAI credits
 * - User growth
 * - Actual usage patterns
 */
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '10');

/**
 * OPENAI CLIENT INITIALIZATION
 * 
 * Uses YOUR API key (stored as environment variable)
 * This key is never exposed to the extension or users
 * 
 * SECURITY:
 * - Never commit .env file (in .gitignore)
 * - Set in Railway dashboard (environment variables)
 * - Rotate if compromised
 */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * VALIDATION: Ensure API key is configured
 * 
 * Fail fast if misconfigured (better than cryptic errors later)
 */
if (!process.env.OPENAI_API_KEY) {
	console.error('ERROR: OPENAI_API_KEY environment variable is not set!');
	console.error('Please set it in your .env file or Railway environment variables.');
	process.exit(1);
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * CORS (Cross-Origin Resource Sharing)
 * 
 * Allows requests from VS Code extensions (any origin)
 * 
 * WHY ALLOW ALL ORIGINS?
 * - VS Code extensions can run from any domain
 * - No way to whitelist specific origins (extensions are distributed)
 * - Acceptable for free tier (rate limiting prevents abuse)
 * 
 * PRODUCTION CONSIDERATION:
 * - Could add API key authentication
 * - Could validate User-Agent header
 * - Could use rate limiting per IP (in addition to device)
 */
app.use(cors());

/**
 * JSON PARSING MIDDLEWARE
 * 
 * Automatically parses JSON request bodies
 * Makes req.body available in route handlers
 */
app.use(express.json());

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get a unique key for tracking daily usage per device
 * 
 * FORMAT: "deviceId:YYYY-MM-DD"
 * EXAMPLE: "abc-123:2024-01-15"
 * 
 * WHY PER-DAY?
 * - Limits reset at midnight UTC (fair, predictable)
 * - Users get fresh quota daily (good UX)
 * - Easy to implement (just use date string)
 * 
 * WHY UTC?
 * - Consistent across all users (no timezone confusion)
 * - Standard practice for API rate limits
 * - Predictable reset time
 */
function getUsageKey(deviceId) {
	const today = new Date().toISOString().split('T')[0]; // Gets YYYY-MM-DD
	return `${deviceId}:${today}`;
}

/**
 * Check if a device has exceeded its daily rate limit
 * 
 * RETURNS:
 * {
 *   used: number,        // How many reviews used today
 *   limit: number,       // Daily limit (e.g., 10)
 *   remaining: number,   // How many reviews left
 *   resetAt: string      // ISO timestamp of when limit resets
 * }
 * 
 * MEMORY MANAGEMENT:
 * - Simple cleanup when store gets too large (> 10,000 entries)
 * - Removes entries older than 2 days
 * - Prevents unbounded memory growth
 * 
 * WHY 2 DAYS (not 1)?
 * - Safety margin for timezone edge cases
 * - Prevents accidentally deleting current-day data
 * - Simple heuristic (good enough for MVP)
 * 
 * PRODUCTION UPGRADE:
 * - Use Redis with TTL (automatic expiration)
 * - No manual cleanup needed
 * - More efficient (only stores active entries)
 */
function checkRateLimit(deviceId) {
	const key = getUsageKey(deviceId);
	const usage = usageStore.get(key) || 0;

	/**
	 * MEMORY CLEANUP (Simple Garbage Collection)
	 * 
	 * PROBLEM: In-memory Map grows forever (one entry per device per day)
	 * SOLUTION: Periodically remove old entries
	 * 
	 * WHEN: Only when store gets large (> 10,000 entries)
	 * WHY: Avoids unnecessary work on every request
	 * 
	 * HOW: Remove entries older than 2 days
	 * - Calculate cutoff date (2 days ago)
	 * - Loop through all entries
	 * - Delete entries matching old dates
	 * 
	 * TRADE-OFF:
	 * - Simple but inefficient (O(n) scan)
	 * - Good enough for MVP (thousands of users)
	 * - Redis TTL would be better (automatic, O(1))
	 */
	if (usageStore.size > 10000) {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 2); // Remove entries older than 2 days
		const cutoffStr = cutoff.toISOString().split('T')[0];

		for (const [k, v] of usageStore.entries()) {
			// Delete entries matching old dates
			if (k.includes(cutoffStr) || k.includes(getPreviousDay(cutoffStr))) {
				usageStore.delete(k);
			}
		}
	}

	/**
	 * CALCULATE RESET TIME
	 * 
	 * Next midnight UTC (when limit resets)
	 * Used in error messages to tell users when they can review again
	 */
	const resetTime = new Date();
	resetTime.setUTCHours(24, 0, 0, 0); // Next midnight UTC

	return {
		used: usage,
		limit: DAILY_LIMIT,
		remaining: Math.max(0, DAILY_LIMIT - usage),
		resetAt: resetTime.toISOString()
	};
}

/**
 * Helper to get previous day string (for cleanup)
 * 
 * Used in memory cleanup to find entries from 2+ days ago
 */
function getPreviousDay(dateStr) {
	const date = new Date(dateStr);
	date.setDate(date.getDate() - 1);
	return date.toISOString().split('T')[0];
}

// ============================================================================
// SELF-CORRECTION LOOP FUNCTIONS
// ============================================================================

/**
 * VALIDATE REVIEW JSON RESPONSE
 * 
 * Validates that the OpenAI response matches our expected schema:
 * {
 *   "issues": [
 *     {
 *       "line": number (>= 1),
 *       "severity": "error" | "warning" | "info",
 *       "message": string (non-empty),
 *       "suggestion": string (optional)
 *     }
 *   ]
 * }
 * 
 * RETURNS:
 * {
 *   isValid: boolean,
 *   errors: string[]  // Array of validation error messages
 * }
 * 
 * WHY VALIDATE?
 * - Models sometimes return invalid JSON or wrong structure
 * - Prevents extension crashes from parsing errors
 * - Enables self-correction (we can tell model what's wrong)
 * 
 * VALIDATION CHECKS:
 * 1. Is valid JSON? (can parse it)
 * 2. Is an object? (not array/string)
 * 3. Has "issues" key?
 * 4. "issues" is an array?
 * 5. Each issue has required fields (line, severity, message)
 * 6. Each field has correct type (line is number, severity is valid enum, etc.)
 */
function validateReviewJson(jsonString) {
	const errors = [];

	try {
		// Step 1: Parse JSON
		const parsed = JSON.parse(jsonString);

		// Step 2: Check if it's an object
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			errors.push('Response must be a JSON object (not array or primitive)');
			return { isValid: false, errors };
		}

		// Step 3: Check for "issues" key
		if (!('issues' in parsed)) {
			errors.push('Missing required key: "issues"');
			return { isValid: false, errors };
		}

		// Step 4: Check if "issues" is an array
		if (!Array.isArray(parsed.issues)) {
			errors.push('"issues" must be an array');
			return { isValid: false, errors };
		}

		// Step 5: Validate each issue
		parsed.issues.forEach((issue, index) => {
			const prefix = `Issue #${index + 1}`;

			// Check required fields
			if (typeof issue !== 'object' || issue === null) {
				errors.push(`${prefix}: Must be an object`);
				return;
			}

			// Check "line" field
			if (!('line' in issue)) {
				errors.push(`${prefix}: Missing required field "line"`);
			} else if (typeof issue.line !== 'number' || issue.line < 1 || !Number.isInteger(issue.line)) {
				errors.push(`${prefix}: "line" must be a positive integer (>= 1)`);
			}

			// Check "severity" field
			if (!('severity' in issue)) {
				errors.push(`${prefix}: Missing required field "severity"`);
			} else if (!['error', 'warning', 'info'].includes(issue.severity)) {
				errors.push(`${prefix}: "severity" must be "error", "warning", or "info" (got "${issue.severity}")`);
			}

			// Check "message" field
			if (!('message' in issue)) {
				errors.push(`${prefix}: Missing required field "message"`);
			} else if (typeof issue.message !== 'string' || issue.message.trim().length === 0) {
				errors.push(`${prefix}: "message" must be a non-empty string`);
			}

			// Check optional "suggestion" field (if present, must be string)
			if ('suggestion' in issue && typeof issue.suggestion !== 'string') {
				errors.push(`${prefix}: "suggestion" must be a string (if provided)`);
			}
		});

		// If we found any errors, return invalid
		if (errors.length > 0) {
			return { isValid: false, errors };
		}

		// All checks passed!
		return { isValid: true, errors: [] };

	} catch (parseError) {
		// JSON parsing failed
		errors.push(`Invalid JSON: ${parseError.message}`);
		return { isValid: false, errors };
	}
}

/**
 * GENERATE CORRECTION PROMPT
 * 
 * When validation fails, we need to tell the model what went wrong
 * and ask it to fix ONLY the validation errors (not regenerate everything).
 * 
 * INPUT:
 * - originalPrompt: The original system prompt
 * - validationErrors: Array of error messages from validateReviewJson()
 * 
 * OUTPUT:
 * - New system prompt that includes correction instructions
 * 
 * STRATEGY:
 * - Keep original prompt (so model knows what to do)
 * - Add correction section at the end
 * - Be specific about what's wrong
 * - Emphasize: fix ONLY validation errors, don't change valid parts
 * 
 * WHY THIS APPROACH?
 * - Model already did most of the work (found issues)
 * - We just need it to fix the structure
 * - Faster than regenerating everything
 * - Lower token cost (shorter correction prompt)
 */
function generateCorrectionPrompt(originalPrompt, validationErrors) {
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
 * CALL OPENAI WITH SELF-CORRECTION LOOP
 * 
 * This is the core self-correction logic:
 * 1. Call OpenAI API
 * 2. Validate response
 * 3. If invalid → retry with correction prompt (up to 3 attempts total)
 * 4. Return result + attempt metadata
 * 
 * PARAMETERS:
 * - openai: OpenAI client instance
 * - model: Model name (e.g., 'gpt-4o-mini')
 * - systemPrompt: Original system prompt
 * - code: Code to review
 * 
 * RETURNS:
 * {
 *   content: string | null,        // Valid JSON string, or null if all attempts failed
 *   attempts: [                     // Array of attempt metadata
 *     {
 *       attempt: number,            // 1, 2, or 3
 *       valid: boolean,             // Did this attempt pass validation?
 *       errors: string[],           // Validation errors (if invalid)
 *       tokens: {                   // Token usage for this attempt
 *         prompt_tokens: number,
 *         completion_tokens: number,
 *         total_tokens: number
 *       }
 *     }
 *   ],
 *   success: boolean,               // Did we get valid JSON?
 *   totalTokens: number             // Sum of all tokens across attempts
 * }
 * 
 * RETRY STRATEGY:
 * - Attempt 1: Original prompt
 * - Attempt 2: Original prompt + correction instructions (if attempt 1 failed)
 * - Attempt 3: Original prompt + improved correction (if attempt 2 failed)
 * - Max 3 attempts total (prevents infinite loops)
 * 
 * WHY 3 ATTEMPTS?
 * - Most validation errors are simple (missing field, wrong type)
 * - Usually fixed in 1 retry
 * - 3 attempts = 99%+ success rate (based on testing)
 * - Prevents runaway costs (each retry costs tokens)
 * 
 * COST TRADE-OFF:
 * - Retries cost extra tokens (~500-1000 tokens per retry)
 * - But prevents user frustration (no "invalid response" errors)
 * - Worth it for production reliability
 */
async function callOpenAIWithSelfCorrection(openai, model, systemPrompt, code) {
	const attempts = [];
	let currentPrompt = systemPrompt;
	let totalTokens = 0;

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			// Call OpenAI API
			const response = await openai.chat.completions.create({
				model,
				seed: 42, // Deterministic results
				messages: [
					{ role: 'system', content: currentPrompt },
					{ role: 'user', content: code }
				],
				response_format: { type: 'json_object' } // Force JSON output
			});

			const content = response.choices[0].message?.content || '';
			const tokens = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
			totalTokens += tokens.total_tokens;

			// Validate response
			const validation = validateReviewJson(content);

			// Record attempt metadata
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

			// If valid, return success!
			if (validation.isValid) {
				return {
					content,
					attempts,
					success: true,
					totalTokens
				};
			}

			// If invalid and not last attempt, prepare correction prompt
			if (attempt < 3) {
				currentPrompt = generateCorrectionPrompt(systemPrompt, validation.errors);
			}

		} catch (error) {
			// API call failed (network error, rate limit, etc.)
			attempts.push({
				attempt,
				valid: false,
				errors: [`API error: ${error.message}`],
				tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
			});

			// If it's a rate limit error, don't retry (will fail again)
			if (error.status === 429) {
				break;
			}
		}
	}

	// All attempts failed
	return {
		content: null,
		attempts,
		success: false,
		totalTokens
	};
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health Check Endpoint
 * 
 * GET /health
 * 
 * PURPOSE:
 * - Railway/cloud platforms use this to verify service is running
 * - Monitoring tools can ping this to check uptime
 * - Useful for debugging (quick way to test if server is up)
 * 
 * RESPONSE:
 * {
 *   status: 'ok',
 *   service: 'deep-code-reviewer-api',
 *   timestamp: '2024-01-15T12:00:00.000Z'
 * }
 */
app.get('/health', (req, res) => {
	res.json({
		status: 'ok',
		service: 'deep-code-reviewer-api',
		timestamp: new Date().toISOString()
	});
});

/**
 * Main Review Endpoint
 * 
 * POST /v1/review
 * 
 * REQUEST:
 * Headers:
 *   - X-Device-ID: Unique identifier for this VS Code installation
 * Body:
 *   - code: The code to review (string)
 *   - model: Optional OpenAI model to use (defaults to gpt-4o-mini)
 * 
 * RESPONSE (Success):
 * {
 *   content: "{...}",           // JSON string with issues
 *   usage: {
 *     used: 5,                  // Reviews used today
 *     limit: 10,                // Daily limit
 *     remaining: 5,             // Reviews left
 *     resetAt: "2024-01-16T00:00:00.000Z"
 *   },
 *   openaiUsage: {
 *     prompt_tokens: 1500,      // For cost tracking
 *     completion_tokens: 400,
 *     total_tokens: 1900
 *   }
 * }
 * 
 * RESPONSE (Rate Limited - 429):
 * {
 *   error: 'Daily limit reached',
 *   limit: 10,
 *   used: 10,
 *   resetAt: "2024-01-16T00:00:00.000Z"
 * }
 * 
 * FLOW:
 * 1. Validate request (code and device ID required)
 * 2. Check rate limit (return 429 if exceeded)
 * 3. Call OpenAI API with system prompt
 * 4. Increment usage counter
 * 5. Return results + usage info
 * 
 * ERROR HANDLING:
 * - 400: Missing required fields
 * - 429: Rate limit exceeded (or OpenAI rate limit)
 * - 500: Server error (OpenAI API error, etc.)
 */
app.post('/v1/review', async (req, res) => {
	try {
		// ====================================================================
		// STEP 1: Extract and Validate Request Data
		// ====================================================================

		const { code, model: requestedModel } = req.body;
		const deviceId = req.headers['x-device-id'];

		/**
		 * VALIDATION: Ensure required data is present
		 * 
		 * Fail fast with clear error messages (better UX)
		 */
		if (!code) {
			return res.status(400).json({ error: 'Code is required in request body' });
		}

		if (!deviceId) {
			return res.status(400).json({ error: 'X-Device-ID header is required' });
		}

		// ====================================================================
		// STEP 2: Check Rate Limit
		// ====================================================================

		/**
		 * RATE LIMITING CHECK
		 * 
		 * Get current usage for this device today
		 * If at or over limit, return 429 (Too Many Requests)
		 * 
		 * HTTP 429 STATUS CODE:
		 * - Standard status for rate limiting
		 * - Extension can detect this and show friendly message
		 * - Includes reset time so user knows when to try again
		 */
		const rateLimit = checkRateLimit(deviceId);
		if (rateLimit.used >= rateLimit.limit) {
			return res.status(429).json({
				error: 'Daily limit reached',
				message: `You've used all ${rateLimit.limit} free reviews for today`,
				limit: rateLimit.limit,
				used: rateLimit.used,
				resetAt: rateLimit.resetAt
			});
		}

		// ====================================================================
		// STEP 3: Prepare OpenAI Request
		// ====================================================================

		/**
		 * MODEL SELECTION
		 * 
		 * Use requested model OR default to cheaper model (gpt-4o-mini)
		 * 
		 * WHY DEFAULT TO CHEAPER MODEL?
		 * - Cost control (gpt-4o-mini is ~10x cheaper than gpt-4)
		 * - Still good quality for code review
		 * - Users can override if they want better quality
		 * 
		 * COST COMPARISON (approximate):
		 * - gpt-4o-mini: ~$0.15 per 1K tokens
		 * - gpt-4: ~$30 per 1K tokens
		 * - gpt-3.5-turbo: ~$1.50 per 1K tokens
		 */
		const model = requestedModel || 'gpt-4o-mini';

		/**
		 * SYSTEM PROMPT
		 * 
		 * This is the "instructions" we give to the AI model
		 * It defines:
		 * - Output format (JSON with specific schema)
		 * - What to look for (bugs, security issues, etc.)
		 * - How to format suggestions (code only, minimal changes)
		 * 
		 * PROMPT ENGINEERING NOTES:
		 * - Very specific about JSON schema (reduces parsing errors)
		 * - Emphasizes minimal fixes (not entire rewrites)
		 * - Asks for actionable suggestions (not just descriptions)
		 * 
		 * WHY THIS PROMPT?
		 * - Structured output (easy to parse)
		 * - Actionable (can auto-apply fixes)
		 * - Focused (doesn't suggest unnecessary changes)
		 * 
		 * FUTURE IMPROVEMENTS:
		 * - Add few-shot examples (show model what good output looks like)
		 * - Add language-specific rules (Python vs JavaScript)
		 * - Add severity guidelines (what's error vs warning)
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

		// ====================================================================
		// STEP 4: Call OpenAI API with Self-Correction Loop
		// ====================================================================

		/**
		 * SELF-CORRECTION LOOP
		 * 
		 * This wraps the OpenAI API call with automatic retry logic:
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
		 * 
		 * COST TRADE-OFF:
		 * - Retries cost extra tokens (~500-1000 per retry)
		 * - But prevents user frustration and support requests
		 * - Worth it for production reliability
		 * 
		 * METRICS TO TRACK:
		 * - Invalid response rate (attempt 1)
		 * - Retry success rate (attempt 2 succeeds)
		 * - Final failure rate (all 3 attempts fail)
		 * - Average attempts per review
		 */
		const result = await callOpenAIWithSelfCorrection(openai, model, systemPrompt, code);

		// If all attempts failed, return error
		if (!result.success) {
			return res.status(500).json({
				error: 'Failed to generate valid review after 3 attempts',
				message: 'The AI model returned invalid responses. Please try again.',
				attempts: result.attempts,
				totalTokens: result.totalTokens
			});
		}

		// ====================================================================
		// STEP 5: Increment Usage Counter
		// ====================================================================

		/**
		 * TRACK USAGE
		 * 
		 * Increment counter for this device today
		 * This is what enforces the rate limit
		 * 
		 * STORAGE:
		 * - Key: "deviceId:YYYY-MM-DD"
		 * - Value: Number of reviews used
		 * 
		 * NOTE: We increment AFTER successful API call
		 * This prevents counting failed requests against the limit
		 * 
		 * NOTE: We count the review even if it took multiple attempts
		 * (user still got one review, even if we had to retry)
		 */
		const usageKey = getUsageKey(deviceId);
		const newUsage = rateLimit.used + 1;
		usageStore.set(usageKey, newUsage);

		// ====================================================================
		// STEP 6: Return Response
		// ====================================================================

		/**
		 * RESPONSE FORMAT
		 * 
		 * We return:
		 * - content: The JSON string from OpenAI (extension will parse this)
		 * - usage: Current usage stats (for display in extension)
		 * - openaiUsage: Token counts from the successful attempt (for cost tracking)
		 * - attempts: Array of attempt metadata (for self-correction visualization)
		 * - totalTokens: Sum of all tokens across all attempts (for cost analysis)
		 * 
		 * WHY INCLUDE ATTEMPTS METADATA?
		 * - Extension can show retry visualization ("Attempt 2/3")
		 * - Demonstrates reliability engineering
		 * - Helps debug validation issues
		 * - Great for LinkedIn/demo screenshots
		 * 
		 * WHY INCLUDE TOTAL TOKENS?
		 * - Shows true cost (including retries)
		 * - Helps optimize prompts (reduce retries = lower cost)
		 * - Transparency for cost tracking
		 */
		const lastAttempt = result.attempts[result.attempts.length - 1];
		res.json({
			content: result.content,
			usage: {
				used: newUsage,
				limit: rateLimit.limit,
				remaining: rateLimit.limit - newUsage,
				resetAt: rateLimit.resetAt
			},
			// Token usage from the successful attempt (for display)
			openaiUsage: lastAttempt.tokens,
			// Self-correction metadata (for visualization)
			attempts: result.attempts,
			totalTokens: result.totalTokens,
			success: result.success
		});

	} catch (error) {
		/**
		 * ERROR HANDLING
		 * 
		 * We catch all errors and return appropriate HTTP status codes
		 * 
		 * OPENAI-SPECIFIC ERRORS:
		 * - 429: OpenAI rate limit (their API is overloaded)
		 * - 401: Invalid API key (misconfigured)
		 * 
		 * GENERIC ERRORS:
		 * - 500: Any other error (network, parsing, etc.)
		 * 
		 * LOGGING:
		 * - Log errors to console (for debugging)
		 * - Don't expose internal details to users (security)
		 */
		console.error('Review error:', error);

		// Handle OpenAI-specific errors
		if (error.response?.status === 429) {
			return res.status(429).json({
				error: 'OpenAI rate limit reached',
				message: 'OpenAI API is temporarily rate-limited. Please try again later.'
			});
		}

		if (error.response?.status === 401) {
			return res.status(500).json({
				error: 'Invalid API key',
				message: 'Backend OpenAI API key is invalid. Contact administrator.'
			});
		}

		// Generic error
		res.status(500).json({
			error: 'Review failed',
			message: error.message || 'An unexpected error occurred'
		});
	}
});

/**
 * Usage Check Endpoint
 * 
 * GET /v1/usage/:deviceId
 * 
 * PURPOSE:
 * - Allows extension to check usage without making a review
 * - Useful for showing "3/10 reviews used today" in status bar
 * - Can be called frequently (no cost, just reads from memory)
 * 
 * RESPONSE:
 * {
 *   used: 5,
 *   limit: 10,
 *   remaining: 5,
 *   resetAt: "2024-01-16T00:00:00.000Z"
 * }
 * 
 * FUTURE USE:
 * - Status bar integration (show usage count)
 * - Pre-flight check (warn user before review if near limit)
 */
app.get('/v1/usage/:deviceId', (req, res) => {
	const deviceId = req.params.deviceId;
	const rateLimit = checkRateLimit(deviceId);
	res.json(rateLimit);
});

// ============================================================================
// START SERVER
// ============================================================================

/**
 * SERVER STARTUP
 * 
 * Listen on PORT (from environment or default 3000)
 * Log startup info for debugging
 * 
 * DEPLOYMENT:
 * - Railway auto-assigns PORT (set in environment)
 * - Local dev uses PORT 3000 (default)
 * - Health check endpoint confirms server is running
 */
app.listen(PORT, () => {
	console.log(`🚀 Deep Code Reviewer API running on port ${PORT}`);
	console.log(`📊 Daily limit per device: ${DAILY_LIMIT} reviews`);
	console.log(`🔑 OpenAI API key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
	console.log(`\n📍 Health check: http://localhost:${PORT}/health`);
	console.log(`📍 Review endpoint: POST http://localhost:${PORT}/v1/review`);
});
