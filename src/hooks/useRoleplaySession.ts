import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

// ─── Types ──────────────────────────────────────────────────────────────
export interface RoleplayPersona {
  id?: string;
  name: string;
  role: string;
  company: string;
  avatar: string;
  profile?: string;
  objections?: string[];
}

export interface CustomPersona {
  name: string;
  role: string;
  company: string;
  context: string;
  objections?: string[];
  budget?: string;
  decisionMaker?: string;
  timeline?: string;
}

export interface TranscriptionEntry {
  id: string;
  speaker: 'vendedor' | 'cliente';
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export interface RoleplaySession {
  id: string;
  sales_rep_id: string | null;
  persona_id: string | null;
  persona_name: string;
  persona_role: string | null;
  persona_company: string | null;
  scenario: string;
  voice: string;
  duration_seconds: number;
  transcription: TranscriptionEntry[];
  evaluation: any;
  score: number | null;
  verdict: 'sim' | 'nao' | 'talvez' | null;
  created_by: string;
  created_at: string;
}

export interface RoleplayState {
  status: 'idle' | 'connecting' | 'active' | 'ended';
  persona: RoleplayPersona | null;
  scenario: string;
  voice: string;
  duration: number;
  transcription: TranscriptionEntry[];
  isMuted: boolean;
  isAiSpeaking: boolean;
  error: string | null;
}

// ─── Default personas (espelho da edge function) ────────────────────────
export const DEFAULT_PERSONAS: RoleplayPersona[] = [
  {
    id: 'roberto_cetico',
    name: 'Roberto Mendes',
    role: 'CEO',
    company: 'TechNova',
    avatar: 'RM',
    profile: 'Pragmático, cético, quer dados e cases concretos. Já foi enganado por consultoria.',
  },
  {
    id: 'ana_preco',
    name: 'Ana Oliveira',
    role: 'CFO',
    company: 'Grupo Fênix',
    avatar: 'AO',
    profile: 'Focada em ROI e números. Compara preços, pede planilha, quer payback.',
  },
  {
    id: 'carlos_tecnico',
    name: 'Carlos Lima',
    role: 'CTO',
    company: 'DataFlow Systems',
    avatar: 'CL',
    profile: 'Técnico, conhece concorrentes. Faz perguntas profundas sobre integração.',
  },
  {
    id: 'mariana_indecisa',
    name: 'Mariana Santos',
    role: 'Head de RH',
    company: 'Wellness Corp',
    avatar: 'MS',
    profile: 'Simpática mas indecisa. Sempre precisa "falar com alguém" antes de decidir.',
  },
  {
    id: 'pedro_apressado',
    name: 'Pedro Almeida',
    role: 'Fundador',
    company: 'RápidoTech',
    avatar: 'PA',
    profile: 'Impaciente, tem 10 minutos. Quer saber: o que faz, quanto custa, quando começa.',
  },
];

// ─── Hook ───────────────────────────────────────────────────────────────
export function useRoleplaySession() {
  const [state, setState] = useState<RoleplayState>({
    status: 'idle',
    persona: null,
    scenario: 'discovery',
    voice: 'ash',
    duration: 0,
    transcription: [],
    isMuted: false,
    isAiSpeaking: false,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const transcriptionIdRef = useRef(0);
  const isPlayingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const isMutedRef = useRef(false);
  const statusRef = useRef<RoleplayState['status']>('idle');

  // Keep refs in sync with state
  useEffect(() => {
    isMutedRef.current = state.isMuted;
  }, [state.isMuted]);

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  // ─── Audio playback (AI voice) ──────────────────────────────────────
  const playAudioChunk = useCallback((base64Audio: string) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;

    try {
      // Decode base64 to PCM16
      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const pcm16 = new Int16Array(bytes.buffer);

      // Convert PCM16 to Float32
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768;
      }

      // Create audio buffer (24kHz is OpenAI Realtime output rate)
      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      // Schedule seamlessly
      const now = ctx.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;

      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        setState(s => ({ ...s, isAiSpeaking: true }));
      }

      source.onended = () => {
        if (ctx.currentTime >= nextPlayTimeRef.current - 0.05) {
          isPlayingRef.current = false;
          setState(s => ({ ...s, isAiSpeaking: false }));
        }
      };
    } catch (err) {
      console.warn('[Roleplay] Audio playback error:', err);
    }
  }, []);

  // ─── Mic capture → send to WebSocket ────────────────────────────────
  const startMicCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    micStreamRef.current = stream;

    const ctx = audioContextRef.current!;
    const source = ctx.createMediaStreamSource(stream);

    // ScriptProcessor to capture PCM data
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      // Use ref instead of state to avoid stale closure
      if (isMutedRef.current) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Resample from audioContext.sampleRate to 24000
      const ratio = 24000 / ctx.sampleRate;
      const outputLength = Math.floor(inputData.length * ratio);
      const output = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIndex = i / ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
        const frac = srcIndex - srcIndexFloor;

        const sample = inputData[srcIndexFloor] * (1 - frac) + inputData[srcIndexCeil] * frac;
        output[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }

      // Convert to base64
      const uint8 = new Uint8Array(output.buffer);
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);

      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64,
      }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }, []);

  // ─── Start session ──────────────────────────────────────────────────
  const startSession = useCallback(async (
    personaIdOrCustom: string | CustomPersona,
    scenario: string = 'discovery',
    voice: string = 'ash'
  ) => {
    setState(s => ({ ...s, status: 'connecting', error: null, transcription: [], duration: 0 }));
    statusRef.current = 'connecting';

    try {
      // 1. Get ephemeral token from edge function
      const body = typeof personaIdOrCustom === 'string'
        ? { personaId: personaIdOrCustom, scenario, voice }
        : { customPersona: personaIdOrCustom, scenario, voice };

      console.log('[Roleplay] Requesting session token...');
      const { data, error } = await supabase.functions.invoke('roleplay-session', { body });

      if (error) {
        console.error('[Roleplay] Edge function error:', error);
        throw new Error(error.message || 'Falha ao criar sessão');
      }

      if (!data?.token) {
        console.error('[Roleplay] No token in response:', data);
        throw new Error(data?.error || 'Token não recebido da API');
      }

      const { token, persona } = data;
      console.log('[Roleplay] Token received, connecting WebSocket...');

      setState(s => ({ ...s, persona, scenario, voice }));

      // 2. Init AudioContext
      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // 3. Connect to OpenAI Realtime WebSocket (GA model)
      const wsUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
      console.log('[Roleplay] Connecting to:', wsUrl);

      const ws = new WebSocket(wsUrl, [
        'realtime',
        `openai-insecure-api-key.${token}`,
      ]);
      wsRef.current = ws;

      ws.onopen = async () => {
        console.log('[Roleplay] WebSocket connected!');

        try {
          // Start mic capture first
          await startMicCapture();
          console.log('[Roleplay] Mic capture started');

          // Send initial response.create to make AI greet first
          ws.send(JSON.stringify({
            type: 'response.create',
          }));
          console.log('[Roleplay] Sent response.create');

          setState(s => ({ ...s, status: 'active' }));
          statusRef.current = 'active';

          // Start duration timer
          startTimeRef.current = Date.now();
          durationIntervalRef.current = setInterval(() => {
            setState(s => ({
              ...s,
              duration: Math.floor((Date.now() - startTimeRef.current) / 1000),
            }));
          }, 1000);
        } catch (micErr: any) {
          console.error('[Roleplay] Mic capture failed:', micErr);
          setState(s => ({ ...s, error: 'Erro ao acessar microfone: ' + micErr.message }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            // Session events
            case 'session.created':
            case 'session.updated': {
              console.log('[Roleplay] Session event:', msg.type);
              break;
            }

            // GA: AI audio response (renamed from response.audio.delta)
            case 'response.output_audio.delta':
            case 'response.audio.delta': {
              if (msg.delta) {
                playAudioChunk(msg.delta);
              }
              break;
            }

            // GA: AI text transcript (renamed from response.audio_transcript.delta)
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta': {
              if (msg.delta) {
                setState(s => {
                  const existing = s.transcription.find(
                    t => t.speaker === 'cliente' && !t.isFinal
                  );
                  if (existing) {
                    return {
                      ...s,
                      transcription: s.transcription.map(t =>
                        t.id === existing.id
                          ? { ...t, text: t.text + msg.delta }
                          : t
                      ),
                    };
                  }
                  const id = `ai-${++transcriptionIdRef.current}`;
                  return {
                    ...s,
                    transcription: [...s.transcription, {
                      id,
                      speaker: 'cliente',
                      text: msg.delta,
                      timestamp: Date.now() - startTimeRef.current,
                      isFinal: false,
                    }],
                  };
                });
              }
              break;
            }

            // GA: AI transcript done
            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done': {
              setState(s => ({
                ...s,
                transcription: s.transcription.map(t =>
                  t.speaker === 'cliente' && !t.isFinal
                    ? { ...t, isFinal: true, text: msg.transcript || t.text }
                    : t
                ),
              }));
              break;
            }

            // GA: AI text output (for text-only responses)
            case 'response.output_text.delta':
            case 'response.text.delta': {
              if (msg.delta) {
                setState(s => {
                  const existing = s.transcription.find(
                    t => t.speaker === 'cliente' && !t.isFinal
                  );
                  if (existing) {
                    return {
                      ...s,
                      transcription: s.transcription.map(t =>
                        t.id === existing.id
                          ? { ...t, text: t.text + msg.delta }
                          : t
                      ),
                    };
                  }
                  const id = `ai-${++transcriptionIdRef.current}`;
                  return {
                    ...s,
                    transcription: [...s.transcription, {
                      id,
                      speaker: 'cliente',
                      text: msg.delta,
                      timestamp: Date.now() - startTimeRef.current,
                      isFinal: false,
                    }],
                  };
                });
              }
              break;
            }

            case 'response.output_text.done':
            case 'response.text.done': {
              setState(s => ({
                ...s,
                transcription: s.transcription.map(t =>
                  t.speaker === 'cliente' && !t.isFinal
                    ? { ...t, isFinal: true, text: msg.text || t.text }
                    : t
                ),
              }));
              break;
            }

            // Response done
            case 'response.done': {
              console.log('[Roleplay] Response complete');
              break;
            }

            // User speech transcript (both GA and beta names)
            case 'conversation.item.input_audio_transcription.completed':
            case 'conversation.item.input_audio_transcription.done': {
              const transcript = msg.transcript || msg.text;
              if (transcript?.trim()) {
                const id = `user-${++transcriptionIdRef.current}`;
                setState(s => ({
                  ...s,
                  transcription: [...s.transcription, {
                    id,
                    speaker: 'vendedor',
                    text: transcript.trim(),
                    timestamp: Date.now() - startTimeRef.current,
                    isFinal: true,
                  }],
                }));
              }
              break;
            }

            // Speech started (user is talking → AI should stop)
            case 'input_audio_buffer.speech_started': {
              setState(s => ({ ...s, isAiSpeaking: false }));
              isPlayingRef.current = false;
              nextPlayTimeRef.current = 0;
              break;
            }

            // Normal flow events
            case 'input_audio_buffer.speech_stopped':
            case 'input_audio_buffer.committed':
            case 'conversation.item.added':
            case 'conversation.item.done':
            case 'response.created':
            case 'response.output_item.added':
            case 'response.output_item.done':
            case 'response.content_part.added':
            case 'response.content_part.done': {
              break;
            }

            case 'error': {
              console.error('[Roleplay] API error:', JSON.stringify(msg.error, null, 2));
              if (msg.error?.message) {
                setState(s => ({ ...s, error: msg.error.message }));
              }
              break;
            }

            default: {
              // Log ALL unknown events for debugging
              console.log('[Roleplay] Unhandled event:', msg.type, msg);
            }
          }
        } catch (parseErr) {
          console.warn('[Roleplay] Failed to parse message:', parseErr);
        }
      };

      ws.onerror = (e) => {
        console.error('[Roleplay] WebSocket connection error:', e);
        setState(s => ({ ...s, error: 'Erro de conexão WebSocket', status: 'idle' }));
        statusRef.current = 'idle';
      };

      ws.onclose = (e) => {
        console.log(`[Roleplay] WebSocket closed: code=${e.code} reason=${e.reason}`);
        // Only transition to ended if we were actively in a session
        if (statusRef.current === 'active') {
          setState(s => ({ ...s, status: 'ended' }));
          statusRef.current = 'ended';
        } else if (statusRef.current === 'connecting') {
          // Connection rejected
          setState(s => ({
            ...s,
            status: 'idle',
            error: `Conexão rejeitada (code ${e.code}). Verifique a API key da OpenAI.`,
          }));
          statusRef.current = 'idle';
        }
      };

    } catch (err: any) {
      console.error('[Roleplay] Start error:', err);
      setState(s => ({
        ...s,
        status: 'idle',
        error: err.message || 'Erro ao iniciar sessão',
      }));
      statusRef.current = 'idle';
    }
  }, [startMicCapture, playAudioChunk]);

  // ─── End session ────────────────────────────────────────────────────
  const endSession = useCallback(() => {
    // Stop mic
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }

    // Disconnect processor
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop timer
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;

    setState(s => ({ ...s, status: 'ended', isAiSpeaking: false }));
    statusRef.current = 'ended';
  }, []);

  // ─── Toggle mute ───────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    setState(s => {
      const newMuted = !s.isMuted;
      isMutedRef.current = newMuted;
      // Actually mute the mic tracks
      if (micStreamRef.current) {
        micStreamRef.current.getAudioTracks().forEach(t => {
          t.enabled = !newMuted;
        });
      }
      return { ...s, isMuted: newMuted };
    });
  }, []);

  // ─── Reset ─────────────────────────────────────────────────────────
  const resetSession = useCallback(() => {
    setState({
      status: 'idle',
      persona: null,
      scenario: 'discovery',
      voice: 'ash',
      duration: 0,
      transcription: [],
      isMuted: false,
      isAiSpeaking: false,
      error: null,
    });
    statusRef.current = 'idle';
    isMutedRef.current = false;
  }, []);

  // ─── Cleanup on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
      if (audioContextRef.current) audioContextRef.current.close();
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    };
  }, []);

  return {
    ...state,
    startSession,
    endSession,
    toggleMute,
    resetSession,
    personas: DEFAULT_PERSONAS,
  };
}

// ─── Save session to DB ───────────────────────────────────────────────
export async function saveRoleplaySession(params: {
  persona: RoleplayPersona;
  scenario: string;
  voice: string;
  duration: number;
  transcription: TranscriptionEntry[];
  evaluation: any;
  score: number;
  verdict: 'sim' | 'nao' | 'talvez';
  userId: string;
  salesRepId?: string;
}) {
  const { data, error } = await supabase
    .from('roleplay_sessions')
    .insert({
      persona_id: params.persona.id || null,
      persona_name: params.persona.name,
      persona_role: params.persona.role,
      persona_company: params.persona.company,
      scenario: params.scenario,
      voice: params.voice,
      duration_seconds: params.duration,
      transcription: params.transcription.filter(t => t.isFinal),
      evaluation: params.evaluation,
      score: params.score,
      verdict: params.verdict,
      created_by: params.userId,
      sales_rep_id: params.salesRepId || null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Roleplay] Save error:', error);
    throw error;
  }
  return data;
}

// ─── Hook: list past sessions ─────────────────────────────────────────
export function useRoleplayHistory(limit = 20) {
  return useQuery({
    queryKey: ['roleplay-history', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('roleplay_sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as RoleplaySession[];
    },
  });
}
