/**
 * Deep Code Reviewer Backend API
 * 
 * This server acts as a proxy between the VS Code extension and OpenAI's API.
 * It provides:
 * 1. Rate limiting (free tier users get X reviews per day)
 * 2. Device-based tracking (each VS Code installation gets a unique device ID)
 * 3. Cost management (we control which OpenAI model is used)
 * 4. Security (API keys stay on the server, not in the extension)
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

// Rate limiting configuration
// In-memory storage for usage tracking (use Redis in production for scale)
const usageStore = new Map();

// How many reviews each device can make per day
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '10');

// OpenAI client - uses YOUR API key (stored as environment variable)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Validate that we have an API key
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set!');
  console.error('Please set it in your .env file or Railway environment variables.');
  process.exit(1);
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

// CORS: Allow requests from VS Code extensions (any origin)
// In production, you might want to restrict this to specific domains
app.use(cors());

// Parse JSON request bodies
app.use(express.json());

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get a unique key for tracking daily usage per device
 * Format: "deviceId:YYYY-MM-DD"
 * Example: "abc-123:2024-01-15"
 * 
 * Why per-day? Limits reset at midnight UTC, giving users a fresh quota daily
 */
function getUsageKey(deviceId) {
  const today = new Date().toISOString().split('T')[0]; // Gets YYYY-MM-DD
  return `${deviceId}:${today}`;
}

/**
 * Check if a device has exceeded its daily rate limit
 * Returns usage info and whether they're over the limit
 */
function checkRateLimit(deviceId) {
  const key = getUsageKey(deviceId);
  const usage = usageStore.get(key) || 0;
  
  // Simple cleanup: if we have too many entries, remove old ones
  // (In production, use Redis with TTL expiration instead)
  if (usageStore.size > 10000) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2); // Remove entries older than 2 days
    const cutoffStr = cutoff.toISOString().split('T')[0];
    
    for (const [k, v] of usageStore.entries()) {
      if (k.includes(cutoffStr) || k.includes(getPreviousDay(cutoffStr))) {
        usageStore.delete(k);
      }
    }
  }
  
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
 * Health check endpoint
 * Railway/cloud platforms use this to verify the service is running
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'deep-code-reviewer-api',
    timestamp: new Date().toISOString()
  });
});

/**
 * Main review endpoint
 * 
 * POST /v1/review
 * Headers:
 *   - X-Device-ID: Unique identifier for this VS Code installation
 * Body:
 *   - code: The code to review (string)
 *   - model: Optional OpenAI model to use (defaults to gpt-4o-mini)
 * 
 * Flow:
 * 1. Extract device ID from headers
 * 2. Check rate limit (429 if exceeded)
 * 3. Send code to OpenAI with our system prompt
 * 4. Increment usage counter
 * 5. Return review results to extension
 */
app.post('/v1/review', async (req, res) => {
  try {
    const { code, model: requestedModel } = req.body;
    const deviceId = req.headers['x-device-id'];
    
    // Validation: Ensure we have required data
    if (!code) {
      return res.status(400).json({ error: 'Code is required in request body' });
    }
    
    if (!deviceId) {
      return res.status(400).json({ error: 'X-Device-ID header is required' });
    }
    
    // Rate limiting check
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
    
    // Use requested model or default to cheaper model for free tier
    const model = requestedModel || 'gpt-4o-mini'; // gpt-4o-mini is cheaper than gpt-4
    
    // System prompt - same as in your extension
    // This is what tells OpenAI how to format its response
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
    
    // Call OpenAI API
    // We use YOUR API key here (set in environment variable)
    const response = await openai.chat.completions.create({
      model,
      temperature: 0, // Deterministic results (same input = same output)
      seed: 42,       // Extra determinism
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: code }
      ],
      response_format: { type: 'json_object' } // Force JSON output
    });
    
    // Increment usage counter for this device
    const usageKey = getUsageKey(deviceId);
    const newUsage = rateLimit.used + 1;
    usageStore.set(usageKey, newUsage);
    
    // Return OpenAI response + usage info
    // The extension expects the same format whether using free tier or custom key
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
 * Usage check endpoint
 * 
 * GET /v1/usage/:deviceId
 * 
 * Allows the extension to check how many reviews a device has used
 * Useful for showing "3/10 reviews used today" in the status bar
 */
app.get('/v1/usage/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  const rateLimit = checkRateLimit(deviceId);
  res.json(rateLimit);
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Deep Code Reviewer API running on port ${PORT}`);
  console.log(`📊 Daily limit per device: ${DAILY_LIMIT} reviews`);
  console.log(`🔑 OpenAI API key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
  console.log(`\n📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Review endpoint: POST http://localhost:${PORT}/v1/review`);
});

