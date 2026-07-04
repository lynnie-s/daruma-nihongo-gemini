// Vercel Serverless Function
// 呼叫 ElevenLabs 的 Text-to-Speech API,把文字轉成客製化的聲音(可以是克隆過的個性化聲音)。
// API key 只存在這裡(環境變數),不會被瀏覽器看到。
//
// 環境變數:
// - ELEVENLABS_API_KEY:你在 elevenlabs.io 申請的 API key
//
// 前端會傳入 { text, voiceId },這裡回傳合成好的 mp3 音檔(binary)。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed, use POST.' } });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: 'ELEVENLABS_API_KEY 尚未設定。請到 Vercel 專案的 Settings > Environment Variables 加入。' }
    });
    return;
  }

  const { text, voiceId } = req.body || {};
  if (!text || !voiceId) {
    res.status(400).json({ error: { message: 'text 和 voiceId 都是必填欄位。' } });
    return;
  }

  try {
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2', // 支援日文
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      res.status(elevenRes.status).json({ error: { message: 'ElevenLabs API error: ' + errText.slice(0, 300) } });
      return;
    }

    const audioBuffer = await elevenRes.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.status(200).send(Buffer.from(audioBuffer));
  } catch (err) {
    res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
}
