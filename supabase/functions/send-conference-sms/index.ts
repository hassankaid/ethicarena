// ─────────────────────────────────────────────────────────────────────────
// Envoi de la séquence SMS d'une conférence, via Twilio.
//
// Appel : POST { seq: 6 | 7, conference_date?: "YYYY-MM-DD", dry_run?: true }
//   seq 6 = M-10  (juste avant l ouverture)
//   seq 7 = M+15  (rattrapage, la conference est en cours)
//
// RIEN N'EST ÉCRIT EN DUR POUR UNE SEMAINE DONNÉE. La fonction résout la fiche
// de la conférence dans `conferences`, et en tire l'heure annoncée dans les
// messages ainsi que le slug de campagne (conf_AAAA_MM_JJ_sms), donc la liste
// et la déduplication. Le lien du groupe, lui, n'apparaît jamais ici : le SMS
// porte un lien court personnel que `r-sms` redirige — c'est lui qui lit la
// fiche pour savoir vers quel groupe envoyer.
//
// ⚠️ PAS DE PARAMÈTRE `max`. La fonction envoie à TOUS les numéros de la liste
// qui n'ont pas déjà reçu cette séquence, dans la limite de MAX_PER_CALL.
// Le 30/08/2026, un test lancé après le chargement de la liste a fait partir la
// séquence entière trente minutes trop tôt : `dry_run` existe pour ça.
//
// ⚠️ TOUJOURS FAIRE UN `dry_run` D'ABORD. Il renvoie la fiche résolue, le slug,
// le corps exact du message et le nombre de destinataires restants, sans rien
// envoyer.
//
// Les corps de messages sont volontairement SANS ACCENT : un seul caractère
// accentué bascule le SMS en UCS-2 et fait tomber la limite de 160 à 70
// caractères par segment, ce qui double la facture. Ils sont aussi calibrés
// pour tenir en UN segment ; le lien court en consomme 54 à lui seul.
//
// Pas d'en-tête « AL BARAKA - {{FIRST_NAME}} » : l'expéditeur alphanumérique
// affiche déjà « Al Baraka » sur le téléphone.
// ─────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const FROM_ID = "Al Baraka";
const HEURE_DEFAUT = "11h00";

// 250 et non 500 : au-delà, l'appel dépasse le temps d'exécution de la fonction.
// En mai, un lot de 501 a coupé en cours de route et 384 lignes ont dû être
// reconstituées depuis les rappels Twilio.
const MAX_PER_CALL = 250;
const DELAY_MS = 100;
// Le journal est écrit par tranches de 50 : si l'appel s'interrompt, la reprise
// repart d'où il en était au lieu de tout renvoyer.
const LOG_CHUNK = 50;

const STATUS_CALLBACK = "https://ktvszjzryabjgxyobtyc.supabase.co/functions/v1/twilio-webhook";
const SHORT_BASE = "https://plateforme.albarakaecosysteme.com/s";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Date du jour en heure de Paris, "AAAA-MM-JJ". `toISOString()` donnerait la
 *  date UTC, décalée d'un jour entre minuit et 2h du matin l'été. */
function aujourdhuiParis(): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

/** "11:00:00" → "11h00". */
function formatHeure(h: string | null): string {
  if (!h) return HEURE_DEFAUT;
  const [hh, mm] = h.split(":");
  return `${hh}h${mm}`;
}

/** "2026-08-30" → "conf_2026_08_30_sms". */
function slugDe(date: string): string {
  return `conf_${date.replaceAll("-", "_")}_sms`;
}

interface Fiche {
  conference_date: string;
  heure: string;
  campaign_slug: string;
}

async function resoudreFiche(supabase: any, demande?: string): Promise<Fiche | null> {
  let q = supabase.from("conferences").select("conference_date, starts_at_local");

  if (demande) {
    q = q.eq("conference_date", demande);
  } else {
    // Pas de bascule à l'heure de la conférence ici : une reprise en fin de
    // matinée doit continuer à viser la conférence du jour.
    q = q.gte("conference_date", aujourdhuiParis())
         .order("conference_date", { ascending: true });
  }

  const { data } = await q.limit(1);
  const row = (data ?? [])[0];
  if (!row) return null;

  return {
    conference_date: row.conference_date,
    heure: formatHeure(row.starts_at_local),
    campaign_slug: slugDe(row.conference_date),
  };
}

interface Gabarit { name: string; body: string }

function gabarits(f: Fiche): Record<number, Gabarit> {
  return {
    // SEQUENCE : un rappel juste avant, un rattrapage juste apres.
    //
    // Le T-2h a ete retire le 06/09/2026 : deux heures avant, le destinataire
    // range le lien et l'oublie. Le seq 4 reste VACANT plutot que d'etre
    // reattribue — les envois de fin aout portent ce numero dans
    // `sms_campaign_sends`, et le reutiliser rendrait l'historique illisible.
    6: {
      name: "Ouverture",
      body: `On commence dans 10 min.

Rejoins le groupe maintenant, le lien du direct y est :
{{LINK}}`,
    },
    7: {
      name: "Rattrapage +15min",
      body: `C'est en cours depuis 15 min, on t'attend.

Le lien du direct est dans le groupe :
{{LINK}}`,
    },
  };
}

async function getTwilioCreds(supabase: any) {
  const { data } = await supabase.from("app_settings").select("key, value").in("key", ["twilio_account_sid", "twilio_auth_token"]);
  const sid = (data ?? []).find((r: any) => r.key === "twilio_account_sid")?.value;
  const token = (data ?? []).find((r: any) => r.key === "twilio_auth_token")?.value;
  if (!sid || !token) throw new Error("twilio_creds_missing");
  return { sid, token };
}

async function twilioSendSms(sid: string, token: string, b: { to: string; from: string; body: string; statusCallback?: string }) {
  const auth = btoa(`${sid}:${token}`);
  const params = new URLSearchParams();
  params.append("To", b.to);
  params.append("From", b.from);
  params.append("Body", b.body);
  if (b.statusCallback) params.append("StatusCallback", b.statusCallback);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function render(t: string, vars: Record<string, string>) {
  let o = t;
  for (const [k, v] of Object.entries(vars)) o = o.replaceAll(`{{${k}}}`, v ?? "");
  return o;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }); }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const fiche = await resoudreFiche(supabase, body?.conference_date);
  if (!fiche) {
    return new Response(JSON.stringify({ error: "conference_introuvable", demande: body?.conference_date ?? null }), { status: 404 });
  }

  const seq = parseInt(body?.seq);
  const TEMPLATES = gabarits(fiche);
  const tpl = TEMPLATES[seq];
  if (!tpl) {
    return new Response(JSON.stringify({ error: "seq_inconnu", attendus: Object.keys(TEMPLATES) }), { status: 400 });
  }

  const { data: alreadySent } = await supabase
    .from("sms_campaign_sends").select("recipient_phone")
    .eq("campaign_slug", fiche.campaign_slug).eq("sms_seq", seq);
  const sentSet = new Set((alreadySent ?? []).map((r: any) => r.recipient_phone));

  const { data: recipients } = await supabase
    .from("sms_campaign_recipients")
    .select("phone, first_name, position, unsubscribe_token")
    .eq("campaign_slug", fiche.campaign_slug)
    .order("position", { ascending: true });

  const { data: unsubs } = await supabase.from("sms_unsubscribes").select("phone");
  const unsubSet = new Set((unsubs ?? []).map((r: any) => r.phone));

  const restants = (recipients ?? []).filter((r: any) => !sentSet.has(r.phone) && !unsubSet.has(r.phone));
  const todo = restants.slice(0, MAX_PER_CALL);

  // Ce que la fonction ferait, sans le faire. À appeler avant tout envoi réel.
  if (body?.dry_run === true) {
    const exemple = todo[0]
      ? render(tpl.body, { FIRST_NAME: todo[0].first_name || "", LINK: `${SHORT_BASE}/${todo[0].unsubscribe_token}/${seq}` })
      : null;
    return new Response(JSON.stringify({
      dry_run: true,
      seq,
      template_name: tpl.name,
      conference_date: fiche.conference_date,
      heure: fiche.heure,
      campaign_slug: fiche.campaign_slug,
      liste_totale: (recipients ?? []).length,
      deja_envoyes: sentSet.size,
      partiraient_maintenant: todo.length,
      resteraient_apres: Math.max(0, restants.length - todo.length),
      exemple_de_message: exemple,
      caracteres: exemple ? exemple.length : null,
      segments_estimes: exemple ? (exemple.length <= 160 ? 1 : Math.ceil(exemple.length / 153)) : null,
    }), { status: 200 });
  }

  if (todo.length === 0) {
    return new Response(JSON.stringify({ ok: true, seq, message: "all_sent", conference_date: fiche.conference_date, campaign_slug: fiche.campaign_slug, already_sent: sentSet.size }), { status: 200 });
  }

  let creds: { sid: string; token: string };
  try { creds = await getTwilioCreds(supabase); } catch (e: any) { return new Response(JSON.stringify({ error: "twilio_creds_error", message: e?.message }), { status: 500 }); }

  let logs: any[] = [];
  let okCount = 0, failCount = 0;

  const flush = async () => {
    if (logs.length === 0) return;
    const chunk = logs;
    logs = [];
    await supabase.from("sms_campaign_sends").insert(chunk);
  };

  for (const r of todo) {
    const link = `${SHORT_BASE}/${r.unsubscribe_token}/${seq}`;
    const messageBody = render(tpl.body, { FIRST_NAME: r.first_name || "", LINK: link });

    let attempt = 0;
    let lastResp: any = null;
    while (attempt < 3) {
      lastResp = await twilioSendSms(creds.sid, creds.token, {
        to: r.phone, from: FROM_ID, body: messageBody, statusCallback: STATUS_CALLBACK,
      });
      if ((lastResp.status >= 200 && lastResp.status < 300) || lastResp.status !== 429) break;
      attempt++; await sleep(500 * attempt);
    }

    const ok = lastResp.status >= 200 && lastResp.status < 300;
    if (ok) okCount++; else failCount++;

    logs.push({
      campaign_slug: fiche.campaign_slug, sms_seq: seq,
      recipient_phone: r.phone, recipient_first_name: r.first_name,
      twilio_message_sid: ok ? lastResp.data?.sid : null,
      body: messageBody,
      num_segments: ok ? parseInt(lastResp.data?.num_segments) : null,
      price_usd: null,
      status: ok ? "sent" : "failed",
      error_message: ok ? null : (lastResp.data?.message || JSON.stringify(lastResp.data)),
    });

    if (logs.length >= LOG_CHUNK) await flush();

    await sleep(DELAY_MS);
  }

  await flush();

  return new Response(JSON.stringify({
    ok: true, seq, processed: todo.length, sent: okCount, failed: failCount,
    template_name: tpl.name,
    conference_date: fiche.conference_date, campaign_slug: fiche.campaign_slug,
    already_sent_before: sentSet.size,
    restants_apres_appel: Math.max(0, restants.length - todo.length),
  }), { status: 200 });
});
