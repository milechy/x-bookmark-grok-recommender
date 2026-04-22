/**
 * Slack リクエスト署名検証（Web Crypto）。Edge / ブラウザ互換。
 * Node の crypto.createHmac と同じ v0=hex 形式。
 */
export async function verifySlackSignatureWeb(
  signingSecret: string,
  timestamp: string | null,
  slackSignature: string | null,
  rawBody: string
): Promise<boolean> {
  if (!signingSecret || !timestamp || !slackSignature) return false;

  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(baseString));
  const hex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  const mySignature = 'v0=' + hex;

  if (mySignature.length !== slackSignature.length) return false;
  let diff = 0;
  for (let i = 0; i < mySignature.length; i++) {
    diff |= mySignature.charCodeAt(i) ^ slackSignature.charCodeAt(i);
  }
  return diff === 0;
}
