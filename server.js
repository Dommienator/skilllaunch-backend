require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();

app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      "http://localhost:3000",
      "https://skilllaunch.co.ke",
      "https://www.skilllaunch.co.ke",
      "https://skilllaunch-psi.vercel.app",
    ];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    if (origin.endsWith(".vercel.app")) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function hashPassword(p) {
  return crypto.createHash("sha256").update(p).digest("hex");
}
function generateAccessCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "SKL-";
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function generateReferralCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "REF";
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      supabase: !!process.env.SUPABASE_URL,
      serviceKey: !!process.env.SUPABASE_SERVICE_KEY,
      adminSecret: !!process.env.ADMIN_SECRET,
    },
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password)
    return res.status(400).json({ error: "Please fill in all fields." });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });

  const key = email.trim().toLowerCase();
  const { data: existing } = await supabase
    .from("users").select("id").eq("email", key).single();
  if (existing)
    return res.status(409).json({ error: "An account with this email already exists." });

  const { data: user, error } = await supabase
    .from("users")
    .insert({ email: key, name: name.trim(), password_hash: hashPassword(password) })
    .select("id, email, name, referral_code, access_code, referred_by")
    .single();

  if (error) {
    console.error("Register error:", error);
    return res.status(500).json({ error: "Registration failed." });
  }
  res.json({ user });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Please enter your email and password." });

  const { data: user } = await supabase
    .from("users")
    .select("id, email, name, referral_code, access_code, referred_by")
    .eq("email", email.trim().toLowerCase())
    .eq("password_hash", hashPassword(password))
    .single();

  if (!user) return res.status(401).json({ error: "Incorrect email or password." });
  res.json({ user });
});

// ── Validate referral code ─────────────────────────────────────────────────
app.post("/api/validate-referral", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "No code provided." });

  const { data: referrer } = await supabase
    .from("users")
    .select("email, access_code, name")
    .eq("referral_code", code.trim().toUpperCase())
    .single();

  if (!referrer)
    return res.status(404).json({ valid: false, error: "Referral code not found." });
  if (!referrer.access_code)
    return res.status(400).json({
      valid: false,
      error: "This referral code belongs to someone who has not yet paid.",
    });

  res.json({ valid: true, referrerName: referrer.name });
});

// ── Payment intent ─────────────────────────────────────────────────────────
app.post("/api/payment/intent", async (req, res) => {
  const { email, phone, personalPhone, referralCodeUsed, amount } = req.body;
  if (!email || !phone)
    return res.status(400).json({ error: "Email and phone number required." });

  const finalAmount = amount || parseInt(process.env.COURSE_PRICE_FULL || "3500");

  const { data: existing } = await supabase
    .from("payments")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  let dbError;
  if (existing) {
    const { error } = await supabase
      .from("payments")
      .update({
        phone: phone.trim(),
        personal_phone: personalPhone || null,
        amount: finalAmount,
        referral_code_used: referralCodeUsed || null,
      })
      .eq("id", existing.id);
    dbError = error;
  } else {
    const { error } = await supabase
      .from("payments")
      .insert({
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        personal_phone: personalPhone || null,
        amount: finalAmount,
        referral_code_used: referralCodeUsed || null,
        status: "pending",
      });
    dbError = error;
  }

  if (dbError) {
    console.error("Payment intent error:", dbError);
    return res.status(500).json({ error: "Could not save payment details." });
  }

  res.json({ ok: true, amount: finalAmount });
});

// ── Activate access code ───────────────────────────────────────────────────
app.post("/api/code/activate", async (req, res) => {
  const { code, email } = req.body;
  if (!code || !email)
    return res.status(400).json({ error: "Code and email are required." });

  const clean = code.trim().toUpperCase();

  const { data: payment } = await supabase
    .from("payments")
    .select("email, status")
    .eq("access_code", clean)
    .single();

  if (!payment)
    return res.status(400).json({ error: "Access code not found. Please check it carefully." });

  if (payment.email !== email.trim().toLowerCase())
    return res.status(403).json({
      error: "This code belongs to a different account. Please use the email you registered with.",
    });

  if (payment.status === "activated")
    return res.status(400).json({
      error: "This code has already been used. Contact us if you think this is wrong.",
    });

  if (payment.status !== "completed")
    return res.status(400).json({
      error: "This code has not been confirmed yet. Please wait or contact us.",
    });

  await supabase
    .from("payments")
    .update({ status: "activated" })
    .eq("access_code", clean);

  await supabase
    .from("users")
    .update({ access_code: clean, access_granted_at: new Date().toISOString() })
    .eq("email", email.trim().toLowerCase());

  res.json({ ok: true });
});

// ── Admin middleware ──────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const s = req.headers["x-admin-secret"];
  if (!s || s !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: "Unauthorized." });
  next();
}

// ── Admin: look up by M-Pesa phone ─────────────────────────────────────────
app.get("/api/admin/lookup-phone/:phone", requireAdmin, async (req, res) => {
  const { phone } = req.params;

  const { data: payment } = await supabase
    .from("payments")
    .select("id, email, phone, personal_phone, amount, referral_code_used, status, mpesa_ref, access_code, created_at")
    .eq("phone", phone.trim())
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!payment)
    return res.status(404).json({
      error: "No record found for this number. The client must have entered it on the payment page first.",
    });

  const { data: user } = await supabase
    .from("users")
    .select("name, referral_code")
    .eq("email", payment.email)
    .single();

  res.json({ ...payment, name: user?.name || null, userReferralCode: user?.referral_code || null });
});

// ── Admin: generate codes ──────────────────────────────────────────────────
app.post("/api/admin/generate-code", requireAdmin, async (req, res) => {
  const { email, mpesaRef, phone } = req.body;
  if (!email)
    return res.status(400).json({ error: "Email is required." });

  const key = email.trim().toLowerCase();

  const { data: user } = await supabase
    .from("users")
    .select("id, email, name, referred_by, referral_code")
    .eq("email", key)
    .single();

  if (!user)
    return res.status(404).json({
      error: `No account found for ${key}. The client must register on the site first.`,
    });

  let accessCode = generateAccessCode();
  for (let i = 0; i < 10; i++) {
    const { data: exists } = await supabase
      .from("payments").select("id").eq("access_code", accessCode).single();
    if (!exists) break;
    accessCode = generateAccessCode();
  }

  let referralCode = user.referral_code;
  if (!referralCode) {
    referralCode = generateReferralCode();
    for (let i = 0; i < 10; i++) {
      const { data: exists } = await supabase
        .from("users").select("id").eq("referral_code", referralCode).single();
      if (!exists) break;
      referralCode = generateReferralCode();
    }
    await supabase.from("users").update({ referral_code: referralCode }).eq("email", key);
  }

  const { data: pendingPayment } = await supabase
    .from("payments")
    .select("id, amount, phone, personal_phone")
    .eq("email", key)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  const amount = pendingPayment?.amount || parseInt(process.env.COURSE_PRICE_FULL || "3500");

  if (pendingPayment) {
    await supabase
      .from("payments")
      .update({
        access_code: accessCode,
        status: "completed",
        mpesa_ref: mpesaRef ? mpesaRef.trim().toUpperCase() : null,
        phone: phone || pendingPayment.phone || null,
      })
      .eq("id", pendingPayment.id);
  } else {
    await supabase.from("payments").insert({
      email: key,
      phone: phone || null,
      mpesa_ref: mpesaRef ? mpesaRef.trim().toUpperCase() : null,
      amount,
      access_code: accessCode,
      status: "completed",
    });
  }

  await supabase
    .from("users")
    .update({ access_code: accessCode, access_granted_at: new Date().toISOString() })
    .eq("email", key);

  if (user.referred_by) {
    const { data: referrer } = await supabase
      .from("users").select("email").eq("referral_code", user.referred_by).single();
    if (referrer) {
      const { data: existingReward } = await supabase
        .from("referral_rewards").select("id").eq("referred_email", key).single();
      if (!existingReward) {
        await supabase.from("referral_rewards").insert({
          referrer_email: referrer.email,
          referred_email: key,
          amount: 500,
          status: "pending",
        });
      }
    }
  }

  res.json({ ok: true, accessCode, referralCode, email: key, name: user.name });
});

// ── Admin: get all customers ───────────────────────────────────────────────
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("id, email, name, referral_code, access_code, referred_by, created_at")
    .order("created_at", { ascending: false });
  res.json(data || []);
});

// ── Admin: get all payments (with user name joined) ───────────────────────
app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  const { data: payments } = await supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false });

  if (!payments || payments.length === 0) return res.json([]);

  const emails = [...new Set(payments.map(p => p.email))];
  const { data: users } = await supabase
    .from("users").select("email, name").in("email", emails);

  const nameMap = {};
  (users || []).forEach(u => { nameMap[u.email] = u.name; });

  const enriched = payments.map(p => ({ ...p, name: nameMap[p.email] || null }));
  res.json(enriched);
});

// ── Admin: get all referral rewards ───────────────────────────────────────
app.get("/api/admin/rewards", requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from("referral_rewards")
    .select("*")
    .order("created_at", { ascending: false });
  res.json(data || []);
});

// ── Admin: mark referral reward as paid ───────────────────────────────────
app.post("/api/admin/rewards/pay", requireAdmin, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "Reward ID required." });
  await supabase
    .from("referral_rewards")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", id);
  res.json({ ok: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nSkillLaunch backend running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health\n`);
});