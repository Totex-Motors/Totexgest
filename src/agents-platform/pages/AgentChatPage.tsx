/**
 * AgentChatPage — rota fullscreen pra qualquer agente da plataforma nova.
 * Rota: /agentes/:slug
 */

import { useParams, Navigate, useNavigate } from 'react-router-dom';
import { AgentChat } from '../components/AgentChat';

export default function AgentChatPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  if (!slug) return <Navigate to="/agentes" replace />;

  // Fecha a tela cheia voltando pra config do agente (ou pra lista se não houver histórico).
  const handleClose = () => navigate(`/agentes/${slug}/config`);

  return (
    <div className="h-[100dvh] bg-background overflow-hidden p-4">
      <AgentChat slug={slug} channel="chat_web" fullscreen onClose={handleClose} />
    </div>
  );
}
