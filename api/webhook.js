// api/webhook.js — Tutto il Mundo Stripe Webhook
// Vercel serverless function
// Requiere: STRIPE_WEBHOOK_SECRET en Vercel Environment Variables

// Lee el body crudo (necesario para verificar firma de Stripe)
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const config = {
  api: { bodyParser: false } // Vercel: no parsear body, Stripe necesita el raw
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Verificar que el aviso realmente viene de Stripe (no de alguien imitando a Stripe)
  let event;
  try {
    // Verificación manual de firma HMAC-SHA256 (sin importar el SDK de Stripe)
    const crypto = await import('crypto');
    const [, timestampPart, , signaturePart] = sig.match(/t=(\d+),.*?v1=([a-f0-9]+)/) || [];
    if (!timestampPart || !signaturePart) throw new Error('Invalid signature format');

    const signedPayload = `${timestampPart}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', webhookSecret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    if (expected !== signaturePart) throw new Error('Signature mismatch');

    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // ── Manejar eventos ────────────────────────────────────────────────────
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const amountMXN = (pi.amount / 100).toLocaleString('es-MX', { minimumFractionDigits: 0 });
    const customerEmail = pi.receipt_email || pi.metadata?.email || 'no proporcionado';
    const paymentType = (pi.payment_method_types || []).join(', ') || 'tarjeta';
    const isOXXO = (pi.payment_method_types || []).includes('oxxo');

    console.log(`✅ Pago confirmado: $${amountMXN} MXN via ${paymentType} | cliente: ${customerEmail} | id: ${pi.id}`);

    // Notificar via Formspree (misma integración que ya usa el sitio)
    try {
      await fetch('https://formspree.io/f/xqewgqjg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          _subject: `${isOXXO ? '🏪 OXXO' : '💳 Tarjeta'} · Pago confirmado $${amountMXN} MXN — Tutto il Mundo`,
          metodo: paymentType.toUpperCase(),
          monto: `$${amountMXN} MXN`,
          email_cliente: customerEmail,
          id_pago: pi.id,
          nota: isOXXO
            ? `El cliente pagó en OXXO. Ya puedes contactarle para empezar a planear su viaje.`
            : `Pago con tarjeta confirmado. Ya puedes contactarle.`
        })
      });
    } catch (notifyErr) {
      // No tiramos error — el pago ya está confirmado, solo falló la notificación
      console.error('Error enviando notificación:', notifyErr.message);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    // Voucher OXXO expirado o pago fallido — solo log, no hay acción necesaria
    console.log(`❌ Pago fallido/expirado: ${pi.id}`);
  }

  // Stripe requiere respuesta 200 rápida para confirmar que recibiste el evento
  res.status(200).json({ received: true });
}
