// ==========================
// Imports
// ==========================
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import stringSimilarity from "string-similarity";

// ==========================
// App Setup
// ==========================
const app = express();

app.use(cors({
  origin: [
    "https://cus-chat.netlify.app",
    "http://localhost:3000",
    "https://chat-ui-30l.pages.dev",
    "https://ceo-9xi.pages.dev",
    "https://your-custom-domain.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.json());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// ==========================
// Configurable Anti-Spam
// ==========================
const TEXT_RATE_LIMIT = 5;
const TEXT_RATE_INTERVAL = 60 * 1000;

const userRequests = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) userRequests.set(ip, []);
  const filtered = userRequests.get(ip).filter(ts => now - ts < TEXT_RATE_INTERVAL);
  return filtered.length >= TEXT_RATE_LIMIT;
}
function updateRateLimit(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) userRequests.set(ip, []);
  const arr = userRequests.get(ip);
  arr.push(now);
  userRequests.set(ip, arr.filter(ts => now - ts < TEXT_RATE_INTERVAL));
}

// ==========================
// Load FAQ File
// ==========================
let faq = [];
let faqLoaded = false;

(async () => {
  try {
    const data = await fs.promises.readFile("faq.json", "utf8");
    faq = JSON.parse(data);
    faqLoaded = true;
    console.log("✅ FAQ loaded:", faq.length, "items");
  } catch (err) {
    console.error("❌ Failed to load FAQ:", err.message);
  }
})();

const FAQ_MATCH_THRESHOLD = 0.6;

function checkFAQ(question) {
  if (!faqLoaded || faq.length === 0) return null;

  const questions = faq.map(f => f.question);
  const matches = stringSimilarity.findBestMatch(
    question.toLowerCase(),
    questions.map(q => q.toLowerCase())
  );

  if (matches.bestMatch.rating >= FAQ_MATCH_THRESHOLD) {
    console.log(`✅ FAQ Match: "${question}" -> score: ${matches.bestMatch.rating.toFixed(2)}`);
    return faq[matches.bestMatchIndex].answer;
  }

  console.log(`No FAQ match for: "${question}" (best score: ${matches.bestMatch.rating.toFixed(2)})`);
  return null;
}

// ==========================
// Groq API
// ==========================
async function callGroq(userMessage) {
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    console.error("❌ No Groq API key found!");
    return null;
  }

  const systemPrompt = `You are a customer service assistant for Shuang Hor (双鹤) health and wellness products.

CRITICAL: You MUST reply in the EXACT SAME LANGUAGE as the customer's question.
- Customer writes in English → You reply in English
- Customer writes in Chinese → You reply in Chinese  
- Customer writes in Malay → You reply in Malay

Guidelines:
- Be helpful, friendly, and professional
- Keep answers concise (2-3 sentences max)
- Focus on Shuang Hor products: CEO Coffee, Lu Chun Tea, Lingzhi, Lacto-Berry, Greenzhi Toothgel, Pollen, Soya Powder, GoEco Cleaner, VitaKing2, AquaSense, VCare Shampoo
- If asked about unrelated topics, politely redirect to Shuang Hor products in the customer's language`;

  try {
    console.log("🔄 Calling Groq API...");
    
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: 200,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Groq HTTP Error ${response.status}:`, errorText);
      return null;
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content;

    if (answer) {
      console.log("✅ Groq replied successfully");
      return answer;
    }

    console.warn("⚠️ Groq returned empty response");
    return null;

  } catch (err) {
    console.error("❌ Groq API Error:", err.message);
    return null;
  }
}

// ==========================
// Chat Endpoint
// ==========================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.ip;

  if (!message) {
    return res.json({ reply: "No message received." });
  }

  // Anti-spam check
  if (isRateLimited(ip)) {
    console.warn(`⚠️ Rate limit hit by ${ip}`);
    return res.json({ reply: "Too many requests. Please slow down." });
  }

  console.log(`📩 [${ip}] User asked: "${message}"`);

  // 1. Check FAQ first (instant, free)
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) {
    updateRateLimit(ip);
    return res.json({ reply: faqAnswer });
  }

  // 2. Try Groq API
  const groqResponse = await callGroq(message);
  if (groqResponse) {
    updateRateLimit(ip);
    return res.json({ reply: groqResponse });
  }

  // 3. Fallback if Groq fails
  console.error("❌ Groq API failed");
  return res.json({ 
    reply: "Sorry, I'm having trouble connecting right now. Please try again in a moment or contact us via WhatsApp at +60168101358." 
  });
});

// ==========================
// Health Check
// ==========================
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    time: new Date(),
    faqLoaded: faqLoaded,
    faqCount: faq.length,
    groqApiKey: !!process.env.GROQ_API_KEY
  });
});

// ==========================
// Start Server
// ==========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 FAQ loaded: ${faqLoaded} (${faq.length} items)`);
  console.log(`🔑 Groq API: ${process.env.GROQ_API_KEY ? '✅ Found' : '❌ MISSING - Add GROQ_API_KEY to environment variables!'}`);
});
