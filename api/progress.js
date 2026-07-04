// Vercel Serverless Function
// 負責把學生的通關紀錄存進 Supabase,以及讓老師後台讀取全部紀錄。
//
// 環境變數:
// - SUPABASE_URL:你的 Supabase 專案網址(例如 https://xxxx.supabase.co)
// - SUPABASE_SERVICE_KEY:Supabase 專案的 service_role key(在 Supabase 後台 Settings > API 找)
// - ADMIN_PASSWORD:老師後台要輸入的密碼,自己設定一個
//
// POST:學生通關時,前端呼叫這個記錄一筆資料(不需要密碼)
// GET:老師後台讀取全部紀錄(需要在 query string 帶 ?password=xxx)

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: { message: 'SUPABASE_URL 或 SUPABASE_SERVICE_KEY 尚未設定。' } });
    return;
  }

  if (req.method === 'POST') {
    const { studentName, locationKey, lessonKey, lessonTitle, characterId, characterName, score } = req.body || {};

    if (!studentName || !lessonKey) {
      res.status(400).json({ error: { message: 'studentName 和 lessonKey 為必填欄位。' } });
      return;
    }

    try {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify([{
          student_name: studentName,
          location_key: locationKey || '',
          lesson_key: lessonKey,
          lesson_title: lessonTitle || '',
          character_id: characterId || '',
          character_name: characterName || '',
          score: score || 0
        }])
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        res.status(insertRes.status).json({ error: { message: 'Supabase insert error: ' + errText.slice(0, 300) } });
        return;
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: 'Server error: ' + err.message } });
    }
    return;
  }

  if (req.method === 'GET') {
    const password = req.query.password;
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      res.status(401).json({ error: { message: '密碼錯誤。' } });
      return;
    }

    try {
      const listRes = await fetch(
        `${SUPABASE_URL}/rest/v1/progress?select=*&order=cleared_at.desc`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        }
      );

      if (!listRes.ok) {
        const errText = await listRes.text();
        res.status(listRes.status).json({ error: { message: 'Supabase query error: ' + errText.slice(0, 300) } });
        return;
      }

      const data = await listRes.json();
      res.status(200).json({ records: data });
    } catch (err) {
      res.status(500).json({ error: { message: 'Server error: ' + err.message } });
    }
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
