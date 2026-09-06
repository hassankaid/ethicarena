// ─────────────────────────────────────────────────────────────────────────
// Envoi de la séquence e-mail d'une conférence, via Resend.
//
// Appel : POST { seq: 4 | 5 | 8 | 9, max?: 1..300, conference_date?: "YYYY-MM-DD",
//                dry_run?: true }
//
// RIEN N'EST ÉCRIT EN DUR POUR UNE SEMAINE DONNÉE. La fonction résout la fiche
// de la conférence dans `conferences`, et en tire :
//   • le lien du groupe WhatsApp du bouton,
//   • l'heure annoncée dans les messages,
//   • le slug de campagne (conf_AAAA_MM_JJ), donc la liste et la déduplication.
// Sans `conference_date`, elle prend la prochaine conférence à partir
// d'aujourd'hui — celle du jour même le dimanche, toute la journée.
//
// ⚠️ TOUJOURS FAIRE UN `dry_run` D'ABORD. Il renvoie la fiche résolue, le slug,
// le groupe et le nombre de destinataires restants, sans rien envoyer. C'est le
// seul moyen de vérifier qu'on vise la bonne semaine avant de tirer.
//
// ⚠️ UN SEUL APPEL À LA FOIS. Le journal n'est écrit que tous les 50 envois :
// relancer pendant qu'un appel tourne fait redémarrer la déduplication sur un
// journal incomplet et renvoie aux mêmes personnes. C'est ce qui a produit
// 353 doublons sur la conférence du 31/05/2026.
// ─────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const FROM_ADDR = "Sidali · AL BARAKA <conference@albarakaecosysteme.com>";
const REPLY_TO = ["contact@albarakaecosysteme.com"];

// Filets, utilisés seulement si la fiche est incomplète. Un e-mail sans bouton
// vaut moins qu'un e-mail dont le bouton mène au groupe de la semaine passée,
// mais les deux valent mieux qu'un envoi qui échoue.
const WHATSAPP_DEFAUT = "https://chat.whatsapp.com/BwBWVsHhM0Y0Fb37USMZS3";
const HEURE_DEFAUT = "11h00";

// Le lien de désabonnement doit rester joignable : la route /unsubscribe
// n'existe pas dans l'application, et en mai 8 personnes ont cliqué dans le
// vide avant que 11 plaintes pour spam ne tombent. Un mailto ne dépend d'aucun
// déploiement.
const UNSUB = "mailto:contact@albarakaecosysteme.com?subject=Desabonnement";

const DEFAULT_MAX = 150;
const DELAY_MS = 230;

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

/** "2026-08-30" → "conf_2026_08_30". */
function slugDe(date: string): string {
  return `conf_${date.replaceAll("-", "_")}`;
}

interface Fiche {
  conference_date: string;
  whatsapp: string;
  zoom: string;
  heure: string;
  campaign_slug: string;
  groupe_renseigne: boolean;
  zoom_renseigne: boolean;
}

async function resoudreFiche(supabase: any, demande?: string): Promise<Fiche | null> {
  let q = supabase
    .from("conferences")
    .select("conference_date, whatsapp_group_url, zoom_url, starts_at_local");

  if (demande) {
    q = q.eq("conference_date", demande);
  } else {
    // Pas de bascule à l'heure de la conférence ici : un envoi ou une reprise
    // en fin de matinée doit continuer à viser la conférence du jour, pas celle
    // de la semaine suivante.
    q = q.gte("conference_date", aujourdhuiParis())
         .order("conference_date", { ascending: true });
  }

  const { data } = await q.limit(1);
  const row = (data ?? [])[0];
  if (!row) return null;

  return {
    conference_date: row.conference_date,
    whatsapp: row.whatsapp_group_url || WHATSAPP_DEFAUT,
    zoom: row.zoom_url || ZOOM_DEFAUT,
    heure: formatHeure(row.starts_at_local),
    campaign_slug: slugDe(row.conference_date),
    zoom_renseigne: Boolean(row.zoom_url),
    groupe_renseigne: !!row.whatsapp_group_url,
  };
}

function wrap(preheader: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AL BARAKA</title></head>
<body style="margin:0;padding:0;background-color:#f5f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;">
<div style="display:none;font-size:1px;color:#f5f3ee;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f5f3ee;padding:24px 0;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background-color:#ffffff;border-radius:8px;padding:32px 28px;">
<tr><td style="font-size:15px;color:#1a1a1a;">
${body}
<div style="margin-top:40px;padding-top:24px;border-top:1px solid #e5e1d7;font-size:12px;color:#7a7a7a;text-align:center;line-height:1.5;">
AL BARAKA — Écosystème de l'entrepreneuriat halal<br>
<a href="{{UNSUB_URL}}" style="color:#7a7a7a;text-decoration:underline;">Se désabonner</a>
</div>
</td></tr></table></td></tr></table></body></html>`;
}

// Bouton « à toute épreuve ».
//
// L'ancienne version était un simple <a> doré : `background-color` en CSS,
// `color:#ffffff` par-dessus. Les clients qui filtrent le CSS des liens
// (Outlook via le moteur Word, certains rendus en mode sombre) retiraient le
// fond mais gardaient le texte blanc — bouton blanc sur carte blanche, donc
// invisible, donc « pas cliquable » pour le lecteur.
//
// Trois protections :
//   • l'attribut HTML `bgcolor` sur la cellule, qui survit là où le CSS tombe ;
//   • une bordure de la même couleur, qui dessine le bouton même sans fond ;
//   • sous le bouton, l'adresse en clair — un lecteur qui ne voit rien peut
//     toujours la lire et la recopier. C'est le vrai filet.
function cta(whatsapp: string): string {
  const visible = whatsapp.replace(/^https?:\/\//, "");
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin:28px auto 10px;">
<tr><td align="center" bgcolor="#C9A04E" style="background-color:#C9A04E;border:1px solid #C9A04E;border-radius:6px;">
<a href="${whatsapp}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">► Je rejoins le groupe WhatsApp privé</a>
</td></tr></table>
<p style="text-align:center;font-size:13px;line-height:1.5;color:#7a7a7a;margin:0 0 22px;">Le bouton ne s'affiche pas ?<br><a href="${whatsapp}" target="_blank" style="color:#A8813A;text-decoration:underline;">${visible}</a></p>`;
}


/**
 * Bouton vers le direct Zoom.
 *
 * Distinct de `cta()`, qui mene au groupe WhatsApp. Les deux coexistent : le
 * groupe reste le point de ralliement de la semaine, le lien Zoom ne vaut que
 * le jour meme, pendant la conference.
 */
function ctaZoom(url: string, libelle: string): string {
  const visible = url.replace(/^https?:\/\//, "");
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin:28px auto 10px;">
<tr><td align="center" bgcolor="#C9A04E" style="background-color:#C9A04E;border:1px solid #C9A04E;border-radius:6px;">
<a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${libelle}</a>
</td></tr></table>
<p style="text-align:center;font-size:13px;line-height:1.5;color:#7a7a7a;margin:0 0 22px;">Le bouton ne s'affiche pas ?<br><a href="${url}" target="_blank" style="color:#A8813A;text-decoration:underline;">${visible}</a></p>`;
}

/**
 * Filet si la fiche n'a pas de `zoom_url`. Comme pour le groupe WhatsApp :
 * mieux vaut un lien peut-etre perime qu'un e-mail sans bouton.
 */
const ZOOM_DEFAUT = "https://us06web.zoom.us/j/85455284733";

const SIG = `<p style="margin-top:24px;">Sidali<br><span style="color:#7a7a7a;">Fondateur de l'écosystème AL BARAKA</span></p>`;

interface Gabarit { name: string; subject: string; preheader: string; body: string }

// Les gabarits dépendent de la fiche (lien du groupe, heure) : ils sont donc
// construits à chaque appel plutôt que figés au chargement du module.
function gabarits(f: Fiche): Record<number, Gabarit> {
  const CTA = cta(f.whatsapp);
  return {
    4: {
      name: "T-2h",
      subject: "Plus que 2 heures ⏳",
      preheader: "Le lien du direct t'attend dans le groupe WhatsApp.",
      body: `<p>Assalamu alaykum {{FIRST_NAME}},</p>
<p><strong>Dans 2 heures, on est ensemble en direct.</strong></p>
<p>Ce qu'on va voir ce matin :</p>
<ul style="padding-left:20px;">
<li style="margin:8px 0;">Pourquoi la plupart des musulmans qui veulent entreprendre en ligne échouent (et ça n'a rien à voir avec le talent ou l'argent).</li>
<li style="margin:8px 0;">Les compétences digitales qui se monnaient vraiment aujourd'hui : sans stock, sans te montrer, sans renier tes valeurs.</li>
<li style="margin:8px 0;">Le chemin exact que suivent les membres d'AL BARAKA pour viser une vraie liberté financière, sans compromettre leur dîn.</li>
</ul>
<p>Si tu n'as qu'une seule chose à faire maintenant, c'est celle-ci : <strong>rejoins le groupe WhatsApp</strong>. Le lien du direct y sera posté — je ne veux pas que tu rates ça pour une simple histoire de lien.</p>
${CTA}
<p>Prépare tes questions. Rendez-vous à ${f.heure}, inshaAllah.</p>
${SIG}`,
    },
    // ── Sequence du 06/09/2026, texte fourni par Hassan ────────────────
    // Elle mene au DIRECT ZOOM, pas au groupe WhatsApp : c'est un envoi du jour
    // meme, ou le lien de la salle vaut mieux qu'un detour par WhatsApp.
    // Numeros 8 et 9 pour ne pas ecraser le sens des seq 4 et 5 dans
    // `email_campaign_sends`, dont le contenu etait different.
    8: {
      name: "M-30 (Zoom)",
      subject: "Plus que 30 minutes avant la conférence",
      preheader: "Prépare un endroit calme, de quoi noter, et ta concentration.",
      body: `<p>Salam aleykoum {{FIRST_NAME}},</p>
<p>Dans 30 minutes, on se retrouve pour la conférence exclusive :</p>
<p><strong>Découvre comment le métier de business developer peut te permettre de générer entre 2-6k / mois en 90 jours</strong></p>
<p>Voici ce que tu vas découvrir :</p>
<ol style="padding-left:20px;">
<li style="margin:8px 0;">Comment comprendre le système pour te sortir du conditionnement (et atteindre ta liberté géographique et financière).</li>
<li style="margin:8px 0;">Les VRAIS secrets des métiers du digital : comment vous faire payer pour vos compétences de manière 100% halal</li>
<li style="margin:8px 0;">Le plan EXACT en 5 étapes pour devenir business developer et atteindre l'indépendance</li>
</ol>
<p>Prépare un endroit calme, de quoi noter&hellip; et surtout ta concentration.</p>
${ctaZoom(f.zoom, "&#128073; Je rejoins la conférence")}
<p>On se retrouve tout à l'heure in shaa Allah,</p>
${SIG}`,
    },
    9: {
      name: "Ouverture (Zoom)",
      subject: "La conférence vient de commencer — rejoins-nous vite !",
      preheader: "On est en direct. Le lien de la salle est dans ce message.",
      body: `<p>Salam aleykoum {{FIRST_NAME}},</p>
<p>Nous venons tout juste de commencer la conférence en direct.</p>
<p>Si tu veux enfin comprendre comment générer des revenus en ligne sans produit, sans audience, et de manière 100% halal&hellip;</p>
<p>Et découvrir le métier méconnu qui permet à des frères et sœurs de gagner entre 2 000 et 6 000&euro;/mois en 90 jours&hellip;</p>
${ctaZoom(f.zoom, "&#10145; Je rejoins maintenant")}
${SIG}`,
    },
    5: {
      name: "Ouverture",
      subject: "🔴 C'est maintenant — viens, {{FIRST_NAME}}",
      preheader: `Je suis déjà là. On démarre à ${f.heure}.`,
      body: `<p>Assalamu alaykum {{FIRST_NAME}},</p>
<p><strong>J'y suis. On démarre dans quelques minutes.</strong></p>
<p>Le lien du direct est posté dans le groupe WhatsApp. Rejoins, clique, et viens t'asseoir avec nous :</p>
${CTA}
<p>On t'attend. Bismillah.</p>
${SIG}`,
    },
  };
}

function render(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v ?? "");
  }
  return out;
}

async function resendSend(payload: any): Promise<{ status: number; data: any }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// Charge toutes les lignes par pages : le client Supabase plafonne à 1000.
async function loadAll(supabase: any, table: string, selectCols: string, filters: Record<string, any>, orderCol: string | null) {
  const out: any[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(selectCols);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    if (orderCol) q = q.order(orderCol, { ascending: true });
    q = q.range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405 });
  if (!RESEND_API_KEY) return new Response(JSON.stringify({ error: "missing_resend_key" }), { status: 500 });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }); }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const fiche = await resoudreFiche(supabase, body?.conference_date);
  if (!fiche) {
    return new Response(JSON.stringify({ error: "conference_introuvable", demande: body?.conference_date ?? null }), { status: 404 });
  }

  const seq = parseInt(body?.seq);
  const TEMPLATES = gabarits(fiche);
  if (!TEMPLATES[seq]) {
    return new Response(JSON.stringify({ error: "seq_inconnu", attendus: Object.keys(TEMPLATES) }), { status: 400 });
  }
  const tpl = TEMPLATES[seq];

  const maxParam = parseInt(body?.max);
  const maxRecipients = (Number.isFinite(maxParam) && maxParam > 0 && maxParam <= 300) ? maxParam : DEFAULT_MAX;

  const alreadySent = await loadAll(supabase, "email_campaign_sends", "recipient_email", { campaign_slug: fiche.campaign_slug, email_seq: seq }, null);
  const alreadySentSet = new Set(alreadySent.map((r: any) => r.recipient_email.toLowerCase().trim()));

  const recipients = await loadAll(supabase, "email_campaign_recipients", "email, first_name, position", { campaign_slug: fiche.campaign_slug }, "position");

  const restants = recipients.filter((r: any) => !alreadySentSet.has(r.email.toLowerCase().trim()));
  const todo = restants.slice(0, maxRecipients);

  // Ce que la fonction ferait, sans le faire. À appeler avant tout envoi réel.
  if (body?.dry_run === true) {
    return new Response(JSON.stringify({
      dry_run: true,
      seq,
      template_name: tpl.name,
      conference_date: fiche.conference_date,
      heure: fiche.heure,
      campaign_slug: fiche.campaign_slug,
      groupe_whatsapp: fiche.whatsapp,
      groupe_renseigne_sur_la_fiche: fiche.groupe_renseigne,
      lien_zoom: fiche.zoom,
      zoom_renseigne_sur_la_fiche: fiche.zoom_renseigne,
      objet: render(tpl.subject, { FIRST_NAME: "Prénom" }),
      liste_totale: recipients.length,
      deja_envoyes: alreadySentSet.size,
      partiraient_maintenant: todo.length,
      resteraient_apres: Math.max(0, restants.length - todo.length),
    }), { status: 200 });
  }

  if (todo.length === 0) {
    return new Response(JSON.stringify({ ok: true, seq, message: "all_sent", conference_date: fiche.conference_date, campaign_slug: fiche.campaign_slug, already_sent: alreadySentSet.size, total_recipients_loaded: recipients.length }), { status: 200 });
  }

  const htmlTemplate = wrap(tpl.preheader, tpl.body);

  const logs: any[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const r of todo) {
    const vars = { FIRST_NAME: r.first_name || "frère/sœur", UNSUB_URL: UNSUB };
    const subject = render(tpl.subject, vars);
    const html = render(htmlTemplate, vars);

    let attempt = 0;
    let lastResp: any = null;
    while (attempt < 3) {
      lastResp = await resendSend({
        from: FROM_ADDR,
        to: [r.email],
        reply_to: REPLY_TO,
        subject, html,
        tags: [
          { name: "campaign", value: fiche.campaign_slug },
          { name: "seq", value: String(seq) },
        ],
      });
      if ((lastResp.status >= 200 && lastResp.status < 300) || lastResp.status !== 429) break;
      attempt++;
      await sleep(500 * attempt);
    }

    const ok = lastResp.status >= 200 && lastResp.status < 300;
    if (ok) okCount++; else failCount++;

    logs.push({
      campaign_slug: fiche.campaign_slug,
      email_seq: seq,
      recipient_email: r.email,
      recipient_first_name: r.first_name,
      resend_email_id: ok ? lastResp.data?.id : null,
      subject,
      status: ok ? "sent" : "failed",
      error_message: ok ? null : (lastResp.data?.message || JSON.stringify(lastResp.data)),
    });

    if (logs.length % 50 === 0) {
      const chunk = logs.splice(0);
      await supabase.from("email_campaign_sends").insert(chunk);
    }

    await sleep(DELAY_MS);
  }

  if (logs.length > 0) {
    await supabase.from("email_campaign_sends").insert(logs);
  }

  return new Response(JSON.stringify({
    ok: true, seq, processed: todo.length, sent: okCount, failed: failCount,
    template_name: tpl.name,
    conference_date: fiche.conference_date, campaign_slug: fiche.campaign_slug,
    already_sent_before: alreadySentSet.size, max_used: maxRecipients,
    total_recipients_loaded: recipients.length,
  }), { status: 200 });
});
