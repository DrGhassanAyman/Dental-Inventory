// مثال خادم Node.js وسيط لإرسال WhatsApp Cloud API بدون مشاكل CORS
// npm install express cors node-fetch
// node server-example.js

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.post('/api/send-whatsapp', async (req, res) => {
  const { phoneNumberId, accessToken, to, message } = req.body;
  if (!phoneNumberId || !accessToken || !to || !message) {
    return res.status(400).json({ error: 'بيانات ناقصة' });
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { preview_url: false, body: message }
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json(data);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000 - افتح index.html عبر http://localhost:3000'));
