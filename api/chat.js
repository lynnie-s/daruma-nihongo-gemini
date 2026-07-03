// Vercel Serverless Function
// 這支程式跑在伺服器端,負責幫前端安全地呼叫 Google Gemini API。
// API key 只存在這裡(環境變數),不會被瀏覽器看到。
// 前端送過來的格式跟 Claude API 很像({system, messages: [{role, content}]}),
// 這裡負責轉換成 Gemini 需要的格式,再把 Gemini 的回覆轉換回統一格式給前端用。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed, use POST.' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: 'GEMINI_API_KEY 尚未設定。請到 Vercel 專案的 Settings > Environment Variables 加入。' }
    });
    return;
  }

  const { max_tokens, system, messages } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: 'messages 欄位缺失或格式錯誤。' } });
    return;
  }

  const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  // Claude 用 'user'/'assistant',Gemini 用 'user'/'model',這裡做轉換
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system || '' }] },
          contents,
          generationConfig: {
            maxOutputTokens: max_tokens || 1000,
            responseMimeType: 'application/json' // 強制回傳純JSON,不用再自己剝markdown符號
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({
        error: { message: (data.error && data.error.message) || 'Gemini API error' }
      });
      return;
    }

    const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                  data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                  data.candidates[0].content.parts[0].text) || '{}';

    // 轉成跟 Claude API 一樣的格式,前端程式碼完全不用改
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
}
