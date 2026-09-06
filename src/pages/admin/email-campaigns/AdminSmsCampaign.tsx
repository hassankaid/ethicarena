/**
 * Dashboard suivi de la campagne SMS Conference AL BARAKA.
 *
 * 5 onglets (SMS 2 → SMS 6) avec :
 *  - Envoyés / Délivrés / Failed
 *  - Segments totaux + coût USD
 *  - Liste destinataires avec timestamps sent/delivered/failed
 *  - Auto-refresh 30s
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare, CheckCircle2, XCircle, RefreshCw, DollarSign, MousePointerClick,
} from "lucide-react";

const CAMPAIGN_SLUG = "conf_2026_08_30_sms";

// Mêmes règles que côté e-mail : les onglets se déduisent de cet objet.
// Le T-2h a ete retire le 06/09/2026 : deux heures avant, le destinataire range
// le lien et l'oublie. Le seq 4 n'est pas reattribue — les envois de fin aout
// le portent encore dans `sms_campaign_sends`.
const SMS_NAMES: Record<number, string> = {
  6: "SMS 6 — Ouverture (M-10)",
  7: "SMS 7 — Rattrapage (M+15)",
};

const SMS_SEQS = Object.keys(SMS_NAMES).map(Number).sort((a, b) => a - b);

interface SmsStat {
  campaign_slug: string;
  sms_seq: number;
  nb_envoyes: number;
  nb_echec_envoi: number;
  nb_delivres: number;
  nb_failed: number;
  nb_clics: number;
  total_segments: number;
  total_price_usd: number | null;
  premier_envoi_at: string | null;
  dernier_envoi_at: string | null;
}

interface SmsDetail {
  recipient_phone: string;
  recipient_first_name: string | null;
  sent_at: string;
  delivered_at: string | null;
  clicked_at: string | null;
  failed_at: string | null;
  total_segments: number;
  total_price: number | null;
  has_failure: boolean;
}

function pct(num: number, total: number): string {
  if (!total) return "0,0 %";
  return ((num / total) * 100).toFixed(1).replace(".", ",") + " %";
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  return `$${p.toFixed(2)}`;
}

export default function AdminSmsCampaign() {
  const { profile, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [activeSeq, setActiveSeq] = useState(String(SMS_SEQS[0]));
  const [search, setSearch] = useState("");

  const isAuthorized =
    !!profile && (profile.role === "ceo" || profile.is_coach === true);

  const stats = useQuery({
    queryKey: ["sms-campaign-stats", CAMPAIGN_SLUG],
    enabled: isAuthorized,
    refetchInterval: 30_000,
    queryFn: async (): Promise<SmsStat[]> => {
      const { data, error } = await (supabase as any)
        .from("sms_campaign_stats")
        .select("*")
        .eq("campaign_slug", CAMPAIGN_SLUG)
        .order("sms_seq");
      if (error) throw error;
      return (data ?? []) as SmsStat[];
    },
  });

  const details = useQuery({
    queryKey: ["sms-campaign-details", CAMPAIGN_SLUG, activeSeq],
    enabled: isAuthorized,
    refetchInterval: 30_000,
    queryFn: async (): Promise<SmsDetail[]> => {
      const { data, error } = await (supabase as any)
        .from("sms_campaign_recipient_status")
        .select("*")
        .eq("campaign_slug", CAMPAIGN_SLUG)
        .eq("sms_seq", parseInt(activeSeq))
        .order("sent_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as SmsDetail[];
    },
  });

  if (authLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-lg font-semibold mb-2">Accès réservé</h2>
        <p className="text-sm text-muted-foreground">CEO / coachs uniquement.</p>
        <Button onClick={() => navigate("/")} variant="outline" className="mt-4">
          Retour
        </Button>
      </div>
    );
  }

  const allStats = stats.data ?? [];
  const totals = allStats.reduce(
    (acc, s) => ({
      sent: acc.sent + s.nb_envoyes,
      delivered: acc.delivered + s.nb_delivres,
      clicked: acc.clicked + (s.nb_clics ?? 0),
      failed: acc.failed + s.nb_failed,
      segments: acc.segments + (s.total_segments ?? 0),
      price: acc.price + (s.total_price_usd ?? 0),
    }),
    { sent: 0, delivered: 0, clicked: 0, failed: 0, segments: 0, price: 0 },
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Campagne SMS — Conférence 31/05</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Suivi temps réel · conférence du 30/08 · {SMS_SEQS.length} SMS (expéditeur « Al Baraka »)
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => navigate("/admin/email-campaign")} variant="outline" size="sm">
            Voir Emails
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              stats.refetch();
              details.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Actualiser
          </Button>
        </div>
      </div>

      {/* KPIs globaux */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <KpiCard icon={<MessageSquare />} label="Envoyés" value={totals.sent} />
        <KpiCard
          icon={<CheckCircle2 className="text-green-600" />}
          label="Délivrés"
          value={totals.delivered}
          pct={pct(totals.delivered, totals.sent)}
        />
        <KpiCard
          icon={<MousePointerClick className="text-blue-600" />}
          label="Clics"
          value={totals.clicked}
          pct={pct(totals.clicked, totals.delivered)}
        />
        <KpiCard
          icon={<XCircle className="text-red-600" />}
          label="Failed"
          value={totals.failed}
          pct={pct(totals.failed, totals.sent)}
        />
        <KpiCard
          icon={<MessageSquare className="text-amber-600" />}
          label="Segments"
          value={totals.segments}
        />
        <KpiCard
          icon={<DollarSign className="text-amber-700" />}
          label="Coût USD"
          value={Math.round(totals.price * 100) / 100}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Détail par SMS</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeSeq} onValueChange={setActiveSeq}>
            <TabsList className="grid grid-cols-2 mb-4">
              {SMS_SEQS.map((seq) => {
                const s = allStats.find((x) => x.sms_seq === seq);
                return (
                  <TabsTrigger key={seq} value={String(seq)} className="text-xs">
                    {SMS_NAMES[seq].split("—")[0].trim()}
                    {s && s.nb_envoyes > 0 && (
                      <Badge variant="secondary" className="ml-2 px-1.5">
                        {s.nb_envoyes}
                      </Badge>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {SMS_SEQS.map((seq) => {
              const s = allStats.find((x) => x.sms_seq === seq);
              return (
                <TabsContent key={seq} value={String(seq)} className="space-y-4">
                  <div className="border rounded-lg p-4 bg-muted/30">
                    <h3 className="font-semibold mb-3">{SMS_NAMES[seq]}</h3>
                    {!s || s.nb_envoyes === 0 ? (
                      <p className="text-sm text-muted-foreground">Pas encore envoyé.</p>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
                        <Metric label="Envoyés" value={s.nb_envoyes} />
                        <Metric
                          label="Délivrés"
                          value={s.nb_delivres}
                          pct={pct(s.nb_delivres, s.nb_envoyes)}
                          color="text-green-600"
                        />
                        <Metric
                          label="Clics"
                          value={s.nb_clics ?? 0}
                          pct={pct(s.nb_clics ?? 0, s.nb_delivres)}
                          color="text-blue-600"
                        />
                        <Metric
                          label="Failed"
                          value={s.nb_failed}
                          pct={pct(s.nb_failed, s.nb_envoyes)}
                          color="text-red-600"
                        />
                        <Metric label="Segments" value={s.total_segments ?? 0} />
                        <Metric
                          label="Coût USD"
                          value={Math.round((s.total_price_usd ?? 0) * 100) / 100}
                          color="text-amber-700"
                        />
                      </div>
                    )}
                    {s?.premier_envoi_at && (
                      <p className="text-xs text-muted-foreground mt-3">
                        Envoyé entre {fmtDate(s.premier_envoi_at)} et {fmtDate(s.dernier_envoi_at)}
                      </p>
                    )}
                  </div>

                  {s && s.nb_envoyes > 0 && (
                    <div>
                      <div className="mb-3">
                        <Input
                          placeholder="Rechercher un numéro ou prénom..."
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="max-w-sm"
                        />
                      </div>
                      <div className="border rounded-lg overflow-auto max-h-[500px]">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/50 sticky top-0">
                            <tr>
                              <th className="text-left p-2 font-medium">Destinataire</th>
                              <th className="text-left p-2 font-medium">Envoyé</th>
                              <th className="text-left p-2 font-medium">Délivré</th>
                              <th className="text-left p-2 font-medium">Cliqué</th>
                              <th className="text-left p-2 font-medium">Segments</th>
                              <th className="text-left p-2 font-medium">Prix</th>
                              <th className="text-left p-2 font-medium">Statut</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(details.data ?? [])
                              .filter(
                                (r) =>
                                  !search ||
                                  r.recipient_phone.includes(search) ||
                                  (r.recipient_first_name ?? "")
                                    .toLowerCase()
                                    .includes(search.toLowerCase()),
                              )
                              .slice(0, 500)
                              .map((r) => (
                                <tr key={r.recipient_phone} className="border-t hover:bg-muted/30">
                                  <td className="p-2">
                                    <div className="font-medium">{r.recipient_first_name ?? "—"}</div>
                                    <div className="text-muted-foreground">{r.recipient_phone}</div>
                                  </td>
                                  <td className="p-2">{fmtDate(r.sent_at)}</td>
                                  <td className="p-2">
                                    {r.delivered_at ? (
                                      <span className="text-green-600">✓ {fmtDate(r.delivered_at)}</span>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {r.clicked_at ? (
                                      <span className="text-blue-600">▸ {fmtDate(r.clicked_at)}</span>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="p-2">{r.total_segments}</td>
                                  <td className="p-2">{fmtPrice(r.total_price)}</td>
                                  <td className="p-2">
                                    {r.has_failure ? (
                                      <Badge variant="destructive">Échec</Badge>
                                    ) : r.failed_at ? (
                                      <Badge variant="destructive">Failed</Badge>
                                    ) : r.clicked_at ? (
                                      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
                                        Cliqué
                                      </Badge>
                                    ) : r.delivered_at ? (
                                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                                        Délivré
                                      </Badge>
                                    ) : (
                                      <Badge variant="secondary">Envoyé</Badge>
                                    )}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        {(details.data ?? []).length} lignes · Affichage limité à 500.
                      </p>
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Auto-refresh toutes les 30 secondes. Données issues de Twilio via status callback.
      </p>
    </div>
  );
}

function KpiCard({
  icon, label, value, pct,
}: { icon: React.ReactNode; label: string; value: number; pct?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className="text-2xl font-bold">{value.toLocaleString("fr-FR")}</div>
        {pct && <div className="text-xs text-muted-foreground mt-1">{pct}</div>}
      </CardContent>
    </Card>
  );
}

function Metric({
  label, value, pct, color,
}: { label: string; value: number; pct?: string; color?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${color ?? ""}`}>{value.toLocaleString("fr-FR")}</div>
      {pct && <div className="text-xs text-muted-foreground">{pct}</div>}
    </div>
  );
}
