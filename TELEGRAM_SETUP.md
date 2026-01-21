# Setup Guide: Telegram Bot Integration for File Uploads

## Overview
This guide will help you set up the file upload feature to send files directly to Telegram when users upload them through the website.

## Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/start` and then `/newbot`
3. Follow the prompts:
   - Choose a name for your bot (e.g., "DSMNRU Upload Bot")
   - Choose a username (must end with "bot", e.g., "dsmnru_upload_bot")
4. **Save the Bot Token** - You'll need this in Step 3

Example token: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

## Step 2: Get Your Chat ID

### Method 1: Using Curl (Recommended)
1. Send a message to your bot on Telegram
2. Replace `BOT_TOKEN` and run this in terminal:
```bash
curl https://api.telegram.org/botBOT_TOKEN/getUpdates
```
3. Look for `"chat"{"id":` - that number is your **Chat ID**

Example response:
```json
{
  "result": [{
    "message": {
      "chat": {
        "id": 123456789,
        "first_name": "Your Name"
      }
    }
  }]
}
```

### Method 2: Using Web Browser
1. Replace `BOT_TOKEN` in this URL:
```
https://api.telegram.org/botBOT_TOKEN/getUpdates
```
2. Visit the URL in your browser and find your `chat_id`

## Step 3: Set Environment Variables on Netlify

1. Go to [Netlify Dashboard](https://app.netlify.com)
2. Select your site
3. Go to **Site Settings** → **Build & Deploy** → **Environment**
4. Click **Edit Variables**
5. Add two new variables:
   - **Key:** `TELEGRAM_BOT_TOKEN` → **Value:** Your bot token from Step 1
   - **Key:** `TELEGRAM_CHAT_ID` → **Value:** Your chat ID from Step 2

6. **Save** and trigger a redeploy of your site

## Step 4: Test the Upload

1. Go to your website
2. Scroll to "Help us grow the collection" section
3. Fill in the upload form:
   - Select a PDF or image file
   - Enter a title (e.g., "{2023} Physics Paper 1")
   - (Optional) Add course and semester
4. Click **Upload File**

You should see a success message, and the file should appear in your Telegram bot's chat within seconds!

## Troubleshooting

### "File uploaded successfully" but nothing in Telegram
- Check that your bot token is correct
- Check that your chat ID is correct (should be a number, sometimes negative for group chats)
- Verify environment variables are saved on Netlify

### Upload button shows error
- Check browser console (F12 → Console tab) for error messages
- Ensure file is under 20MB
- File must be PDF, JPG, or PNG
- Title field cannot be empty

### Bot not responding
- Send a fresh message to your bot first
- Use `/start` command
- Get a fresh Chat ID and update Netlify environment variables

## File Structure

```
.
├── netlify/
│   └── functions/
│       └── upload.js          # Serverless function handling uploads
├── index.html                 # Updated with upload form
├── script.js                  # Updated with upload handler
├── netlify.toml              # Netlify configuration
├── package.json              # Dependencies
├── .env.example              # Example environment variables
└── README.md                 # This file
```

## API Details

### Upload Endpoint
- **Path:** `/.netlify/functions/upload`
- **Method:** `POST`
- **Content-Type:** `multipart/form-data`

### Form Fields
- `file` (required): File to upload (PDF/JPG/PNG, max 20MB)
- `title` (required): Document title
- `course` (optional): Course name
- `semester` (optional): Semester/year
- `description` (optional): Additional details
- `email` (optional): Uploader email for contact

### Response Format
```json
{
  "success": true,
  "message": "File uploaded successfully! Our team will review and add it to the collection.",
  "fileName": "document.pdf"
}
```

## Security Notes

1. **Never commit `.env` file** - It contains sensitive tokens
2. Environment variables are private to your Netlify site
3. Bot token is protected server-side (not exposed to frontend)
4. Files are validated on the server before sending to Telegram
5. File size limited to 20MB to prevent abuse

## Bot Commands (Optional)

You can also add commands to your bot for better UX:

```
/start - Start the bot
/help - Show help information
/upload - Show upload instructions
/contact - Contact information
```

Add these in @BotFather → Your Bot → Edit Commands

## Support

If you need help:
1. Check Telegram bot documentation: https://core.telegram.org/bots
2. Check Netlify Functions docs: https://docs.netlify.com/functions/overview/
3. Review browser console errors (F12)

## Next Steps

- Customize the bot message format (edit `netlify/functions/upload.js`)
- Add file storage to Firestore instead of just Telegram
- Set up automatic email notifications
- Create admin dashboard to review pending uploads
