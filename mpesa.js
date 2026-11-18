// mpesa.js — M-Pesa Daraja (STK Push) for SkillLaunch
// Mounted from server.js:  require("./mpesa")(app, { supabase, grantAccess });
//
// Uses Node's built-in fetch (Node 18+), so no new npm packages are needed.

const crypto = require("crypto");

const USER_FIELDS = "id, email, name, referral_code, access_code, referred_by";

// 0712345678 / 712345678 / +254712345678 / 254712345678  ->  254712345678
function toMsisdn(raw) {
  let p = String(raw || "").replace(/[\s\-()+]/g, "");
  if (/^0[17]\d{8}$/.test(p)) p = "254" + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = "254" + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

// Daraja timestamp, YYYYMMDDHHmmss, in Nairobi time (UTC+3)
function timestamp() {
  return new Date(Date.now() + 3 * 3600 * 1000)
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
}

module.exports = function registerMpesa(app, { supabase, grantAccess }) {
  // ── Config ───────────────────────────────────────────────────────────────
  const cfg = () => ({
    env: process.env.MPESA_ENV === "production" ? "production" : "sandbox",
    key: process.env.MPESA_CONSUMER_KEY,
    secret: process.env.MPESA_CONSUMER_SECRET,
    passkey: process.env.MPESA_PASSKEY,
    shortcode: process.env.MPESA_SHORTCODE, // BusinessShortCode (Store/Head Office no. for Buy Goods)
    partyB: process.env.MPESA_PARTY_B || process.env.MPESA_SHORTCODE, // the Till (Buy Goods) or Paybill
    txType: process.env.MPESA_TRANSACTION_TYPE || "CustomerBuyGoodsOnline",
    callbackBase: (process.env.MPESA_CALLBACK_BASE || "").replace(/\/+$/, ""),
    callbackToken: process.env.MPESA_CALLBACK_TOKEN,
    autoUnlock: process.env.MPESA_AUTO_UNLOCK === "true",
    amountOverride: parseInt(process.env.MPESA_AMOUNT_OVERRIDE || "0", 10) || 0,
    priceFull: parseInt(process.env.COURSE_PRICE_FULL || "3500", 10),
    priceReferred: parseInt(process.env.COURSE_PRICE_REFERRED || "3000", 10),
  });

  const baseUrl = (c) =>
    c.env === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

  const configured = (c) =>
    !!(
      c.key &&
      c.secret &&
      c.passkey &&
      c.shortcode &&
      c.callbackBase &&
      c.callbackToken
    );

  // ── Helpers ──────────────────────────────────────────────────────────────
  async function timedFetch(url, opts, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  let tokenCache = { value: null, exp: 0, env: null };
  async function getAccessToken(c) {
    if (
      tokenCache.value &&
      tokenCache.env === c.env &&
      Date.now() < tokenCache.exp
    )
      return tokenCache.value;
    const auth = Buffer.from(`${c.key}:${c.secret}`).toString("base64");
    const r = await timedFetch(
      `${baseUrl(c)}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token)
      throw new Error("Daraja auth failed: " + (d.errorMessage || r.status));
    tokenCache = {
      value: d.access_token,
      exp: Date.now() + (parseInt(d.expires_in || "3599", 10) - 60) * 1000,
      env: c.env,
    };
    return d.access_token;
  }

  // The server decides the price. The browser is never trusted for the amount.
  async function priceFor(c, email, referralCode) {
    if (!referralCode) return { amount: c.priceFull, referralCodeUsed: null };
    const code = String(referralCode).trim().toUpperCase();
    const { data: referrer } = await supabase
      .from("users")
      .select("email, access_code")
      .eq("referral_code", code)
      .single();
    if (!referrer || !referrer.access_code || referrer.email === email)
      return { error: "Referral code is not valid." };
    return { amount: c.priceReferred, referralCodeUsed: code };
  }

  // ── POST /api/mpesa/stkpush ──────────────────────────────────────────────
  app.post("/api/mpesa/stkpush", async (req, res) => {
    const c = cfg();
    if (!configured(c))
      return res.status(503).json({
        error:
          "Instant M-Pesa payment is not available right now. Please pay manually.",
      });

    const { email, phone, personalPhone, referralCode } = req.body || {};
    if (!email || !phone)
      return res
        .status(400)
        .json({ error: "Email and M-Pesa number are required." });

    const key = String(email).trim().toLowerCase();
    const msisdn = toMsisdn(phone);
    if (!msisdn)
      return res
        .status(400)
        .json({ error: "Enter a valid Safaricom number, e.g. 0712345678." });

    const { data: user } = await supabase
      .from("users")
      .select("id, access_code")
      .eq("email", key)
      .single();
    if (!user)
      return res
        .status(404)
        .json({ error: "Account not found. Please sign in again." });
    if (user.access_code)
      return res
        .status(409)
        .json({ error: "This account already has full access." });

    // Block double payment while a paid payment is waiting for the admin
    const { data: alreadyPaid } = await supabase
      .from("payments")
      .select("id")
      .eq("email", key)
      .eq("status", "paid")
      .limit(1);
    if (alreadyPaid && alreadyPaid.length)
      return res.status(409).json({
        error:
          "We have already received your payment. Your access code is on its way.",
      });

    const price = await priceFor(c, key, referralCode);
    if (price.error) return res.status(400).json({ error: price.error });
    const amount = c.amountOverride || price.amount;

    // Send the STK Push
    let d;
    try {
      const token = await getAccessToken(c);
      const ts = timestamp();
      const r = await timedFetch(
        `${baseUrl(c)}/mpesa/stkpush/v1/processrequest`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            BusinessShortCode: c.shortcode,
            Password: Buffer.from(c.shortcode + c.passkey + ts).toString(
              "base64",
            ),
            Timestamp: ts,
            TransactionType: c.txType,
            Amount: amount,
            PartyA: msisdn,
            PartyB: c.partyB,
            PhoneNumber: msisdn,
            CallBackURL: `${c.callbackBase}/api/mpesa/callback/${c.callbackToken}`,
            AccountReference: "SkillLaunch",
            TransactionDesc: "SkillLaunch course",
          }),
        },
      );
      d = await r.json().catch(() => ({}));
      if (!r.ok || d.ResponseCode !== "0") {
        console.error("STK push rejected:", r.status, JSON.stringify(d));
        return res.status(502).json({
          error:
            "M-Pesa could not send the payment prompt. Please try again or pay manually.",
        });
      }
    } catch (err) {
      console.error("STK push error:", err.message);
      return res.status(502).json({
        error: "Could not reach M-Pesa. Please try again or pay manually.",
      });
    }

    // Record it (the admin panel reads this table)
    const row = {
      phone: String(phone).trim(),
      personal_phone: personalPhone || null,
      amount,
      referral_code_used: price.referralCodeUsed,
      checkout_request_id: d.CheckoutRequestID,
      merchant_request_id: d.MerchantRequestID,
      result_desc: null,
    };
    const { data: pending } = await supabase
      .from("payments")
      .select("id")
      .eq("email", key)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const { error: dbErr } = pending
      ? await supabase.from("payments").update(row).eq("id", pending.id)
      : await supabase
          .from("payments")
          .insert({ ...row, email: key, status: "pending" });
    if (dbErr) console.error("STK payment save error:", dbErr);

    res.json({ ok: true, checkoutRequestId: d.CheckoutRequestID, amount });
  });

  // ── POST /api/mpesa/callback/:token  (called by Safaricom) ───────────────
  app.post("/api/mpesa/callback/:token", async (req, res) => {
    const ack = () => res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    const c = cfg();

    // Safaricom does not sign callbacks, so the URL itself carries a secret
    const a = Buffer.from(String(req.params.token || ""));
    const b = Buffer.from(String(c.callbackToken || ""));
    if (
      !c.callbackToken ||
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    )
      return res.status(403).json({ error: "Forbidden" });

    try {
      const cb = req.body && req.body.Body && req.body.Body.stkCallback;
      if (!cb || !cb.CheckoutRequestID) return ack();

      const find = () =>
        supabase
          .from("payments")
          .select("id, email, phone, amount, status")
          .eq("checkout_request_id", cb.CheckoutRequestID)
          .single();

      let { data: payment } = await find();
      if (!payment) {
        // the callback can beat our own database write by a moment
        await new Promise((r) => setTimeout(r, 1500));
        ({ data: payment } = await find());
      }
      if (!payment) {
        console.error(
          "Callback for unknown CheckoutRequestID:",
          cb.CheckoutRequestID,
        );
        return ack();
      }
      // Safaricom can send the same callback twice
      if (payment.status !== "pending") return ack();

      if (Number(cb.ResultCode) !== 0) {
        await supabase
          .from("payments")
          .update({
            status: "failed",
            result_desc: String(cb.ResultDesc || "Payment not completed").slice(
              0,
              200,
            ),
          })
          .eq("id", payment.id);
        return ack();
      }

      const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
      const meta = {};
      items.forEach((i) => {
        meta[i.Name] = i.Value;
      });

      if (Number(meta.Amount) < Number(payment.amount)) {
        await supabase
          .from("payments")
          .update({
            status: "failed",
            mpesa_ref: meta.MpesaReceiptNumber || null,
            result_desc: `Amount mismatch: expected ${payment.amount}, received ${meta.Amount}`,
          })
          .eq("id", payment.id);
        return ack();
      }

      await supabase
        .from("payments")
        .update({
          status: "paid",
          mpesa_ref: meta.MpesaReceiptNumber
            ? String(meta.MpesaReceiptNumber).toUpperCase()
            : null,
          payer_phone: meta.PhoneNumber ? String(meta.PhoneNumber) : null,
          result_desc: "Paid via STK Push",
          paid_at: new Date().toISOString(),
        })
        .eq("id", payment.id);

      if (c.autoUnlock) {
        const g = await grantAccess(payment.email, {
          mpesaRef: meta.MpesaReceiptNumber,
          phone: payment.phone,
        });
        if (g.error) console.error("Auto-unlock failed:", g.error);
      }
    } catch (err) {
      console.error("Callback handler error:", err);
    }
    return ack();
  });

  // ── GET /api/mpesa/status/:checkoutRequestId?email=... (frontend polling) ─
  app.get("/api/mpesa/status/:id", async (req, res) => {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { data: p } = await supabase
      .from("payments")
      .select("email, status, result_desc, mpesa_ref")
      .eq("checkout_request_id", req.params.id)
      .single();
    if (!p || p.email !== email)
      return res.status(404).json({ error: "Not found." });

    let user = null;
    if (p.status === "completed" || p.status === "activated") {
      const r = await supabase
        .from("users")
        .select(USER_FIELDS)
        .eq("email", email)
        .single();
      user = r.data || null;
    }
    res.json({
      status: p.status,
      resultDesc: p.result_desc,
      mpesaRef: p.mpesa_ref,
      user,
    });
  });
};

module.exports.toMsisdn = toMsisdn;
module.exports.timestamp = timestamp;
