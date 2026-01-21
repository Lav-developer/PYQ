# Netlify Deployment Guide for File Upload Feature

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Telegram Bot (CRITICAL)

**Before deploying, you MUST set up your Telegram bot credentials:**

1. Create a Telegram Bot:
   - Find **@BotFather** on Telegram
   - Send `/newbot`
   - Follow prompts to create your bot
   - Copy your **Bot Token**

2. Get Your Chat ID:
   - Send any message to your bot
   - Run: `curl https://api.telegram.org/botYOUR_TOKEN/getUpdates`
   - Find the `chat.id` value

3. Set Environment Variables on Netlify:
   - Go to https://app.netlify.com → Your Site → Site Settings
   - Navigate to **Build & Deploy** → **Environment**
   - Add these variables:
     ```
     TELEGRAM_BOT_TOKEN = your_token_here
     TELEGRAM_CHAT_ID = your_chat_id_here
     ```
   - **Save and Trigger Redeploy**

### 3. Deploy to Netlify

#### Option A: Using Netlify CLI
```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
```

#### Option B: Connect GitHub
1. Push code to GitHub
2. Connect your repo to Netlify
3. Set environment variables (see Step 2)
4. Netlify will auto-deploy on push

#### Option C: Drag & Drop (Simple)
1. Zip all files
2. Drag to https://app.netlify.com/drop
3. Set environment variables afterward

## File Structure

```
project/
├── netlify/
│   └── functions/
│       └── upload.js          ← Netlify serverless function
├── index.html                 ← Updated with upload form
├── script.js                  ← Updated with upload handler
├── styles.css                 ← Main styles
├── upload-styles.css          ← Upload form styles (add to index.html)
├── netlify.toml              ← Netlify configuration
├── package.json              ← Dependencies
├── .env.example              ← Template for env vars (don't commit .env)
└── TELEGRAM_SETUP.md         ← Telegram bot setup guide
```

## How It Works

1. **User uploads file** → Browser form validation
2. **File sent to Netlify Function** → `/.netlify/functions/upload`
3. **Function validates** → File type, size, fields
4. **Function sends to Telegram** → Via Telegram Bot API
5. **User gets confirmation** → Success/error message

## Security Features

✅ **Server-side validation** - File type, size, required fields
✅ **Bot token protected** - Never exposed to frontend
✅ **Environment variables** - Credentials not in code
✅ **CORS headers** - Only your domain
✅ **Rate limiting** - Can add Netlify functions rate limiting
✅ **Error handling** - Detailed logs without exposing secrets

## Troubleshooting

### Upload returns error "Server configuration error"
- Check environment variables are set on Netlify
- Trigger a manual redeploy: Site Settings → Trigger Deploy
- Wait 2-3 minutes for changes to take effect

### File shows success but nothing in Telegram
- Verify bot token is correct
- Verify chat ID is correct (should be numeric)
- Check Telegram chat privacy settings
- Test with a simple message first: `curl -X POST https://api.telegram.org/botTOKEN/sendMessage -d "chat_id=CHATID&text=test"`

### Browser shows network error
- Check browser console (F12)
- Verify site is deployed on Netlify
- Check function endpoint: `/.netlify/functions/upload`
- Ensure form has enctype="multipart/form-data"

### File size error
- Maximum 20MB per file
- Check actual file size
- Try smaller file first to test

### Build fails
- Ensure `netlify.toml` exists
- Check `package.json` has correct dependencies
- Try: `npm install` locally first
- Check Netlify logs: Site Settings → Build & Deploy → Build History

## Local Testing

### Without deployment
```bash
npm install -D netlify-cli
netlify dev
```
Open http://localhost:8888 and test upload

### With real Telegram bot
- Set up `.env` file locally:
  ```
  TELEGRAM_BOT_TOKEN=your_token
  TELEGRAM_CHAT_ID=your_chat_id
  ```
- Run `netlify dev` 
- Uploads will work locally

## Performance

- **Function timeout**: 30 seconds
- **Memory**: 512MB
- **Max file size**: 20MB
- **Response time**: 1-3 seconds typical

## Customization

### Change file size limit
Edit `netlify/functions/upload.js` line ~70:
```javascript
if (fileSize > 20 * 1024 * 1024) { // Change 20 to desired MB
```

### Change allowed file types
Edit `netlify/functions/upload.js` line ~106:
```javascript
const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png']; // Add/remove extensions
```

### Customize Telegram message
Edit `netlify/functions/upload.js` line ~53-62:
```javascript
let telegramMessage = `📚 **New File Upload**\n\n`;
// Customize this message format
```

## Support & Resources

- Telegram Bot Docs: https://core.telegram.org/bots
- Netlify Functions: https://docs.netlify.com/functions/overview/
- API Documentation: See `TELEGRAM_SETUP.md`

## Next Steps

After successful deployment:
1. ✅ Test file upload
2. ✅ Verify files arrive in Telegram
3. ✅ Share website with users
4. ✅ Monitor upload activity in Telegram
5. 🔄 Process uploads and add to Firestore (manual or automated)
