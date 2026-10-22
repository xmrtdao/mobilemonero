/**
 * relay/lib/agent-email.mjs — one place that actually talks to Resend.
 *
 * The relay already sends email from several places, each with its own copy
 * of the request. This is the shared one: the key comes from the caller's
 * domain registry, so a domain with no key cannot quietly fall through to
 * another account's key.
 *
 * It never throws on a provider refusal. A refused email is information the
 * caller has to be able to report, not an exception that loses the question
 * being asked.
 */
export async function sendMail({ apiKey, from, to, subject, body, html = null, replyTo = null }) {
  if (!apiKey) return { error: 'no API key for this sender', status: 500 };
  if (!to) return { error: 'no recipient', status: 400 };
  if (!subject || !body) return { error: 'subject and body are required', status: 400 };

  const headers = { 'Content-Type': 'application/json' };
  if (replyTo) headers['Reply-To'] = replyTo;

  const apiRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
      ...(html ? { html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) return { error: data, status: apiRes.status };
  return { id: data.id, to, from };
}

export default { sendMail };
