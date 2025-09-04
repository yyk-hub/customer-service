const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");
const stringSimilarity = require("string-similarity"); // NEW: fuzzy matching

const app = express();
const PORT = process.env.PORT || 10000;

// Load FAQ
let faq = [];
try {
  const faqData = fs.readFileSync("faq.json", "utf8");
  faq = JSON.parse(faqData);
  console.log("FAQ loaded:", faq.length, "entries");
} catch (err) {
  console.error("Failed to load faq.json:", err);
}

app.use(bodyParser.json());

// Check FAQ with fuzzy matching
function checkFAQ(question) {
  if (!faq || faq.length === 0) return null;

  const questions = faq.map(item => item.question);
  const bestMatch = stringSimilarity.findBestMatch(
    question.toLowerCase(),
    questions.map(q => q.toLowerCase())
  );

  if (bestMatch.bestMatch.rating > 0.5) {
    const matchedIndex = bestMatch.bestMatchIndex;
    return faq[matchedIndex].answer;
  }

  return null;
}

// Call DeepSeek API if not in FAQ
async function callDeepSeek(prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn("No DeepSeek API key found, skipping...");
    return null;
  }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("DeepSeek API error:", error);
    return null;
  }
}

// Main chat endpoint
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  if (!userMessage) {
    return res.json({ reply: "No message received." });
  }

  // 1. Try FAQ
  const faqAnswer = checkFAQ(userMessage);
  if (faqAnswer) {
    return res.json({ reply: faqAnswer });
  }

  // 2. Try DeepSeek
  const aiAnswer = await callDeepSeek(userMessage);
  if (aiAnswer) {
    return res.json({ reply: aiAnswer });
  }

  // 3. Default fallback
  res.json({ reply: "Sorry, I cannot answer that right now." });
});

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
