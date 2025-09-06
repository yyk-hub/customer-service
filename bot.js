const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");
const stringSimilarity = require("string-similarity");

const app = express();
const PORT = process.env.PORT || 10000;

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
// Gemini Vision (image support)
// =======================
async function callGemini(prompt, imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
console.log("🔑 API Key check:", apiKey ? `Found (${apiKey.length} chars)` : "❌ MISSING");
  
  if (!apiKey) {
    console.warn("⚠️ No Gemini API key found, skipping...");
    return null;
  }

  try {
    console.log("📤 Sending request to OpenRouter...");
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                ...(imageUrl ? [{ image_url: imageUrl }] : [])
              ]
            }
          ]
        })
      }
    );

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
  const { message, imageUrl } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
console.log(`👤 [${ip}] User asked:"${message}"`);
  
  if (!message) {
    return res.json({ reply: "⚠️ No message received." });
  }

  // Anti-spam
  if (isRateLimited(ip)) {
    console.warn(`🚫 Rate limit hit by ${ip}`);
    return res.json({ reply: "⚠️ Too many requests. Please slow down." });
  }

  // Admin log
  console.log(`👤 [${ip}] User asked: "${message}"`);

  // 1. FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) return res.json({ reply: faqAnswer });

  // 2. Gemini (if image)
  if (imageUrl) {
    const visionAnswer = await callGemini(message, imageUrl);
    if (visionAnswer) return res.json({ reply: visionAnswer });
  }

  // 3. Meta-LLaMA
  const aiAnswer = await callLLaMA(message);
  if (aiAnswer) return res.json({ reply: aiAnswer });

  // 4. Fallback
  res.json({ reply: "❌ Sorry, I cannot answer that right now." });
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
});
