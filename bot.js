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
const REQUEST_LIMIT = 5; // per minute
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
// Anti-spam (simple per-IP rate limit)
// =======================
const requestCounts = {};
setInterval(() => {
  for (let ip in requestCounts) requestCounts[ip] = 0;
}, 60 * 1000); // reset every minute

function checkRateLimit(ip) {
  if (!requestCounts[ip]) requestCounts[ip] = 0;
  requestCounts[ip]++;
  if (requestCounts[ip] > REQUEST_LIMIT) return false;
  return true;
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
// OpenRouter: Meta-LLaMA
// =======================
async function callLLaMA(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("No OpenRouter API key found, skipping LLaMA...");
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
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    console.log("LLaMA raw response:", data);
    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("LLaMA API error:", error);
    return null;
  }
}

// =======================
// Gemini Vision (image support)
// =======================
async function callGemini(prompt, imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("No Gemini API key found, skipping...");
    return null;
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }, imageUrl ? { image_url: imageUrl } : {}]
            }
          ]
        })
      }
    );

    const data = await response.json();
    console.log("Gemini raw response:", data);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error("Gemini API error:", error);
    return null;
  }
}

// =======================
// Main chat endpoint
// =======================
app.post("/chat", async (req, res) => {
  const { message, imageUrl } = req.body;
  const userIp = req.ip;

  // 1. Rate limit
  if (!checkRateLimit(userIp)) {
    console.warn(`🚨 Spam blocked from ${userIp}`);
    return res.json({ reply: "You are sending too many requests. Please slow down." });
  }

  // 2. FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) return res.json({ reply: faqAnswer });

  // 3. Gemini (if image)
  if (imageUrl) {
    const visionAnswer = await callGemini(message, imageUrl);
    if (visionAnswer) return res.json({ reply: visionAnswer });
  }

  // 4. LLaMA (default for text)
  let aiAnswer = await callLLaMA(message);

  // 5. Fallback
  if (!aiAnswer) aiAnswer = "Sorry, I cannot answer that right now.";

  res.json({ reply: aiAnswer });
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`🤖 Bot running on port ${PORT}`);
});
