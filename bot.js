const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const fetch = require("node-fetch");

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

// Check FAQ first
function checkFAQ(question) {
  if (!faq || faq.length === 0) return null;
  const q = question.toLowerCase();
  const match = faq.find(item => q.includes(item.question.toLowerCase()));
  return match ? match.answer : null;
}

// Call DeepSeek API (text only)
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
    console.log("DeepSeek raw response:", data)
    return data?.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error("DeepSeek API error:", error);
    return null;
  }
}

// Call Gemini API (text + image)
async function callGemini(prompt, imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("No Gemini API key found, skipping...");
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                ...(imageUrl ? [{ inline_data: { mime_type: "image/jpeg", data: imageUrl } }] : [])
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error("Gemini API error:", error);
    return null;
  }
}

// Main chat endpoint
app.post("/chat", async (req, res) => {
  const { message, imageUrl } = req.body;
  if (!message) {
    return res.json({ reply: "No message received." });
  }

  // 1. Try FAQ
  const faqAnswer = checkFAQ(message);
  if (faqAnswer) {
    return res.json({ reply: faqAnswer });
  }

  // 2. If image is provided → Gemini
  if (imageUrl) {
    const visionAnswer = await callGemini(message, imageUrl);
    if (visionAnswer) return res.json({ reply: visionAnswer });
  }

  // 3. Otherwise → DeepSeek
  const aiAnswer = await callDeepSeek(message);
  if (aiAnswer) return res.json({ reply: aiAnswer });

  // 4. Fallback
  res.json({ reply: "Sorry, I cannot answer that right now." });
});

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
