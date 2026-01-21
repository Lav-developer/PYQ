const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.handler = async (event, context) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Get Telegram bot token from environment variables
        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.error('Missing Telegram credentials in environment variables');
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    error: 'Server configuration error. Please contact admin.' 
                })
            };
        }

        // Parse multipart form data
        const body = event.body;
        const contentType = event.headers['content-type'];

        // Extract boundary from content-type
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);
        if (!boundaryMatch) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid request format' })
            };
        }

        const boundary = boundaryMatch[1];
        const parts = body.split(`--${boundary}`);
        
        // Parse form fields
        const fields = {};
        let fileData = null;
        let fileName = null;
        let fileSize = 0;

        for (const part of parts) {
            if (!part.trim()) continue;

            // Parse field name and content
            const headerEndIndex = part.indexOf('\r\n\r\n');
            if (headerEndIndex === -1) continue;

            const headers = part.substring(0, headerEndIndex);
            const content = part.substring(headerEndIndex + 4).replace(/\r\n--$/, '');

            // Extract field name
            const nameMatch = headers.match(/name="([^"]+)"/);
            if (!nameMatch) continue;

            const fieldName = nameMatch[1];

            // Check if it's a file field
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (filenameMatch) {
                fileName = filenameMatch[1];
                fileData = Buffer.from(content, 'binary');
                fileSize = fileData.length;

                // Check file size (20MB limit)
                if (fileSize > 20 * 1024 * 1024) {
                    return {
                        statusCode: 413,
                        body: JSON.stringify({ error: 'File too large. Maximum 20MB allowed.' })
                    };
                }
            } else {
                // Regular form field
                fields[fieldName] = content.trim();
            }
        }

        // Validate required fields
        if (!fileData || !fileName) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'No file provided' })
            };
        }

        if (!fields.title) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Title is required' })
            };
        }

        // Validate file type
        const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];
        const fileExtension = path.extname(fileName).toLowerCase();
        if (!allowedExtensions.includes(fileExtension)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    error: 'Invalid file type. Only PDF, JPG, PNG allowed.' 
                })
            };
        }

        // Prepare message for Telegram
        let telegramMessage = `📚 **New File Upload**\n\n`;
        telegramMessage += `📖 Title: ${fields.title}\n`;
        if (fields.course) telegramMessage += `📚 Course: ${fields.course}\n`;
        if (fields.semester) telegramMessage += `📅 Semester: ${fields.semester}\n`;
        if (fields.description) telegramMessage += `📝 Description: ${fields.description}\n`;
        if (fields.email) telegramMessage += `📧 Uploader: ${fields.email}\n`;
        telegramMessage += `📦 File Size: ${(fileSize / 1024 / 1024).toFixed(2)}MB\n`;
        telegramMessage += `⏰ Time: ${new Date().toLocaleString()}\n`;
        telegramMessage += `✅ Status: Pending Review`;

        // Save file to temporary location
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, fileName);
        fs.writeFileSync(tempFilePath, fileData);

        try {
            // Send file to Telegram
            const formData = new FormData();
            formData.append('chat_id', TELEGRAM_CHAT_ID);
            formData.append('caption', telegramMessage);
            formData.append('parse_mode', 'Markdown');

            const fileStream = fs.createReadStream(tempFilePath);
            formData.append('document', fileStream, fileName);

            const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
            const response = await fetch(telegramApiUrl, {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            // Clean up temp file
            fs.unlinkSync(tempFilePath);

            if (!response.ok || !result.ok) {
                console.error('Telegram API error:', result);
                return {
                    statusCode: 500,
                    body: JSON.stringify({ 
                        error: 'Failed to send file to Telegram. Please try again.' 
                    })
                };
            }

            // Success response
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    message: 'File uploaded successfully! Our team will review and add it to the collection.',
                    fileName: fileName
                })
            };

        } catch (telegramError) {
            // Clean up temp file
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
            
            console.error('Telegram upload error:', telegramError);
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    error: 'Error sending file to Telegram. Please try again later.' 
                })
            };
        }

    } catch (error) {
        console.error('Upload handler error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'An error occurred during upload. Please try again.' 
            })
        };
    }
};
