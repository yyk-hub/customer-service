// ==========================
// Imports
// ==========================
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import stringSimilarity from "string-similarity";

// ==========================
// App Setup
// ==========================
const app = express();

// CORS (keep your original domains)
app.use(cors({
  origin: [
    'https://cus-chat.netlify.app',
    'http://localhost:3000',
    'https://chat-ui-30l.pages.dev',
    'https://ceo-9xi.pages.dev',
    'https://your-custom-domain.com'
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(bodyParser.json());

// Correct Render port binding
const PORT = process.env.PORT || 3000;

// Express parsers
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ==========================
// Config
// ==========================
const FAQ_MATCH_THRESHOLD = parseFloat(process.env.FAQ_MATCH_THRESHOLD) || 0.6;

console.log(`FAQ match threshold = ${FAQ_MATCH_THRESHOLD}`);

// ==========================
// FAQ Loader
// ==========================
let faq = [];
let faqLoaded = false;

(async() => {
  try {
    const faqData = await fs.promises.readFile("faq.json", "utf8");
    faq = JSON.parse(faqData);
    faqLoaded = true;
    console.log("FAQ loaded:", faq.length, "items");
  } catch (err) {
    console.error("Cannot load FAQ:", err.message);
  }
})();

// ==========================
// Simple Rate Limiting
// ==========================
const userRequests = new Map();
const TEXT_RATE_LIMIT = 5;
const TEXT_RATE_INTERVAL = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) userRequests.set(ip, []);
  const timestamps = userRequests.get(ip).filter(t => now - t < TEXT_RATE_INTERVAL);
  return timestamps.length >= TEXT_RATE_LIMIT;
}

function updateRateLimit(ip) {
  const now = Date.now();
  if (!userRequests.has(ip)) userRequests.set(ip, []);
  const timestamps = userRequests.get(ip);
  timestamps.push(now);
  userRequests.set(ip, timestamps.filter(t => now - t < TEXT_RATE_INTERVAL));
}

// ==========================
// FAQ Checker
// ==========================
function checkFAQ(question) {
  if (!faqLoaded) return null;

  const questions = faq.map(q => q.question);
  const matches = stringSimilarity.findBestMatch(
    question.toLowerCase(),
    questions.map(q => q.toLowerCase())
  );

  if (matches.bestMatch.rating >= FAQ_MATCH_THRESHOLD) {
    const matched = faq[matches.bestMatchIndex];
    return matched.answer;
  }
  return null;
}

// ==========================
// Gemini Text-Only
// ==========================
async function callGeminiText(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("Missing GEMINI_API_KEY");
    return "Server missing Gemini API key.";
  }

  const body = {
    contents: [
      {
        parts: [
          {
            text: `You are a multilingual customer service assistant for SHUANG HOR.
Always reply in the same language as the customer's message.
Keep answers short, helpful, and product-focused.

Customer message: ${prompt}`
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini error:", response.status, errText);
      return null;
    }

    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;

  } catch (err) {
    console.error("Gemini API failure:", err);
    return null;
  }
}

// ==========================
// Main Chat Endpoint
// ==========================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.ip;

  if (!message) return res.json({ reply: "No message received." });

  if (isRateLimited(ip)) {
    return res.json({ reply: "Too many requests. Please slow down." });
  }

  // 1) FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) {
    updateRateLimit(ip);
    return res.json({ reply: faqAnswer });
  }

  // 2) Gemini text
  const aiReply = await callGeminiText(message);
  if (aiReply) {
    updateRateLimit(ip);
    return res.json({ reply: aiReply });
  }

  // 3) Fallback
  return res.json({ reply: "Sorry, I cannot answer right now." });
});

// ==========================
// Health Check
// ==========================
app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
});

// ==========================
// Start Server
// ==========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
