// ==========================
// ES Module Imports
// ==========================
import express from "express";
import bodyParser from "body-parser";
import cors from "cors"; // to connect Netlify frontend
import  fs from "fs";
import fetch from "node-fetch";
import stringSimilarity from "string-similarity";

const app = express();
// Add CORS middleware
app.use(cors({
  origin: [
    'https://cus-chat.netlify.app',
    'http://localhost:3000', // For local development
    'https://chat-ui-30l.pages.dev',    // ✅ new Cloudflare Pages frontend
    'https://your-custom-domain.com' // If you have a custom domain
  ],
  credentials: true
}));

// ✅ Correct Render port binding
const PORT = process.env.PORT || 3000; // 3000 is only for local testing

// ✅ Use Express built-in parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// =======================
// Configurable Anti-Spam
// =======================
const TEXT_RATE_LIMIT = parseInt(process.env.TEXT_RATE_LIMIT) || 5;
const TEXT_RATE_INTERVAL = parseInt(process.env.TEXT_RATE_INTERVAL) || 60 * 1000;
const IMAGE_RATE_LIMIT = parseInt(process.env.IMAGE_RATE_LIMIT) || 3;
const IMAGE_RATE_INTERVAL = parseInt(process.env.IMAGE_RATE_INTERVAL) || 60 * 1000;

// =======================
// Config
// =======================
const FAQ_MATCH_THRESHOLD = parseFloat(process.env.FAQ_MATCH_THRESHOLD) || 0.6;

console.log(`Using FAQ_MATCH_THRESHOLD = ${FAQ_MATCH_THRESHOLD}`);
console.log(`Text Rate Limit: ${TEXT_RATE_LIMIT}/${TEXT_RATE_INTERVAL/1000}s`);
console.log(`Image Rate Limit: ${IMAGE_RATE_LIMIT}/${IMAGE_RATE_INTERVAL/1000}s`);

// =======================
// Load FAQ
// =======================
let faq = [];
let faqLoaded = false;

(async () => {
  try {
    const faqData = await fs.promises.readFile("faq.json", "utf8");
    faq = JSON.parse(faqData);
    faqLoaded = true;
    console.log("FAQ loaded:", faq.length, "entries");
  } catch (err) {
    console.error("Failed to load FAQ:", err.message);
  }
})();

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
  const timestamps = userRequests.get(ip).filter(ts => now - ts < TEXT_RATE_INTERVAL);
  return timestamps.length >= TEXT_RATE_LIMIT;
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
  const recentTimestamps = timestamps.filter(ts => now - ts < TEXT_RATE_INTERVAL);
  userRequests.set(ip, recentTimestamps);
}

function updateImageRateLimit(ip) {
  const now = Date.now();
  if (!userImageRequests.has(ip)) {
    userImageRequests.set(ip, []);
  }
  const timestamps = userImageRequests.get(ip);
  timestamps.push(now);
  const recentTimestamps = timestamps.filter(ts => now - ts < IMAGE_RATE_INTERVAL);
  userImageRequests.set(ip, recentTimestamps);
}

// =======================
// FAQ checker
// =======================
function checkFAQ(question) {
  if (!faqLoaded || faq.length === 0) return null;

  const questions = faq.map(item => item.question);
  const matches = stringSimilarity.findBestMatch(
    question.toLowerCase(),
    questions.map(q => q.toLowerCase())
  );

  if (matches.bestMatch.rating >= FAQ_MATCH_THRESHOLD) {
    const matchedFaq = faq[matches.bestMatchIndex];
    console.log(`FAQ match: "${question}" -> "${matchedFaq?.question}" (score: ${matches.bestMatch.rating.toFixed(2)})`);
    return matchedFaq ? matchedFaq.answer : null;
  }

  console.log(`No FAQ match (score: ${matches.bestMatch.rating.toFixed(2)}) for: "${question}"`);
  return null;
}

// =======================
// Gemini Vision
// =======================
async function callGemini(prompt, imageUrl, imageBase64, imageMimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("No Gemini API key found, skipping...");
    return null;
  }

  try {
    let parts = [{
      text: `${prompt}\n\nPlease provide:\n1. A full detailed description of the image.\n2. Extract all visible text.\n3. Extract all numbers.\n4. If this looks like a receipt/invoice, calculate the total.`
    }];

    // Case A: external imageUrl
    if (imageUrl) {
      console.log("Fetching image from URL:", imageUrl);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        console.error("Failed to fetch image:", imageResponse.status);
        return null;
      }
      const imageBuffer = await imageResponse.arrayBuffer();
      const sizeBytes = imageBuffer.byteLength;
      const maxSize = 1.2 * 1024 * 1024; // 1.2 MB

      if (sizeBytes > maxSize) {
        const sizeMB = sizeBytes / (1024 * 1024);
        console.warn(`Image too large: ${sizeMB.toFixed(1)} MB`);
        return "Please upload an image smaller than 1.2 MB.";
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
        console.warn(`Base64 image too large: ${sizeMB.toFixed(1)} MB`);
        return "Please upload an image smaller than 1.2 MB.";
      }
      
      const mimeType = imageMimeType || "image/jpeg";
      console.log(`Using provided base64 image (${imageBase64.length} chars, type: ${mimeType})`);
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
      console.error("Gemini HTTP Error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log("Gemini raw response:", JSON.stringify(data, null, 2));

    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error("Gemini API error:", error);
    return null;
  }      
}

// =======================
// Meta-LLaMA (OpenRouter)
// =======================

 // ✅ Circuit breaker variables

let rateLimitHit = false;
let rateLimitHitTime = null;
let requestCount = 0; //Manual count for Llama 3.38b:free tier

async function callLLaMA(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  console.log("API Key check:", apiKey ? `Found (${apiKey.length} chars)` : "MISSING");
  
  if (!apiKey) {
    console.warn("No OpenRouter API key found, skipping...");
    return null;
  }
  // ✅ Multilingual customer service prompt
  const multilingualPrompt = `You are a helpful multilingual customer service assistant. Respond in the same language the customer uses. Answer questions about products, services, policies, billing, and technical support in any language.
If asked about unrelated topics (politics, advice, other products), politely redirect in the customer's language to Shuang Hor products.
Be concise and complete your thought. Short but well-structured answer.
Customer question: ${prompt}`;
  
//Circuit breaker check
if (rateLimitHit) {
const timeSinceHit = Date.now() - rateLimitHitTime;
// Don't try API for 5 minutes after 429
if (timeSinceHit < 5 * 60 * 1000) {
console.log("Circuit breaker active - skipping API call");
return "Service temporarily limited. Please try again in a few minutes.";
} else {
// Reset after 5 minutes and try again
rateLimitHit = false;
rateLimitHitTime = null;
console.log("Circuit breaker reset - trying API again");
   }
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
        messages: [
          { role: "system",
           content: "You are a multilingual customer service assistant. Always respond in the same language the customer uses."
          },
          { role: "user", content: multilingualPrompt }],
        max_tokens:120,
        temperature: 0.3
      })
    });

// Simple counter for Llama 3.38b:free tier
requestCount++;
console.log(`Request #${requestCount} (Free tier: ~50/day limit)`);

if (requestCount > 45) {
  console.warn("Approaching free tier limit (~50 requests/day)");
}
// Handle 429 (rate limited)
if (response.status === 429) {
rateLimitHit = true;
rateLimitHitTime = Date.now();
console.warn("🚨 Rate limit hit - activating circuit breaker");
      return "Service temporarily limited. Please try again in a few minutes.";
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("LLaMA HTTP Error:", response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log("LLaMA raw response:", JSON.stringify(data, null, 2));

    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("LLaMA API error:", error);
    return null;
  }
}

// Add this new function for tracing Api Key Limit
async function getOpenRouterUsage() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error('Usage API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.data;
  } catch (error) {
    console.error('Usage API error:', error);
    return null;
  }
}


// =======================
// Main chat endpoint
// =======================
app.post("/api/chat", async (req, res) => {
  const { message, imageUrl, imageBase64, imageMimeType } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
  
  if (!message) {
    return res.json({ reply: "No message received." });
  }

  // Anti-spam checks
  if (isRateLimited(ip)) {
    console.warn(`Rate limit hit by ${ip}`);
    return res.json({ reply: "Too many requests. Please slow down." });
  }
  
  if ((imageUrl || imageBase64) && isImageRateLimited(ip)) {
    console.warn(`Image rate limit hit by ${ip}`);
    return res.json({ reply: "Too many image requests. Please slow down." });
  }
  
  console.log(`[${ip}] User asked: "${message}"`);

  // 1. FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) {
    updateRateLimit(ip);
    return res.json({ reply: faqAnswer });
  }

  // 2. Image processing with Gemini
  if (imageBase64 || imageMimeType || imageUrl) {
    let mimeType = imageMimeType || "image/jpeg";

    // Validate image type
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(mimeType)) {
      return res.json({ 
        reply: `Unsupported image type: ${mimeType}. Please upload JPEG, PNG, or WebP.` 
      });
    }
    
    // Validate base64 image size
    if (imageBase64) {
      const sizeBytes = Buffer.from(imageBase64, "base64").length;
      const maxSize = 1.2 * 1024 * 1024; // 1.2MB
      const sizeMB = sizeBytes / (1024 * 1024);
      
      if (sizeBytes > maxSize) {
        return res.json({ 
          reply: `Image too large (${sizeMB.toFixed(1)} MB). Please upload under 1.2 MB.` 
        });
      }
      
      console.log(`Image validated: ${sizeMB.toFixed(2)} MB, ${mimeType}`);
    }
    
    // Validate image URL
    if (imageUrl) {
      try {
        const url = new URL(imageUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          return res.json({ 
            reply: "Invalid image URL. Only HTTP/HTTPS URLs are allowed." 
          });
        }
        console.log(`Image URL validated: ${imageUrl}`);
      } catch (err) {
        return res.json({ 
          reply: "Invalid image URL format." 
        });
      }
    }
    
    // Call Gemini for image processing
    try {
      console.log("Calling Gemini with validated image...");
      const visionAnswer = await callGemini(message, imageUrl, imageBase64, mimeType);
      
      if (visionAnswer) {
        console.log("Gemini replied successfully");
        updateRateLimit(ip);
        updateImageRateLimit(ip);
        return res.json({ reply: visionAnswer });
      }
      
      console.log("Gemini gave no reply, continuing to LLaMA...");
    } catch (err) {
      console.error("Gemini API error:", err.message || err);
      console.log("Falling back to LLaMA...");
    }
  }

  // 3. Meta-LLaMA for text
  try {
    console.log("Calling LLaMA...");
    const aiAnswer = await callLLaMA(message);
    
    if (aiAnswer) {
      console.log("LLaMA replied successfully");
      updateRateLimit(ip);
      return res.json({ reply: aiAnswer });
    }
    
    console.log("LLaMA gave no reply");
  } catch (err) {
    console.error("LLaMA API error:", err.message || err);
  }

  // 4. Fallback
  console.log("All AI services failed or gave no response");
  res.json({ reply: "Sorry, I cannot answer that right now. Please try again later." });
});

// =======================
// Orders Endpoint (CEO_orders)
// =======================
import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

// ---------- Initialize Database ----------
async function initDB() {
  db = await open({
    filename: "./ceo_orders.db",
    driver: sqlite3.Database
  });
  console.log("✅ Connected to ceo_orders.db");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ceo_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      cus_name TEXT,
      cus_address TEXT,
      postcode TEXT,
      state_to TEXT,
      country TEXT,
      phone TEXT,
      prod_name TEXT,
      quantity INTEGER,
      total_amt REAL,
      shipping_wt REAL,
      state_from TEXT,
      shipping_method TEXT,
      shipping_cost REAL,
      delivery_eta TEXT,
      pymt_method TEXT,
      pymt_status TEXT,
      courier_name TEXT,
      tracking_link TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("🧱 Table 'ceo_orders' ready");
}

initDB().catch((err) => console.error("❌ Database init failed:", err));


// ---------- Create New Order ----------
app.post("/api/orders", async (req, res) => {
  try {
    const order = req.body;

    if (!order.order_id || !order.cus_name || !order.prod_name) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const stmt = `
      INSERT INTO ceo_orders (
        order_id, cus_name, cus_address, postcode, state_to, country, phone,
        prod_name, quantity, total_amt, shipping_wt,
        state_from, shipping_method, shipping_cost, delivery_eta,
        pymt_method, pymt_status, courier_name, tracking_link
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const shippingCost = order.shipping_cost || 0;

    await db.run(stmt, [
      order.order_id,
      order.cus_name,
      order.cus_address,
      order.postcode,
      order.state_to || order.state,
      order.country || "Malaysia",
      order.phone,
      order.prod_name,
      order.quantity || 1,
      order.total_amt,
      order.shipping_wt,
      order.state_from || "Sabah",
      order.shipping_method || "Pos Laju",
      shippingCost,
      order.delivery_eta || "3 working days",
      order.pymt_method,
      order.pymt_status,
      order.courier_name || "Pos Laju",
      order.tracking_link
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error saving order:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---------- Get Latest 10 Orders ----------
app.get("/api/orders", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM ceo_orders ORDER BY created_at DESC LIMIT 10");
    res.json(rows);
  } catch (err) {
    console.error("❌ Fetch orders error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ---------- Get Orders by Phone ----------
app.get("/api/orders/by-phone", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: "Missing phone" });
    const rows = await db.all(
      "SELECT * FROM ceo_orders WHERE phone = ? ORDER BY created_at DESC",
      phone
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Fetch orders by phone error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add endpoint to check usage
app.get('/usage', async (req, res) => {
  const usage = await getOpenRouterUsage();
  
  if (usage) {
    res.json({
      label: usage.label,
      usage: usage.usage,
      limit: usage.limit,
      is_free_tier: usage.is_free_tier,
      localCounter: requestCount,
      status: usage.is_free_tier ? 'Free Tier' : 'Paid'
    });
  } else {
    res.json({ 
      error: 'Could not fetch usage data',
      localCounter: requestCount 
    });
  }
});

// =======================
// Health check endpoint
// =======================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// =======================
// Start server
// =======================
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Bot running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
