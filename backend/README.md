# Deep Code Reviewer Backend API

This is the backend service that powers the **free tier** for the Deep Code Reviewer VS Code extension.

## 🎯 Purpose

The backend serves two main purposes:

1. **Rate Limiting**: Free tier users get a limited number of reviews per day (default: 10). The backend tracks usage per device and enforces this limit.

2. **API Key Security**: Your OpenAI API key stays on the server, not in user's VS Code extensions. This allows you to offer a free tier without users needing their own OpenAI accounts.

## 🏗️ Architecture

```
VS Code Extension          Backend API              OpenAI API
     │                         │                         │
     │ 1. POST /v1/review      │                         │
     │    (code + device-id)   │                         │
     ├─────────────────────────>│                         │
     │                         │ 2. Check rate limit     │
     │                         │    (in-memory store)    │
     │                         │                         │
     │                         │ 3. POST to OpenAI       │
     │                         ├─────────────────────────>│
     │                         │                         │
     │                         │ 4. Review results       │
     │                         │<─────────────────────────┤
     │                         │                         │
     │ 5. Return results       │                         │
     │<─────────────────────────┤                         │
     │                         │                         │
```

## 🔑 Key Concepts

### Device ID
- Each VS Code installation generates a unique UUID on first use
- Stored locally in VS Code's global state
- Sent with every request as `X-Device-ID` header
- Used to track usage per user (not per IP, which can be shared)

### Rate Limiting
- **Daily limit**: Resets at midnight UTC
- **Storage**: In-memory Map (simple, works for MVP)
- **Production**: Should use Redis for scale (handles millions of devices)

### Why a Backend?
- **Cost control**: You control which model is used (gpt-4o-mini is cheaper than gpt-4)
- **Abuse prevention**: Rate limiting prevents someone from draining your OpenAI credits
- **Analytics**: Track usage patterns, popular languages, etc.
- **Future monetization**: Easy to add paid tiers later

## 🚀 Setup

### Local Development

1. **Install dependencies**:
   ```bash
   cd backend
   npm install
   ```

2. **Create `.env` file**:
   ```bash
   cp .env.example .env
   # Edit .env and add your OpenAI API key
   ```

3. **Run the server**:
   ```bash
   npm start
   ```

4. **Test it**:
   ```bash
   # Health check
   curl http://localhost:3000/health
   
   # Test review (replace DEVICE_ID with any string)
   curl -X POST http://localhost:3000/v1/review \
     -H "Content-Type: application/json" \
     -H "X-Device-ID: test-device-123" \
     -d '{"code": "def divide(a, b): return a/b"}'
   ```

### Railway Deployment

1. **Install Railway CLI** (optional, or use web UI):
   ```bash
   npm i -g @railway/cli
   railway login
   ```

2. **Create new project**:
   ```bash
   railway init
   # Select "New Project" and "Empty Project"
   ```

3. **Set root directory**:
   - In Railway dashboard → Settings → Root Directory → Set to `backend`

4. **Add environment variables**:
   - Railway Dashboard → Variables → Add:
     - `OPENAI_API_KEY` = `your-key-here`
     - `DAILY_LIMIT` = `10` (optional, defaults to 10)
     - `PORT` = Railway auto-assigns this

5. **Deploy**:
   ```bash
   railway up
   ```
   Or connect to GitHub repo and auto-deploy on push.

6. **Get your URL**:
   - Railway Dashboard → Settings → Domains
   - Copy the URL (e.g., `https://deep-code-reviewer-production.up.railway.app`)
   - Use this in your extension's `FREE_TIER_API_URL`

## 📊 Cost Estimation

**Example scenario**: 100 active free tier users, 10 reviews/day each

- Reviews per day: 100 users × 10 reviews = 1,000 reviews/day
- Tokens per review: ~2,000 input + 500 output = 2,500 tokens (gpt-4o-mini)
- Cost per 1K tokens: ~$0.15 (gpt-4o-mini)
- Daily cost: (1,000 × 2,500 / 1,000) × $0.15 = **~$0.375/day** = **~$11/month**

**For 1,000 users**: ~$110/month

**Optimization tips**:
- Use `gpt-4o-mini` (cheapest model) for free tier
- Consider lowering `DAILY_LIMIT` to 5 if costs get high
- Monitor usage and adjust limits dynamically

## 🔒 Security Considerations

1. **API Key**: Never commit `.env` file. Use environment variables in Railway.
2. **Rate Limiting**: Prevents abuse but in-memory storage can be bypassed by clearing device ID (acceptable for free tier).
3. **CORS**: Currently allows all origins. For production, consider restricting.
4. **Code Privacy**: Code sent to your backend goes to OpenAI. Add privacy policy disclosure.

## 🚧 Future Improvements

- [ ] Redis for rate limiting (scales to millions of users)
- [ ] User authentication (GitHub OAuth) for better tracking
- [ ] Analytics dashboard (most reviewed languages, common issues)
- [ ] Paid tiers (unlimited reviews for $X/month)
- [ ] Code caching (don't re-review identical code)
- [ ] Request validation (reject code that's too large)

## 📝 API Reference

### POST /v1/review

Review code using OpenAI.

**Headers**:
- `X-Device-ID`: Required. Unique device identifier.

**Body**:
```json
{
  "code": "def divide(a, b): return a/b",
  "model": "gpt-4o-mini"  // Optional
}
```

**Response** (200 OK):
```json
{
  "content": "{\"issues\": [...]}",
  "usage": {
    "used": 5,
    "limit": 10,
    "remaining": 5,
    "resetAt": "2024-01-16T00:00:00.000Z"
  },
  "openaiUsage": {
    "prompt_tokens": 1500,
    "completion_tokens": 400,
    "total_tokens": 1900
  }
}
```

**Response** (429 Too Many Requests):
```json
{
  "error": "Daily limit reached",
  "limit": 10,
  "used": 10,
  "resetAt": "2024-01-16T00:00:00.000Z"
}
```

### GET /v1/usage/:deviceId

Check usage for a device.

**Response**:
```json
{
  "used": 5,
  "limit": 10,
  "remaining": 5,
  "resetAt": "2024-01-16T00:00:00.000Z"
}
```

### GET /health

Health check endpoint.

**Response**:
```json
{
  "status": "ok",
  "service": "deep-code-reviewer-api",
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

