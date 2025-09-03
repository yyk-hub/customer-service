// bot.js - Customer Service Bot

const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// Load FAQ knowledge base
let kb = [];
try {
  kb = JSON.parse(fs.readFileSync("knowledge.json", "utf8"));
} catch (err) {
  console.log("Could not load knowledge.json:", err);
}

// Helper function: check KB
function checkKB(question) {
  const q = question.toLowerCase();
  for (let item of kb) {
    if (item.q.toLowerCase().includes(q)) {
      return item.a;
    }
  }
  return null;
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  const userMsg = req.body.message || "";
  if (!userMsg) return res.json({ reply: "No message received." });

  // 1️⃣ Check KB first
  let answer = checkKB(userMsg);
  if (answer) return res.json({ reply: answer });

  // 2️⃣ If not in KB, call DeepSeek API
  try {
    const response = await axios.post(
      "https://api.openrouter.ai/v1/chat/completions",
      {
        model: "r1",
        messages: [{ role: "user", content: userMsg }],
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    answer = response.data.choices[0].message.content;
    res.json({ reply: answer });
  } catch (err) {
    console.log("DeepSeek API error:", err.message);
    res.json({ reply: "Sorry, I cannot answer that right now." });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
