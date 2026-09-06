-- ═══════════════════════════════════════════════════════════════════════
-- Le lien du direct rejoint la fiche de la conference.
--
-- Il etait ecrit en dur dans `send-conference-mail`. Il aurait donc fallu
-- redeployer la fonction chaque semaine — et le dimanche ou quelqu'un oublie,
-- l'e-mail envoie une centaine de personnes vers une salle qui n'existe plus.
--
-- Meme traitement que `whatsapp_group_url`, deja porte par la fiche : la
-- conference decrit elle-meme ou elle se tient. La valeur est stable d'une
-- semaine a l'autre, mais chaque conference peut la surcharger.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.conferences add column if not exists zoom_url text;

comment on column public.conferences.zoom_url is
  'Lien du direct (salle Zoom). Stable d''une semaine a l''autre, mais modifiable par conference.';

update public.conferences
set zoom_url = 'https://us06web.zoom.us/j/85455284733'
where conference_date >= '2026-09-06' and zoom_url is null;
