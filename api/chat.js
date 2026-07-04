// Vercel Serverless Function
// 這支程式跑在伺服器端,負責幫前端安全地呼叫 Google Gemini API。
// API key 只存在這裡(環境變數),不會被瀏覽器看到。
// 前端送過來的格式跟 Claude API 很像({system, messages: [{role, content}]}),
// 這裡負責轉換成 Gemini 需要的格式,再把 Gemini 的回覆轉換回統一格式給前端用。
//
// 自動容錯:依序嘗試一份模型清單,若某個模型回傳錯誤(額度用完、模型不存在等),
// 自動改用下一個模型再試一次,直到成功或全部嘗試完畢。
// 可用環境變數 GEMINI_MODEL(主要模型)與 GEMINI_MODEL_FALLBACKS(逗號分隔的備援清單)自訂。

function getModelChain(){
  const primary = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbacksEnv = process.env.GEMINI_MODEL_FALLBACKS;
  const fallbacks = fallbacksEnv
    ? fallbacksEnv.split(',').map(m => m.trim()).filter(Boolean)
    : ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-flash-latest'];
  // 去除重複,主要模型優先
  const chain = [primary, ...fallbacks].filter((m, i, arr) => arr.indexOf(m) === i);
  return chain;
}

async function callGemini(model, apiKey, system, contents, maxOutputTokens){
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
          maxOutputTokens: maxOutputTokens || 3200,
          responseMimeType: 'application/json'
        }
      })
    }
  );
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

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

  // Claude 用 'user'/'assistant',Gemini 用 'user'/'model',這裡做轉換
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const modelChain = getModelChain();
  let lastError = null;

  for (const model of modelChain) {
    try {
      const { ok, status, data } = await callGemini(model, apiKey, system, contents, max_tokens);

      if (ok) {
        const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                      data.candidates[0].content.parts[0].text) || '{}';
        // 轉成跟 Claude API 一樣的格式,前端程式碼完全不用改
        res.status(200).json({ content: [{ type: 'text', text }], model_used: model });
        return;
      }

      // 失敗(額度用完、模型不存在等):記錄下來,換下一個模型繼續試
      lastError = { message: (data.error && data.error.message) || `Gemini API error (${model})`, status };
      console.error(`[daruma] model "${model}" failed (${status}):`, lastError.message);
    } catch (err) {
      lastError = { message: 'Server error: ' + err.message, status: 500 };
      console.error(`[daruma] model "${model}" threw error:`, err.message);
    }
  }

  // 所有模型都失敗了
  res.status(lastError && lastError.status ? lastError.status : 500).json({
    error: { message: (lastError && lastError.message || 'All models failed') + `(嘗試過: ${modelChain.join(', ')})` }
  });
}
