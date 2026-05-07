// MediSmart AI Credits API - Single Vercel serverless function
// Handles all /api/* routes for doctors and super admin.

import { Redis } from "@upstash/redis";
import crypto from "node:crypto";

const redis = Redis.fromEnv();

const HF_MODEL = process.env.HF_MODEL || "ContactDoctor/Bio-Medical-MultiModal-Llama-3-8B-V1";
const HF_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

const PLANS = {
  starter: { label: "Starter AI", monthly_credits: 50, unlimited: false },
  pro: { label: "Pro AI", monthly_credits: 150, unlimited: false },
  premium: { label: "Premium AI", monthly_credits: 500, unlimited: false },
  enterprise: { label: "Enterprise", monthly_credits: 999999, unlimited: true },
};

const DEFAULT_COSTS = {
  chat: 1,
  lab_analysis: 3,
  pdf_analysis: 3,
  ecg_analysis: 5,
  image_analysis: 5,
  multimodal_analysis: 10,
  irm_analysis: 10,
};

// ---------- helpers ----------
function nowIso() { return new Date().toISOString(); }

function nextRenewalDate(from = new Date()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  d.setDate(Math.min(d.getDate(), 28));
  return d.toISOString().slice(0, 10);
}

function ok(res, body, status = 200) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Doctor-Token, X-Admin-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.send(JSON.stringify(body));
}

function err(res, status, message) { ok(res, { error: message }, status); }

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function uuid() { return crypto.randomUUID(); }

async function getAdminToken() {
  let tok = await redis.get("admin:token");
  if (!tok) {
    // Use env var if provided; otherwise generate one and persist
    tok = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");
    await redis.set("admin:token", tok);
  }
  return tok;
}

async function verifyAdmin(req) {
  const expected = await getAdminToken();
  const got = (req.headers["x-admin-token"] || req.headers["authorization"] || "")
    .toString().replace(/^Bearer\s+/i, "").trim();
  return Boolean(got) && got === expected;
}

async function verifyDoctor(req) {
  const token = (req.headers["x-doctor-token"] || "").toString().trim();
  if (!token) return null;
  const doctorId = await redis.get(`doctor:token:${token}`);
  if (!doctorId) return null;
  return await getDoctor(doctorId);
}

// ---------- doctor records ----------
async function getDoctor(doctorId) {
  const data = await redis.get(`doctor:${doctorId}`);
  return data || null;
}

async function saveDoctor(doctor) {
  doctor.updated_at = nowIso();
  await redis.set(`doctor:${doctor.id}`, doctor);
}

async function listDoctorIds() {
  return (await redis.smembers("doctors:index")) || [];
}

async function indexDoctor(doctorId) {
  await redis.sadd("doctors:index", doctorId);
}

async function ensureDoctorDefaults(doctor) {
  if (!doctor.plan_name) doctor.plan_name = "starter";
  const plan = PLANS[doctor.plan_name] || PLANS.starter;
  if (typeof doctor.monthly_credits !== "number") doctor.monthly_credits = plan.monthly_credits;
  if (typeof doctor.used_credits !== "number") doctor.used_credits = 0;
  if (typeof doctor.unlimited !== "boolean") doctor.unlimited = plan.unlimited;
  if (typeof doctor.ai_enabled !== "boolean") doctor.ai_enabled = true;
  if (typeof doctor.active !== "boolean") doctor.active = true;
  if (!doctor.renewal_date) doctor.renewal_date = nextRenewalDate();
  if (!doctor.created_at) doctor.created_at = nowIso();
  // Monthly reset
  if (doctor.renewal_date && doctor.renewal_date <= new Date().toISOString().slice(0, 10)) {
    doctor.used_credits = 0;
    doctor.renewal_date = nextRenewalDate();
  }
  return doctor;
}

function publicDoctorState(doctor) {
  const plan = PLANS[doctor.plan_name] || PLANS.starter;
  const monthly = doctor.monthly_credits || 0;
  const used = doctor.used_credits || 0;
  const unlimited = !!doctor.unlimited;
  const remaining = unlimited ? 999999 : Math.max(0, monthly - used);
  return {
    doctor_id: doctor.id,
    name: doctor.name || "",
    email: doctor.email || "",
    plan_name: doctor.plan_name,
    plan_label: plan.label,
    monthly_credits: monthly,
    used_credits: used,
    remaining_credits: remaining,
    renewal_date: doctor.renewal_date,
    active: !!doctor.active,
    ai_enabled: !!doctor.ai_enabled,
    unlimited,
    has_hf_key: Boolean(doctor.hf_api_key),
  };
}

async function getCreditCosts() {
  const stored = await redis.get("config:credit_costs");
  return { ...DEFAULT_COSTS, ...(stored || {}) };
}

function creditCostFor(costs, action) {
  return costs[action] ?? 1;
}

// ---------- credit logs ----------
async function logCreditAction(doctorId, action, credits, success, cached, details = "") {
  const entry = {
    id: uuid(),
    doctor_id: doctorId,
    action_type: action,
    credits_used: credits,
    success: !!success,
    cached: !!cached,
    details: String(details || "").slice(0, 500),
    created_at: nowIso(),
  };
  await redis.lpush(`logs:${doctorId}`, JSON.stringify(entry));
  await redis.ltrim(`logs:${doctorId}`, 0, 499);
  return entry;
}

async function readLogs(doctorId, limit = 50) {
  const raw = await redis.lrange(`logs:${doctorId}`, 0, limit - 1);
  return (raw || []).map((s) => {
    try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; }
  }).filter(Boolean);
}

// ---------- main router ----------
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return ok(res, {});

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // ---- public ----
    if (path === "/" || path === "/api" || path === "/api/health") {
      return ok(res, { ok: true, service: "medismart-ai-credits", model: HF_MODEL });
    }

    if (path === "/api/plans") {
      return ok(res, { plans: PLANS, credit_costs: await getCreditCosts() });
    }

    // ---- doctor authentication: exchange uuid+secret for session token ----
    if (path === "/api/auth/doctor") {
      if (req.method !== "POST") return err(res, 405, "Method not allowed");
      const { doctor_id, secret } = await readJson(req);
      if (!doctor_id || !secret) return err(res, 400, "doctor_id and secret required");
      const doctor = await getDoctor(doctor_id);
      if (!doctor || !doctor.active) return err(res, 401, "Compte inactif ou inconnu");
      if (doctor.secret !== secret) return err(res, 401, "Identifiants incorrects");
      const token = uuid();
      await redis.set(`doctor:token:${token}`, doctor.id, { ex: 60 * 60 * 24 * 7 }); // 7 days
      return ok(res, { token, doctor: publicDoctorState(doctor) });
    }

    // ---- doctor: their own subscription ----
    if (path === "/api/me/subscription") {
      const doctor = await verifyDoctor(req);
      if (!doctor) return err(res, 401, "Token médecin invalide");
      const fresh = await ensureDoctorDefaults(doctor);
      await saveDoctor(fresh);
      return ok(res, { ...publicDoctorState(fresh), plans: PLANS, credit_costs: await getCreditCosts() });
    }

    if (path === "/api/me/logs") {
      const doctor = await verifyDoctor(req);
      if (!doctor) return err(res, 401, "Token médecin invalide");
      const logs = await readLogs(doctor.id, 100);
      const total_used = logs.reduce((s, l) => s + (l.credits_used || 0), 0);
      const cache_hits = logs.filter((l) => l.cached).length;
      // group daily
      const byDay = {};
      for (const l of logs) {
        const day = (l.created_at || "").slice(0, 10);
        byDay[day] = (byDay[day] || 0) + (l.credits_used || 0);
      }
      const daily = Object.entries(byDay).map(([day, credits]) => ({ day, credits }))
        .sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30);
      return ok(res, { rows: logs.slice(0, 50), total_used, cache_hits, daily });
    }

    // ---- doctor: AI chat (proxies to HF using doctor's stored key) ----
    if (path === "/api/me/ai/chat") {
      if (req.method !== "POST") return err(res, 405, "Method not allowed");
      const doctor = await verifyDoctor(req);
      if (!doctor) return err(res, 401, "Token médecin invalide");
      const fresh = await ensureDoctorDefaults({ ...doctor });
      if (!fresh.active || !fresh.ai_enabled) return err(res, 403, "IA désactivée pour ce compte");
      const costs = await getCreditCosts();
      const body = await readJson(req);
      const action = (body.action_type || "chat").toString();
      const cost = creditCostFor(costs, action);
      const remaining = fresh.unlimited ? 999999 : Math.max(0, (fresh.monthly_credits || 0) - (fresh.used_credits || 0));
      if (!fresh.unlimited && remaining < cost) return err(res, 402, "Crédits IA insuffisants");
      if (!fresh.hf_api_key) return err(res, 409, "Clé HuggingFace non assignée. Contactez l'administrateur.");

      const messages = Array.isArray(body.messages) ? body.messages : [
        { role: "user", content: (body.message || "").toString() },
      ];
      const max_tokens = Math.min(2048, Math.max(64, parseInt(body.max_tokens || 256, 10)));

      let assistantText = "";
      let raw = null;
      try {
        const upstream = await fetch(HF_CHAT_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${fresh.hf_api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: HF_MODEL, messages, max_tokens, temperature: 0.15, stream: false }),
        });
        const text = await upstream.text();
        try { raw = JSON.parse(text); } catch { raw = { text }; }
        if (!upstream.ok) {
          const detail = raw?.error?.message || raw?.detail || raw?.text || `HF ${upstream.status}`;
          await logCreditAction(fresh.id, action, 0, false, false, detail);
          return err(res, 502, `Erreur HuggingFace: ${detail}`);
        }
        assistantText = raw?.choices?.[0]?.message?.content || raw?.generated_text || "";
      } catch (e) {
        await logCreditAction(fresh.id, action, 0, false, false, e.message);
        return err(res, 502, `Erreur HuggingFace: ${e.message}`);
      }

      // Deduct on success
      if (!fresh.unlimited) {
        fresh.used_credits = (fresh.used_credits || 0) + cost;
      }
      await saveDoctor(fresh);
      await logCreditAction(fresh.id, action, fresh.unlimited ? 0 : cost, true, false, "");

      return ok(res, {
        content: assistantText,
        credits_used: fresh.unlimited ? 0 : cost,
        credits_remaining: fresh.unlimited ? 999999 : Math.max(0, fresh.monthly_credits - fresh.used_credits),
        safety_note: "Analyse IA à vérifier par le médecin. Aucun diagnostic ou prescription automatique.",
      });
    }

    // =============================================================
    // SUPER ADMIN ENDPOINTS (require X-Admin-Token)
    // =============================================================
    if (path.startsWith("/api/admin/")) {
      if (!(await verifyAdmin(req))) return err(res, 401, "Token Super Admin invalide");

      // Bootstrap: get current admin token (only first time)
      if (path === "/api/admin/health") {
        return ok(res, { ok: true, doctors: (await listDoctorIds()).length });
      }

      // List all doctors (no patient data)
      if (path === "/api/admin/doctors" && req.method === "GET") {
        const ids = await listDoctorIds();
        const rows = [];
        for (const id of ids) {
          const d = await getDoctor(id);
          if (d) rows.push(publicDoctorState(d));
        }
        return ok(res, { rows, plans: PLANS, credit_costs: await getCreditCosts() });
      }

      // Create doctor
      if (path === "/api/admin/doctors" && req.method === "POST") {
        const body = await readJson(req);
        const id = uuid();
        const secret = body.secret || crypto.randomBytes(12).toString("hex");
        const doctor = await ensureDoctorDefaults({
          id,
          name: (body.name || "Dr").toString(),
          email: (body.email || "").toString(),
          secret,
          hf_api_key: (body.hf_api_key || "").toString(),
          plan_name: (body.plan_name || "starter").toString(),
          ai_enabled: body.ai_enabled !== false,
          active: body.active !== false,
        });
        const plan = PLANS[doctor.plan_name] || PLANS.starter;
        doctor.monthly_credits = plan.monthly_credits;
        doctor.unlimited = plan.unlimited;
        await saveDoctor(doctor);
        await indexDoctor(id);
        return ok(res, { doctor: { ...publicDoctorState(doctor), id, secret } }, 201);
      }

      // Update doctor (plan, hf_key, ai_enabled, credits)
      const updateMatch = path.match(/^\/api\/admin\/doctors\/([a-f0-9-]+)$/);
      if (updateMatch && (req.method === "PUT" || req.method === "PATCH")) {
        const id = updateMatch[1];
        const doctor = await getDoctor(id);
        if (!doctor) return err(res, 404, "Médecin introuvable");
        const body = await readJson(req);
        if (body.name !== undefined) doctor.name = String(body.name);
        if (body.email !== undefined) doctor.email = String(body.email);
        if (body.hf_api_key !== undefined) doctor.hf_api_key = String(body.hf_api_key);
        if (body.ai_enabled !== undefined) doctor.ai_enabled = !!body.ai_enabled;
        if (body.active !== undefined) doctor.active = !!body.active;
        if (body.plan_name && PLANS[body.plan_name]) {
          const plan = PLANS[body.plan_name];
          doctor.plan_name = body.plan_name;
          doctor.monthly_credits = plan.monthly_credits;
          doctor.unlimited = plan.unlimited;
        }
        if (typeof body.add_credits === "number") {
          doctor.used_credits = Math.max(0, (doctor.used_credits || 0) - body.add_credits);
        }
        if (typeof body.set_used_credits === "number") {
          doctor.used_credits = Math.max(0, body.set_used_credits);
        }
        if (body.reset_monthly === true) {
          doctor.used_credits = 0;
          doctor.renewal_date = nextRenewalDate();
        }
        await saveDoctor(doctor);
        return ok(res, { doctor: publicDoctorState(doctor) });
      }

      // Delete doctor
      if (updateMatch && req.method === "DELETE") {
        const id = updateMatch[1];
        await redis.del(`doctor:${id}`);
        await redis.srem("doctors:index", id);
        await redis.del(`logs:${id}`);
        return ok(res, { ok: true });
      }

      // Logs for one doctor
      const logsMatch = path.match(/^\/api\/admin\/doctors\/([a-f0-9-]+)\/logs$/);
      if (logsMatch) {
        const logs = await readLogs(logsMatch[1], 200);
        return ok(res, { rows: logs });
      }

      // Update credit costs config
      if (path === "/api/admin/credit-costs" && req.method === "PUT") {
        const body = await readJson(req);
        const safe = {};
        for (const k of Object.keys(DEFAULT_COSTS)) {
          if (typeof body[k] === "number") safe[k] = Math.max(0, parseInt(body[k], 10));
        }
        await redis.set("config:credit_costs", safe);
        return ok(res, { credit_costs: { ...DEFAULT_COSTS, ...safe } });
      }

      return err(res, 404, "Route admin inconnue");
    }

    return err(res, 404, "Route inconnue");
  } catch (e) {
    return err(res, 500, e.message || "Erreur serveur");
  }
}
