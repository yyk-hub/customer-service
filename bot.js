const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");
const stringSimilarity = require("string-similarity");

const app = express();
const PORT = process.env.PORT || 10000;

// =======================
// Security Logging (rotate + cleanup)
// =======================
function logSecurityEvent(event) {
  const timestamp = new Date();
  const dateStr = timestamp.toISOString().slice(0, 10); // YYYY-MM-DD
  const logDir = "logs";

  // Ensure logs folder exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }

  const logFile = `${logDir}/security-${dateStr}.log`;
  const line = `[${timestamp.toISOString()}] ${event}\n`;

  fs.appendFileSync(logFile, line, "utf8");
  console.log("🛡️ Security Event:", event);

  // Cleanup: remove logs older than 7 days
  const files = fs.readdirSync(logDir);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days in ms

  files.forEach(file => {
    if (file.startsWith("security-") && file.endsWith(".log")) {
      const dateStr = file.slice(9, 19); // extract YYYY-MM-DD
      const fileDate = new Date(dateStr).getTime();

      if (!isNaN(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(`${logDir}/${file}`);
        console.log(`🗑️ Deleted old log: ${file}`);
      }
    }
  });
}
// =======================
// Configurable Anti-Spam
// =======================
const TEXT_RATE_LIMIT = parseInt(process.env.TEXT_RATE_LIMIT) || 5;
const TEXT_RATE_INTERVAL = parseInt(process.env.TEXT_RATE_INTERVAL) || 60 * 1000;

const IMAGE_RATE_LIMIT = parseInt(process.env.IMAGE_RATE_LIMIT) || 3;
const IMAGE_RATE_INTERVAL = parseInt(process.env.IMAGE_RATE_INTERVAL) || 60 * 1000;
const IMAGE_SIZE_LIMIT = parseInt(process.env.IMAGE_SIZE_LIMIT) || 1.2 * 1024 * 1024; // 1.2 MB

// =======================
// Config
// =======================
const FAQ_MATCH_THRESHOLD = parseFloat(process.env.FAQ_MATCH_THRESHOLD) || 0.6;
const RATE_LIMIT = 5; // max 5 requests
const RATE_INTERVAL = 60 * 1000; // per minute

console.log(`⚙️ Using FAQ_MATCH_THRESHOLD = ${FAQ_MATCH_THRESHOLD}`);

// =======================
// Load FAQ
// =======================
let faq = [];
try {
  const faqData = fs.readFileSync("faq.json", "utf8");
  faq = JSON.parse(faqData);
  console.log("✅ FAQ loaded:", faq.length, "entries");
} catch (err) {
  console.error("❌ Failed to load faq.json:", err);
}

app.use(bodyParser.json());

// =======================
// Anti-Spam Tracking
// =======================
const userRequests = new Map();
const userImageRequests = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) {
    userRequests.set(ip, []);
  }
  const timestamps = userRequests.get(ip).filter(ts => now - ts < RATE_INTERVAL);
  timestamps.push(now);
  userRequests.set(ip, timestamps);

  return timestamps.length > RATE_LIMIT;
}
function isImageRateLimited(ip) {
  const now = Date.now();
  if (!userImageRequests.has(ip)) {
    userImageRequests.set(ip, []);
  }
  const timestamps = userImageRequests.get(ip).filter(ts => now - ts < IMAGE_RATE_INTERVAL);
  
  return timestamps.length >= IMAGE_RATE_LIMIT;
}

function updateRateLimit(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) {
    userRequests.set(ip, []);
  }
  const timestamps = userRequests.get(ip);
  timestamps.push(now);
  // Keep only recent timestamps
  const recentTimestamps = timestamps.filter(ts => now - ts < IMAGE_RATE_INTERVAL);
  userImageRequests.set(ip, recentTimestamps);
}
// =======================
// FAQ checker
// =======================
function checkFAQ(question) {
  if (!faq || faq.length === 0) return null;

  const questions = faq.map(item => item.question);
  const matches = stringSimilarity.findBestMatch(
    question.toLowerCase(),
    questions.map(q => q.toLowerCase())
  );

  if (matches.bestMatch.rating >= FAQ_MATCH_THRESHOLD) {
    const matchedFaq = faq[matches.bestMatchIndex];
    console.log(
      `🔎 FAQ match: "${question}" → "${matchedFaq?.question}" (score: ${matches.bestMatch.rating.toFixed(2)})`
    );
    return matchedFaq ? matchedFaq.answer : null;
  }

  console.log(
    `⚠️ No FAQ match (score: ${matches.bestMatch.rating.toFixed(2)}) for: "${question}"`
  );
  return null;
}

// =======================
// Gemini Vision (image + OCR + totals)
// =======================
async function callGemini(prompt, imageUrl, imageBase64, imageMimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ No Gemini API key found, skipping...");
    return null;
  }

  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
  let mimeType = imageMimeType || "image/jpeg";
  let base64Image = null;
  
  try {
    let parts = [{
      text: `${prompt}\n\nPlease provide:\n1. A full detailed description of the image.\n2. Extract all visible text.\n3. Extract all numbers.\n4. If this looks like a receipt/invoice, calculate the total.`
    }];

    // Case A: external imageUrl
    if (imageUrl) {
      console.log("📥 Fetching image from URL:", imageUrl);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        console.error("❌ Failed to fetch image:", imageResponse.status);
        return null;
      }
      const imageBuffer = await imageResponse.arrayBuffer();
      const sizeBytes = imageBuffer.byteLength;
  const maxSize = 1.2 * 1024 * 1024; // 1.2 MB

  if (sizeBytes > maxSize) {
    const sizeMB = sizeBytes / (1024 * 1024);
    console.warn(`⚠️ Image too large: ${(sizeBytes / 1024).toFixed(1)} KB`);
    return "⚠️ Please upload an image smaller than 1.2 MB.";
  }
      const base64Image = Buffer.from(imageBuffer).toString("base64");
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";

      parts.push({
        inline_data: {
          mime_type: contentType,
          data: base64Image,
        },
      });
    }

    // Case B: direct base64 upload
    if (imageBase64) {
      const sizeBytes = Buffer.from(imageBase64, "base64").length;
  const maxSize = 1.2 * 1024 * 1024;

  if (sizeBytes > maxSize) {
    const sizeMB = sizeBytes / (1024 * 1024);
    console.warn(`⚠️ Base64 image too large: ${(sizeBytes / 1024).toFixed(1)} KB`);
    return "⚠️ Please upload an image smaller than 1.2 MB.";
    }
      
      const mimeType = imageMimeType || "image/jpeg";
      console.log(`📸 Using provided base64 image (${imageBase64.length} chars, type: ${mimeType})`);
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: imageBase64,
        },
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Gemini HTTP Error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log("📨 Gemini raw response:", data);

    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error("❌ Gemini API error:", error);
    return null;
  }      
}
// =======================
// Meta-LLaMA (OpenRouter)
// =======================
async function callLLaMA(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  console.log("🔑 API Key check:", apiKey ? `Found (${apiKey.length} chars)` : "❌ MISSING");
  
  if (!apiKey) {
    console.warn("⚠️ No OpenRouter API key found, skipping...");
    return null;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://customer-service-qbwg.onrender.com",
        "X-Title": "Customer Service Bot"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-8b-instruct:free",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150
      })
    });

    console.log("📥 Response status:", response.status);
    console.log("📥 Response ok:", response.ok);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ HTTP Error:", response.status, errorText);
      return null;
      }

    const data = await response.json();
    console.log("📨 LLaMA raw response:", data);

    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("❌ LLaMA API error:", error);
    return null;
  }
}

// =======================
// Main chat endpoint
// =======================
app.post("/chat", async (req, res) => {
  const { message, imageUrl,imageBase64, imageMimeType } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
  
  if (!message) {
    return res.json({ reply: "⚠️ No message received." });
  }

  // Anti-spam (Text+Image)
  if (isRateLimited(ip)) {
    console.warn(`🚫 Rate limit hit by ${ip}`);
    return res.json({ reply: "⚠️ Too many requests. Please slow down." });
  }
if ((imageUrl || imageBase64) && isImageRateLimited(ip)) {
    console.warn(`🚫 Image rate limit hit by ${ip}`);
    return res.json({ reply: "⚠️ Too many image requests. Please slow down." });
}
  
  // Admin log
  console.log(`👤 [${ip}] User asked: "${message}"`);

  // 1. FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) return res.json({ reply: faqAnswer });

// 2. Image validation before Gemini
  if (imageBase64 || imageMimeType || imageUrl) {
  let mimeType = imageMimeType || "image/jpeg";

  // ✅ Allow only jpeg, png, webp
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(mimeType)) {
    return res.json({ 
      reply: `⚠️ Unsupported image type: ${mimeType}. Please upload JPEG, PNG, or WebP.` 
    });
    }
    // ✅ Check size (for base64)
  if (imageBase64) {
    const sizeBytes = Buffer.from(imageBase64, "base64").length;
    const maxSize = 1.2 * 1024 * 1024; // 1.2MB
    const sizeMB = sizeBytes / (1024 * 1024);
    
    if (sizeBytes > maxSize) {
      return res.json({ 
        reply: `⚠️ Image too large (${sizeMB.toFixed(1)} MB). Please upload under 1.2 MB.` 
      });
    }
    
    console.log(`✅ Image validated: ${sizeMB.toFixed(2)} MB, ${mimeType}`);
  }
    // ✅ Validate imageUrl if provided
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return res.json({ 
          reply: `⚠️ Invalid image URL. Only HTTP/HTTPS URLs are allowed.` 
        });
      }
      console.log(`✅ Image URL validated: ${imageUrl}`);
    } catch (err) {
      return res.json({ 
        reply: `⚠️ Invalid image URL format.` 
      });
    }
  }
    // If valid, call Gemini
    try {
    console.log("🔍 Calling Gemini with validated image...");
    const visionAnswer = await callGemini(message, imageUrl, imageBase64, mimeType);
    
    if (visionAnswer) {
      console.log("✅ Gemini replied successfully");
      return res.json({ reply: visionAnswer });
}
    console.log("❌ Gemini gave no reply, continuing to LLaMA...");
  } catch (err) {
    console.error("❌ Gemini API error:", err.message || err);
    console.log("👉 Falling back to LLaMA...");
  }
  }

  // 3. Meta-LLaMA
  try {
    console.log("🔍 Calling LLaMA...");
    const aiAnswer = await callLLaMA(message);
    
    if (aiAnswer) {
      console.log("✅ LLaMA replied successfully");
      // Update rate limit on successful request
      updateRateLimit(ip);
      updateImageRateLimit(ip);
      return res.json({ reply: aiAnswer });
    }
    
    console.log("❌ LLaMA gave no reply");
  } catch (err) {
    console.error("❌ LLaMA API error:", err.message || err);
}

  // 4. Fallback
  console.log("❌ All AI services failed or gave no response");
  res.json({ reply: "❌ Sorry, I cannot answer that right now. Please try again later." });
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
});
