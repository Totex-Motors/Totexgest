import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Loader2, PlayCircle, ShieldCheck, Upload, Video, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type TrainingAssignment = {
  id: string;
  tenant_id: string;
  member_id: string;
  title: string;
  description: string | null;
  storage_path: string;
  is_published: boolean;
  created_at: string;
};

type TrainingMember = { id: string; name: string; email: string };
const BUCKET = "commercial-training";
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export default function CommercialTraining() {
  const { teamMember, tenantId, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [memberId, setMemberId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [loadingVideoId, setLoadingVideoId] = useState<string | null>(null);

  useEffect(() => () => {
    if (playing?.url) URL.revokeObjectURL(playing.url);
  }, [playing]);

  const assignments = useQuery({
    queryKey: ["commercial-training-videos", tenantId, teamMember?.id, isAdmin],
    enabled: !!tenantId && !!teamMember,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("training_video_assignments")
        .select("id, tenant_id, member_id, title, description, storage_path, is_published, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TrainingAssignment[];
    },
  });

  const members = useQuery({
    queryKey: ["commercial-training-members", tenantId],
    enabled: isAdmin && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("team_members")
        .select("id, name, email, role")
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .in("role", ["comercial", "closer", "sdr"])
        .order("name");
      if (error) throw error;
      return (data ?? []) as TrainingMember[];
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!tenantId || !teamMember || !memberId || !file || !title.trim()) {
        throw new Error("Preencha o título, escolha o vendedor e selecione o vídeo.");
      }
      if (!members.data?.some((member) => member.id === memberId)) {
        throw new Error("Escolha um vendedor ativo deste tenant.");
      }
      if (file.size > MAX_VIDEO_BYTES) throw new Error("O vídeo deve ter no máximo 100 MB.");
      if (file.type !== "video/mp4" && !file.name.toLowerCase().endsWith(".mp4")) {
        throw new Error("Envie o vídeo em formato MP4.");
      }

      const path = `${tenantId}/${memberId}/${crypto.randomUUID()}.mp4`;
      const { error: storageError } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: "video/mp4",
        cacheControl: "3600",
        upsert: false,
      });
      if (storageError) throw storageError;

      const { error: insertError } = await (supabase as any)
        .from("training_video_assignments")
        .insert({
          tenant_id: tenantId,
          member_id: memberId,
          title: title.trim(),
          description: description.trim() || null,
          storage_path: path,
          is_published: true,
        });

      if (insertError) {
        await supabase.storage.from(BUCKET).remove([path]);
        throw insertError;
      }
      return path;
    },
    onSuccess: async () => {
      toast.success("Vídeo enviado e atribuído ao vendedor.");
      setTitle("");
      setDescription("");
      setMemberId("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await queryClient.invalidateQueries({ queryKey: ["commercial-training-videos"] });
    },
    onError: (error) => toast.error((error as Error).message || "Não foi possível enviar o vídeo."),
  });

  const play = async (item: TrainingAssignment) => {
    setLoadingVideoId(item.id);
    try {
      // download() exige o JWT da sessão e revalida o RLS do objeto; não cria URL
      // assinada compartilhável que continue acessível a outro tenant.
      const { data, error } = await supabase.storage.from(BUCKET).download(item.storage_path);
      if (error || !data) throw error ?? new Error("Vídeo indisponível.");
      setPlaying({ id: item.id, url: URL.createObjectURL(data) });
    } catch {
      toast.error("Não foi possível abrir este treinamento. Confirme se ele está atribuído à sua conta.");
    } finally {
      setLoadingVideoId(null);
    }
  };

  const visibleItems = useMemo(() => assignments.data ?? [], [assignments.data]);
  const currentName = teamMember?.name || "vendedor";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Treinamento comercial</h1>
        </div>
        <p className="text-sm text-muted-foreground">Vídeos atribuídos para você, com o passo a passo das telas e da rotina Totex.</p>
      </header>

      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Upload className="h-4 w-4" /> Atribuir treinamento a um vendedor</CardTitle>
            <p className="text-sm text-muted-foreground">O vídeo fica privado e só aparece para o membro escolhido e os administradores deste tenant.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input aria-label="Título do vídeo" placeholder="Ex.: Treinamento CRM — Glauter" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
              <Select value={memberId} onValueChange={setMemberId}>
                <SelectTrigger aria-label="Vendedor que receberá o treinamento"><SelectValue placeholder="Selecione o vendedor" /></SelectTrigger>
                <SelectContent>
                  {(members.data ?? []).map((member) => <SelectItem key={member.id} value={member.id}>{member.name} · {member.email}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Textarea aria-label="Descrição do treinamento" placeholder="O que o vendedor aprenderá neste vídeo?" rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <input ref={fileRef} type="file" accept="video/mp4,.mp4" className="sr-only" id="training-video-file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><Video className="mr-2 h-4 w-4" />Escolher MP4</Button>
                <span className="truncate text-xs text-muted-foreground">{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "Até 100 MB"}</span>
                {file && <Button type="button" variant="ghost" size="icon" aria-label="Remover vídeo selecionado" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}><X className="h-4 w-4" /></Button>}
              </div>
              <Button type="button" disabled={upload.isPending || !title.trim() || !memberId || !file || members.isLoading} onClick={() => upload.mutate()}>
                {upload.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando…</> : "Enviar e atribuir"}
              </Button>
            </div>
            {members.isError && <p className="text-sm text-destructive">Não foi possível carregar os vendedores deste tenant.</p>}
            {members.data?.length === 0 && <p className="text-sm text-muted-foreground">Não há vendedores ativos com perfil comercial neste tenant.</p>}
          </CardContent>
        </Card>
      )}

      {assignments.isLoading ? (
        <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Carregando treinamentos…</div>
      ) : assignments.isError ? (
        <div className="rounded-lg border border-destructive/40 p-6 text-center text-sm text-destructive">Não foi possível carregar seus treinamentos. Atualize a página ou fale com o administrador.</div>
      ) : visibleItems.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">Nenhum vídeo atribuído ainda</p>
          <p className="max-w-md text-sm text-muted-foreground">Quando o administrador atribuir um treinamento a {currentName}, ele aparecerá aqui. Os vídeos de outros membros e tenants não são listados.</p>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {visibleItems.map((item) => (
            <Card key={item.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1"><CardTitle className="text-base">{item.title}</CardTitle>{item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}</div>
                  <Badge variant="secondary" className="shrink-0">Privado</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {playing?.id === item.id ? (
                  <div className="space-y-2">
                    <video className="aspect-video w-full rounded-md bg-black" controls playsInline preload="metadata" src={playing.url} />
                    <Button variant="outline" size="sm" onClick={() => setPlaying(null)}>Fechar vídeo</Button>
                  </div>
                ) : (
                  <Button className="w-full" disabled={loadingVideoId !== null} onClick={() => void play(item)}>
                    {loadingVideoId === item.id ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Preparando vídeo…</> : <><PlayCircle className="mr-2 h-4 w-4" />Assistir treinamento</>}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
