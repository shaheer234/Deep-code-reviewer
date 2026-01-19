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
		// STEP 4: Call OpenAI API
		// ====================================================================

		/**
		 * OPENAI API CALL
		 * 
		 * PARAMETERS:
		 * - model: Which model to use (gpt-4o-mini, gpt-4, etc.)
		 * - temperature: 0 (deterministic - same input = same output)
		 * - seed: 42 (extra determinism - ensures reproducibility)
		 * - messages: System prompt + user code
		 * - response_format: json_object (forces valid JSON output)
		 * 
		 * WHY DETERMINISTIC SETTINGS?
		 * - Consistent results (user runs review twice, gets same issues)
		 * - Easier to debug (reproducible)
		 * - Better UX (no random variations)
		 * 
		 * COST:
		 * - Charged per token (input + output)
		 * - Typical review: ~2,000 input tokens + ~500 output tokens
		 * - Cost: ~$0.375 per review (gpt-4o-mini)
		 */
		const response = await openai.chat.completions.create({
			model,
			// Note: Some models (e.g., gpt-5-mini) don't support temperature: 0
			// Using seed: 42 for determinism instead
			seed: 42,       // Deterministic results (same input = same output)
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: code }
			],
			response_format: { type: 'json_object' } // Force JSON output
		});

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
		 * - openaiUsage: Token counts (for cost tracking/analytics)
		 * 
		 * WHY INCLUDE USAGE INFO?
		 * - Extension can show "3/10 reviews used today"
		 * - Helps users track their quota
		 * - Good UX (transparency)
		 */
		const result = {
			content: response.choices[0].message?.content,
			usage: {
				used: newUsage,
				limit: rateLimit.limit,
				remaining: rateLimit.limit - newUsage,
				resetAt: rateLimit.resetAt
			},
			// Include OpenAI usage stats for cost tracking
			openaiUsage: response.usage
		};

		res.json(result);

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
