// server.js - Optimized for cPanel hosting
// This script sets up an Express server to receive invoice files and
// send them via WhatsApp using the Baileys library.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIO = require('socket.io');
const puppeteer = require('puppeteer');
console.log('[WA] Puppeteer Chromium path:', puppeteer.executablePath());

// --- WhatsApp-web.js Setup ---
let whatsappClient;
let latestQR = null;
let whatsappReady = false;
const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session-inventory-wa');

function clearWhatsAppSession() {
    // Remove whatsapp-web.js session directory for a fresh start
    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log('Old WhatsApp session cleared. Will prompt fresh QR.');
        }
    } catch (e) {
        console.error('Failed to clear WhatsApp session:', e);
    }
}

function initWhatsAppClient() {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'inventory-wa' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    whatsappClient.on('qr', (qr) => {
        latestQR = qr;
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) {
                // Optionally emit QR to frontend via socket.io
                io.emit('wa-qr', { qr, url });
            }
        });
    });

    whatsappClient.on('ready', () => {
        whatsappReady = true;
        latestQR = null;
        io.emit('wa-status', { status: 'Connected' });
        console.log('WhatsApp client is ready!');
    });

    whatsappClient.on('authenticated', () => {
        whatsappReady = true;
        latestQR = null;
        io.emit('wa-status', { status: 'Authenticated' });
        console.log('WhatsApp client authenticated!');
    });

    whatsappClient.on('auth_failure', (msg) => {
        whatsappReady = false;
        latestQR = null;
        io.emit('wa-status', { status: 'Auth Failure', message: msg });
        console.error('WhatsApp auth failure:', msg);
        clearWhatsAppSession();
        setTimeout(() => initWhatsAppClient(), 2000);
    });

    whatsappClient.on('disconnected', (reason) => {
        whatsappReady = false;
        latestQR = null;
        io.emit('wa-status', { status: 'Disconnected', reason });
        console.log('WhatsApp client disconnected:', reason);
        clearWhatsAppSession();
        setTimeout(() => initWhatsAppClient(), 2000);
    });

    whatsappClient.initialize();
}

// --- Express Server Setup ---
const app = express();
app.use(cors()); // Allow all origins for now. Restrict in production if needed.

// Manual endpoint to reset WhatsApp session and force fresh QR
app.post('/wa-reset', (req, res) => {
    clearWhatsAppSession();
    setTimeout(() => initWhatsAppClient(), 1000);
    res.json({ status: 'reset', message: 'WhatsApp session cleared. Please reload and scan new QR.' });
});
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: '*', // Allow all origins for development
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true
    }
});

// cPanel environment variables - use these instead of hardcoded values
const port = process.env.PORT || process.env.NODEJS_PORT || 3000;
const ip = process.env.IP || process.env.NODEJS_IP || 'localhost'; // Changed from 0.0.0.0 to localhost

// Configure Multer for file uploads with size limits
const upload = multer({ 
    dest: 'uploads/',
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Enable CORS for development (you might want to restrict this in production)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // Allow requests from any origin
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.use(express.json({ limit: '10mb' })); // To parse JSON request bodies

// --- REST API for external web apps ---
// 1. WhatsApp status endpoint
app.get('/wa-status', (req, res) => {
    if (whatsappReady && whatsappClient && whatsappClient.info && whatsappClient.info.wid) {
        res.json({ status: 'Connected', user: whatsappClient.info.wid });
    } else {
        res.json({ status: 'waiting' });
    }
});

// 2. WhatsApp QR endpoint
app.get('/wa-qr', (req, res) => {
    if (latestQR) {
        res.json({ qr: latestQR });
    } else {
        res.status(404).json({ error: 'No QR available' });
    }
});

// 3. WhatsApp send message endpoint
const uploadSingle = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }
}).single('file');

app.post('/wa-send', uploadSingle, async (req, res) => {
    console.log('--- /wa-send request received ---');
    console.log('Request body:', req.body);
    console.log('Request file:', req.file);
    if (req.err) {
        console.error('File upload error:', req.err);
        return res.status(500).json({ error: 'File upload failed.' });
    }
    let { to, message } = req.body;

    // Normalize phone number to WhatsApp JID (Sri Lanka country code 94)
    let raw = String(to || '').replace(/[^0-9]/g, '');
    let normalized = '';
    if (raw.length === 10 && raw.startsWith('0')) {
        // Local format with leading 0: 077xxxxxxx
        normalized = '94' + raw.slice(1);
    } else if (raw.length === 9) {
        // Local format without leading 0: 77xxxxxxx
        normalized = '94' + raw;
    } else if (raw.length === 11 && raw.startsWith('94')) {
        // Already in correct format
        normalized = raw;
    } else if (raw.length === 12 && raw.startsWith('94')) {
        // Some users may enter 94XXXXXXXXXX
        normalized = raw;
    } else {
        return res.status(400).json({ error: 'Invalid phone number format. Please enter a valid Sri Lankan number (e.g., 0771234567 or 771234567).', input: to, normalized });
    }
    const jid = normalized + '@s.whatsapp.net';

    if (!whatsappReady || !whatsappClient) {
        console.warn('WhatsApp not ready. latestQR:', latestQR);
        if (latestQR) {
            return res.status(503).json({ qr: latestQR, error: 'WhatsApp not connected. Scan QR to reconnect.' });
        }
        return res.status(503).json({ error: 'WhatsApp not connected and no QR available.' });
    }
    try {
        if (req.file) {
            // Send file as document using whatsapp-web.js MessageMedia
            const filePath = path.isAbsolute(req.file.path) ? req.file.path : path.join(__dirname, req.file.path);
            console.log('Sending file as document:', filePath, 'to:', jid, 'caption:', message);
            try {
                const { MessageMedia } = require('whatsapp-web.js');
                const mime = require('mime-types');
                const fileBuffer = fs.readFileSync(filePath);
                console.log('[WA-SEND] Read fileBuffer:', fileBuffer.length, 'bytes');
                const base64data = fileBuffer.toString('base64');
                console.log('[WA-SEND] Base64 length:', base64data.length);
                const mimetype = req.file.mimetype || mime.lookup(req.file.originalname) || 'application/octet-stream';
                const originalname = req.file.originalname;
                console.log('[WA-SEND] Preparing MessageMedia:', { mimetype, originalname });
                let media = new MessageMedia(mimetype, base64data, originalname);
                console.log('[WA-SEND] Sending MessageMedia to', jid);
                const sendResult = await whatsappClient.sendMessage(jid, media, { caption: message || undefined });
                console.log('[WA-SEND] sendMessage result:', sendResult);
                // Clean up file after sending
                fs.unlink(filePath, () => {});
                console.log('Attachment sent successfully.');
                res.json({ status: 'sent', normalizedTo: normalized, file: originalname });
                return;
            } catch (err) {
                console.error('Error preparing or sending attachment:', err);
                res.status(500).json({ error: 'Failed to send attachment.', details: err.message, normalizedTo: normalized });
                return;
            }
        } else {
            // Send text message
            console.log('Sending text message to:', jid, 'message:', message);
            await whatsappClient.sendMessage(jid, message);
        }
        console.log('Message sent successfully.');
        res.json({ status: 'sent', normalizedTo: normalized });
    } catch (e) {
        console.error('Error sending WhatsApp message:', e);
        res.status(500).json({ error: 'Failed to send message.', details: e.message, stack: e.stack, normalizedTo: normalized });
    }
});

app.use(express.static(__dirname)); // Serve static files

// Start WhatsApp client
initWhatsAppClient();

// Ensure 'uploads' directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// --- API Endpoint to Send Invoice ---
app.post('/send-invoice', upload.single('invoiceFile'), async (req, res) => {
    const mobileNumber = req.body.mobileNumber;
    const invoiceFile = req.file;

    // Validate inputs
    if (!mobileNumber || !invoiceFile) {
        return res.status(400).json({ error: 'Mobile number and invoice file are required.' });
    }

    // Ensure mobile number is in the correct WhatsApp format
    const jid = `${mobileNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    console.log(`Attempting to send invoice to: ${jid}`);

    if (!whatsappReady || !whatsappClient) {
        console.error('WhatsApp client not connected. Please scan QR code.');
        return res.status(503).json({ error: 'WhatsApp client not ready. Please wait for connection or scan QR code.' });
    }

    try {
        const filePath = path.join(__dirname, invoiceFile.path);
        const fileBuffer = fs.readFileSync(filePath);

        // Send the document (invoice) using whatsapp-web.js
        await whatsappClient.sendMessage(jid, {
            document: fileBuffer,
            mimetype: invoiceFile.mimetype,
            filename: invoiceFile.originalname,
            caption: 'Here is your invoice. Thank you for your business!',
        });

        // Clean up: delete the temporary file after sending
        fs.unlinkSync(filePath);
        console.log(`Invoice sent successfully to ${jid}`);
        res.status(200).json({ message: 'Invoice sent successfully!' });

    } catch (error) {
        console.error('Error sending invoice:', error);
        // If file exists, try to delete it even if send fails
        if (invoiceFile && fs.existsSync(path.join(__dirname, invoiceFile.path))) {
             fs.unlinkSync(path.join(__dirname, invoiceFile.path));
        }
        res.status(500).json({ error: 'Failed to send invoice.', details: error.message });
    }
});

// Send latest QR to new clients
io.on('connection', (socket) => {
    if (latestQR) {
        socket.emit('qr', latestQR);
        socket.emit('status', 'Please scan QR code');
    }
});

// Memory cleanup interval
setInterval(() => {
    if (global.gc) {
        global.gc();
    }
    
    // Additional memory cleanup for whatsapp-web.js (add logic if needed)
    // No 'sock' or Baileys-specific cleanup needed.
    
    // Force Node.js garbage collection even without --expose-gc flag
    try {
        if (!global.gc) {
            console.log('Attempting manual memory cleanup');
            // This is less effective than global.gc but can help
            const used = process.memoryUsage();
            console.log(`Memory usage: ${Math.round(used.rss / 1024 / 1024)} MB`);
        }
    } catch (e) {}
}, 30000); // Run every 30 seconds

// Start the Express server
server.listen(port, ip, () => {
    console.log(`Server is running on http://${ip}:${port}`);
    console.log('Waiting for WhatsApp connection. Scan QR code if prompted.');
});