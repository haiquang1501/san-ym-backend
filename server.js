const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Mongoose connection
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is missing in .env file.");
  console.error("Please add MONGODB_URI=mongodb+srv://... to your .env file.");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB successfully!'))
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  credits: { type: Number, default: 3 }
});
const User = mongoose.model('User', userSchema);

// 0. HEALTH CHECK
app.get('/', (req, res) => {
  res.send('SAN YM Backend is running with MongoDB! Cài đặt thành công, hãy sử dụng Extension nhé.');
});

// 1. GOOGLE LOGIN API
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    const ticket = await client.verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;

    if (!email) return res.status(400).json({ error: 'Cannot extract email from token' });

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ email, credits: 3 }); // Give 3 free credits to new users
    }

    res.json({ success: true, email: user.email, credits: user.credits });
  } catch (err) {
    console.error('Verify Token Error:', err);
    res.status(401).json({ error: 'Invalid Google Token' });
  }
});

// 2. GET CREDITS
app.get('/api/credits', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ credits: user.credits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 3. BUY CREDITS (MOCK WEBHOOK)
app.post('/api/buy', async (req, res) => {
  try {
    const { email, amount } = req.body;
    if (!email || !amount) return res.status(400).json({ error: 'Email and amount are required' });

    const user = await User.findOneAndUpdate(
      { email },
      { $inc: { credits: amount } },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, credits: user.credits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 4. GENERATE PROMPT
app.post('/api/generate', async (req, res) => {
  const { email, imageBase64, textPrompt } = req.body;
  
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'User not found' });

    if (user.credits <= 0) {
      return res.status(403).json({ error: 'Insufficient credits', credits: 0 });
    }

    const apiKeysString = process.env.GEMINI_API_KEY;
    if (!apiKeysString) {
      return res.status(500).json({ error: 'Server configuration error: Missing Gemini API Key' });
    }

    // Tách các API Key bằng dấu phẩy và chọn ngẫu nhiên 1 Key
    const apiKeys = apiKeysString.split(',').map(k => k.trim()).filter(k => k);
    if (apiKeys.length === 0) {
      return res.status(500).json({ error: 'Server configuration error: Invalid API Key format' });
    }
    
    const apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];

    const modelsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsData = await modelsResponse.json();
    
    if (modelsData.error) {
      return res.status(500).json({ error: 'API Key Error: ' + modelsData.error.message });
    }

    const availableModels = modelsData.models || [];
    let modelsToTry = [];
    
    const preferredModels = [
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-pro'
    ];

    for (const pref of preferredModels) {
      if (availableModels.find(m => m.name === `models/${pref}`)) {
        modelsToTry.push(pref);
      }
    }

    if (modelsToTry.length === 0) {
      return res.status(500).json({ error: `Your API key does not have access to Gemini Flash or Vision.` });
    }

    let data = null;
    let lastError = null;
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    for (const selectedModel of modelsToTry) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
      
      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: textPrompt || 'Describe this image in detail' },
              { inline_data: { mime_type: "image/jpeg", data: base64Data } }
            ]
          }]
        })
      });

      data = await apiResponse.json();
      
      if (!data.error) {
        break; // Success!
      } else {
        lastError = data.error.message;
        console.error(`Model ${selectedModel} failed:`, lastError);
      }
    }

    if (data.error) {
      let msg = data.error.message;
      if (msg.includes("Quota") || msg.includes("429")) {
        msg = "Hệ thống API đang quá tải hoặc hết Quota. Vui lòng thử lại sau!";
      }
      return res.status(500).json({ error: msg });
    }

    if (data.candidates && data.candidates[0].content.parts[0].text) {
      // Deduct credit
      user.credits -= 1;
      await user.save();

      return res.json({ 
        prompt: data.candidates[0].content.parts[0].text.trim(),
        credits: user.credits
      });
    }

    res.status(500).json({ error: 'Failed to generate prompt' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SAN YM Backend running on http://localhost:${PORT}`);
});
