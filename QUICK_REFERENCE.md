# Quick Reference - Netlify Upload System

## TL;DR - Getting Started (5 minutes)

### Prerequisites
- Telegram bot token (from @BotFather)
- Chat ID (from your Telegram chat)
- Netlify account

### Deploy Steps
```bash
# 1. Install dependencies
npm install

# 2. Set environment variables on Netlify:
# TELEGRAM_BOT_TOKEN = your_token_here
# TELEGRAM_CHAT_ID = your_chat_id_here

# 3. Deploy (choose one):
netlify deploy --prod          # Using CLI
# OR just push to GitHub if connected

# 4. Test upload form on live site
```

## File Upload Flow

1. User fills form + selects file
2. Browser validates (size, type, required fields)
3. POST to `/.netlify/functions/upload`
4. Server validates again
5. Telegram API sends file to bot chat
6. User sees success/error message

## Environment Variables

```
TELEGRAM_BOT_TOKEN = 123456:ABC-DEF1234ghIkl-zyx...
TELEGRAM_CHAT_ID = 987654321
```

## Function Details

- **Path**: `/.netlify/functions/upload`
- **Method**: POST
- **Body**: multipart/form-data
- **Timeout**: 30 seconds
- **Memory**: 512MB

## Validation Rules

| Field | Type | Max Size | Required |
|-------|------|----------|----------|
| file | binary | 20MB | ✓ |
| title | string | - | ✓ |
| course | string | - | ✗ |
| semester | string | - | ✗ |
| description | string | - | ✗ |
| email | string | - | ✗ |

Allowed file types: `.pdf`, `.jpg`, `.jpeg`, `.png`

## Success Response
```json
{
  "success": true,
  "message": "File uploaded successfully!",
  "fileName": "document.pdf"
}
```

## Error Response
```json
{
  "error": "File too large. Maximum 20MB allowed."
}
```

## Testing Locally

```bash
npm install -D netlify-cli
netlify dev        # Starts at localhost:8888
# Upload form works with real Telegram bot
```

## Troubleshooting Checklist

- [ ] Environment variables set on Netlify
- [ ] Variables deployed (check redeploy)
- [ ] Telegram bot token is valid
- [ ] Chat ID is correct number
- [ ] Function exists at `netlify/functions/upload.js`
- [ ] package.json has dependencies
- [ ] netlify.toml exists
- [ ] File size < 20MB
- [ ] Browser console shows no errors

## Logs & Monitoring

**View function logs:**
1. Netlify Dashboard → Your Site
2. Functions tab
3. Click "upload" function
4. Check recent invocations

**Check deployment status:**
1. Site Settings → Build & Deploy → Build History
2. Click latest build
3. Scroll to Functions section

## Quick Commands

```bash
# Test bot token validity
curl https://api.telegram.org/botTOKEN/getMe

# Get chat ID
curl https://api.telegram.org/botTOKEN/getUpdates

# Test message send
curl -X POST https://api.telegram.org/botTOKEN/sendMessage \
  -d "chat_id=CHATID&text=test"

# Netlify CLI login
netlify login

# Deploy with CLI
netlify deploy --prod

# View local deployment
netlify serve
```

## Common Issues

| Issue | Solution |
|-------|----------|
| 500 Server Error | Check env vars, redeploy |
| File not in Telegram | Verify token & chat ID |
| Upload button disabled | Check browser console for errors |
| CORS errors | Verify netlify.toml config |
| Function timeout | File too large or network issue |

## Files to Know

```
netlify/
└── functions/
    └── upload.js          ← Main serverless function

index.html                 ← Upload form HTML
script.js                  ← Form handler JavaScript
upload-styles.css          ← Form styling
netlify.toml              ← Netlify configuration

.env.example              ← Environment template
package.json              ← Dependencies
```

## Key Points

- ✅ Fully serverless (no backend needed)
- ✅ Free tier supports ~100 uploads/month
- ✅ Files never stored on server (sent to Telegram only)
- ✅ Bot token secure (server-side only)
- ✅ Works on any Netlify plan

## Support Files

- `TELEGRAM_SETUP.md` - Detailed bot setup
- `NETLIFY_DEPLOYMENT.md` - Full deployment guide
- `UPLOAD_SYSTEM_GUIDE.md` - Complete documentation

---

**Status**: Production Ready ✅  
**Last Updated**: January 21, 2026
