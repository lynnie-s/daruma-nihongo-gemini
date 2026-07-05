// Vercel Serverless Function
// 把使用者錄的語音送給 Gemini,請它逐字轉寫成日文文字(忠實呈現,包括發音錯誤),
// 回傳純文字給前端顯示在輸入框裡,讓使用者確認/修改後再自己送出。
//
// 沿用跟 api/chat.js 一樣的多帳號 + 多模型容錯機制。

function getApiKeys(){
  const multi = process.env.GEMINI_API_KEYS;
  if (multi) {
    return multi.split(',').map(k => k.trim()).filter(Boolean);
  }
  const single = process.env.GEMINI_API_KEY;
  return single ? [single] : [];
}

function getModelChain(){
  const primary = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbacksEnv = process.env.GEMINI_MODEL_FALLBACKS;
  const fallbacks = fallbacksEnv
    ? fallbacksEnv.split(',').map(m => m.trim()).filter(Boolean)
    : ['gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  const chain = [primary, ...fallbacks].filter((m, i, arr) => arr.indexOf(m) === i);
  return chain;
}

const TRANSCRIBE_PROMPT = `この音声を、実際に話されたとおりの日本語テキストとして書き起こしてください。
発音の間違いや言い淀み、文法の誤りがあっても、直さずそのまま忠実に書き起こしてください。
説明・前置き・記号は一切つけず、書き起こしたテキストだけをプレーンテキストで出力してください。
もし音声が日本語として全く聞き取れない場合は、空文字を出力してください。`;

async function callGeminiTranscribe(model, apiKey, audioBase64, mimeType){
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: audioBase64 } },
            { text: TRANSCRIBE_PROMPT }
          ]
        }],
        generationConfig: {
          maxOutputTokens: 300
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

  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    res.status(500).json({ error: { message: 'GEMINI_API_KEY(或 GEMINI_API_KEYS)尚未設定。' } });
    return;
  }

  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) {
    res.status(400).json({ error: { message: 'audioBase64 為必填欄位。' } });
    return;
  }

  const modelChain = getModelChain();
  let lastError = null;

  for (const apiKey of apiKeys) {
    for (const model of modelChain) {
      try {
        const { ok, status, data } = await callGeminiTranscribe(model, apiKey, audioBase64, mimeType || 'audio/webm');

        if (ok) {
          const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                        data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                        data.candidates[0].content.parts[0].text) || '';
          res.status(200).json({ text: text.trim() });
          return;
        }

        lastError = { message: (data.error && data.error.message) || `Gemini API error (${model})`, status };
      } catch (err) {
        lastError = { message: 'Server error: ' + err.message, status: 500 };
      }
    }
  }

  res.status(lastError && lastError.status ? lastError.status : 500).json({
    error: { message: (lastError && lastError.message || 'All models failed') }
  });
}
