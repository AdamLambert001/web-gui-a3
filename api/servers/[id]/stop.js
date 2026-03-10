export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  const { id } = req.query;
  const baseUrl = process.env.AGENT_BASE_URL;
  const token = process.env.AGENT_TOKEN;

  if (!baseUrl || !token) {
    return res.status(500).json({ ok: false, message: 'Remote not configured' });
  }

  try {
    const resp = await fetch(
      `${baseUrl}/agent/servers/${encodeURIComponent(id)}/stop`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Token': token
        }
      }
    );
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.ok ? 200 : 400).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'Failed to reach agent' });
  }
}

