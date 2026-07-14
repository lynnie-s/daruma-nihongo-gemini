// Vercel Serverless Function
// 這支程式跑在伺服器端,負責幫前端安全地呼叫 Google Gemini API。
// API key 只存在這裡(環境變數),不會被瀏覽器看到。
// 前端送過來的格式跟 Claude API 很像({system, messages: [{role, content}]}),
// 這裡負責轉換成 Gemini 需要的格式,再把 Gemini 的回覆轉換回統一格式給前端用。
//
// 自動容錯(雙重):
// 1. 模型容錯:依序嘗試一份模型清單,若某個模型回傳錯誤(額度用完、模型不存在等),自動改用下一個模型。
// 2. 帳號容錯:如果設定了多組 API key(不同 Google 帳號各自的免費額度),
//    一組 key 的額度用完時,自動換下一組 key 繼續嘗試,不需要綁定特定角色。
//
// 為了避免「累積太多次嘗試導致整體執行時間過長、被平台強制中斷連線」的問題,
// 這裡加了兩個保護機制:
// - 每一次嘗試都有獨立的逾時(預設 8 秒),卡住就直接放棄換下一個,不會一直等。
// - 全部嘗試次數有上限(預設 6 次),避免「帳號數 x 模型數」太多導致累加時間過長。
//
// 環境變數:
// - GEMINI_API_KEY:單一 key(舊版相容用法)
// - GEMINI_API_KEYS:多組 key,用逗號分隔(建議改用這個),例如 "key1,key2,key3"
// - GEMINI_MODEL:主要模型(預設 gemini-3.5-flash)
// - GEMINI_MODEL_FALLBACKS:備援模型清單,逗號分隔

// 讓 Vercel 給這個函式多一點執行時間(部分方案可能有上限,超過方案允許值會被忽略)
export const config = {
  maxDuration: 30
};

const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_TOTAL_ATTEMPTS = 6;

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

async function callGemini(model, apiKey, system, contents, maxOutputTokens){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

  try {
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
            maxOutputTokens: maxOutputTokens || 5000,
            responseMimeType: 'application/json'
          }
        }),
        signal: controller.signal
      }
    );
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed, use POST.' } });
    return;
  }

  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    res.status(500).json({
      error: { message: 'GEMINI_API_KEY(或 GEMINI_API_KEYS)尚未設定。請到 Vercel 專案的 Settings > Environment Variables 加入。' }
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
  let attemptsCount = 0;

  outerLoop:
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex++) {
    const apiKey = apiKeys[keyIndex];

    for (const model of modelChain) {
      if (attemptsCount >= MAX_TOTAL_ATTEMPTS) {
        lastError = lastError || { message: '嘗試次數上限已達,提前停止(避免執行時間過長)', status: 504 };
        break outerLoop;
      }
      attemptsCount++;
      try {
        const { ok, status, data } = await callGemini(model, apiKey, system, contents, max_tokens);

        if (ok) {
          const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                        data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                        data.candidates[0].content.parts[0].text) || '{}';
          res.status(200).json({ content: [{ type: 'text', text }], model_used: model, key_index: keyIndex });
          return;
        }

        lastError = { message: (data.error && data.error.message) || `Gemini API error (${model})`, status };
        console.error(`[daruma] key #${keyIndex} model "${model}" failed (${status}):`, lastError.message);
      } catch (err) {
        const isTimeout = err.name === 'AbortError';
        lastError = { message: isTimeout ? `Timeout (${model})` : 'Server error: ' + err.message, status: isTimeout ? 504 : 500 };
        console.error(`[daruma] key #${keyIndex} model "${model}" ${isTimeout ? 'timed out' : 'threw error'}:`, lastError.message);
      }
    }
  }

  res.status(lastError && lastError.status ? lastError.status : 500).json({
    error: {
      message: (lastError && lastError.message || 'All keys/models failed') +
        `(共嘗試 ${attemptsCount} 次)`
    }
  });
}
