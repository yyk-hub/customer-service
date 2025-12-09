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
    console.log("FAQ loaded:", faq.length, "items");
  } catch (err) {
    console.error("Failed to load FAQ:", err.message);
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
    return faq[matches.bestMatchIndex].answer;
  }

  return null;
}

// ==========================
// Gemini Text-Only API
// ==========================
async function callGemini(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("No Gemini API key");
    return "API Key Missing";
  }

  const systemPrompt = `
You are a multilingual customer service assistant for SHUANG HOR.
Always reply in the same language as the customer's message.
Keep answers short, helpful, and product-focused.
  `;

  const body = {
    contents: [
      {
        parts: [
          { text: systemPrompt + "\nCustomer message: " + userMessage }
        ]
      }
    ]
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    if (!res.ok) {
      console.error("Gemini Error:", await res.text());
      return null;
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;

  } catch (err) {
    console.error("Gemini API Error:", err);
    return null;
  }
}

// ==========================
// Chat Endpoint
// ==========================
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.ip;

  if (!message) return res.json({ reply: "No message received." });

  if (isRateLimited(ip)) {
    return res.json({ reply: "Too many requests. Please slow down." });
  }

  const faqAnswer = checkFAQ(message);
  if (faqAnswer) {
    updateRateLimit(ip);
    return res.json({ reply: faqAnswer });
  }

  const response = await callGemini(message);

  if (response) {
    updateRateLimit(ip);
    return res.json({ reply: response });
  }

  return res.json({ reply: "Service unavailable, try again later." });
});

// ==========================
// Health Check
// ==========================
app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date() });
});

// ==========================
// Start Server
// ==========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
