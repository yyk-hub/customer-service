itconst express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 10000;

// Read from environment or default to 0.6
const FAQ_MATCH_THRESHOLD = parseFloat(process.env.FAQ_MATCH_THRESHOLD) || 0.6;

// Log current FAQ threshold at startup
console.log(`⚙️ Using FAQ_MATCH_THRESHOLD = ${FAQ_MATCH_THRESHOLD}`);
// =======================
// Load FAQ
// =======================
let faq = [];
try {
  const faqData = fs.readFileSync("faq.json", "utf8");
  faq = JSON.parse(faqData);
  console.log("FAQ loaded:", faq.length, "entries");
} catch (err) {
  console.error("Failed to load faq.json:", err);
}

app.use(bodyParser.json());

// =======================
// FAQ checker
// =======================
const stringSimilarity = require("string-similarity");
// Check FAQ with fuzzy matching + log
function checkFAQ(question) {
  if (!faq || faq.length === 0) return null;

  const questions = faq.map(item => item.question);
  const matches = stringSimilarity.findBestMatch(question.toLowerCase(), questions.map(q => q.toLowerCase()));

  if (matches.bestMatch.rating >= FAQ_MATCH_THRESHOLD) {
    const bestQuestion = questions[matches.bestMatchIndex];
    const matchedFaq = faq[matches.bestMatchIndex];

    console.log(`🔎 FAQ match: "${question}" → "${matchedFaq?.question}" (score: ${matches.bestMatch.rating.toFixed(2)})`);

    return matchedFaq ? matchedFaq.answer : null;
  }

  console.log(`⚠️ No FAQ match (score: ${matches.bestMatch.rating.toFixed(2)}) for: "${question}"`);
  return null;
}

// =======================
// DeepSeek via OpenRouter
// =======================
async function callDeepSeek(prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY; // OpenRouter key
  if (!apiKey) {
    console.warn("No OpenRouter API key found, skipping...");
    return null;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://customer-service-qbwg.onrender.com", // optional
        "X-Title": "Customer Service Bot" // optional
      },
      body: JSON.stringify({
       model: "deepseek/deepseek-chat-v3.1:free",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    console.log("DeepSeek raw response:", data);

    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("DeepSeek API error:", error);
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
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { image_url: imageUrl }
              ]
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
  if (!message) {
    return res.json({ reply: "No message received." });
  }

  // 1. FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) return res.json({ reply: faqAnswer });

  // 2. Gemini (if image)
  if (imageUrl) {
    const visionAnswer = await callGemini(message, imageUrl);
    if (visionAnswer) return res.json({ reply: visionAnswer });
  }

  // 3. DeepSeek (text)
  const aiAnswer = await callDeepSeek(message);
  if (aiAnswer) return res.json({ reply: aiAnswer });

  // 4. Fallback
  res.json({ reply: "Sorry, I cannot answer that right now." });
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
