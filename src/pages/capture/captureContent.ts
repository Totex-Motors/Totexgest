/**
 * Conteúdo estático do MVP (frases de abordagem, objeções, microtreinos).
 * Vira tabela (script_cards / training_lessons) na Fase 6 — por enquanto fica
 * em código pra promotora já ter script do dia e treino na mão.
 */

export interface ScriptCard {
  tag: "Abordagem" | "Objeção" | "Fechamento";
  title: string;
  text: string;
}

export const SCRIPT_CARDS: ScriptCard[] = [
  {
    tag: "Abordagem",
    title: "Abertura no corredor",
    text: "Oi, tudo bem? Você já pensou em vender ou trocar seu carro? A Totex faz a avaliação gratuita e cuida de tudo — anúncio, negociação e documentação. Posso te fazer 3 perguntas rápidas?",
  },
  {
    tag: "Abordagem",
    title: "Gancho da avaliação",
    text: "Sabe quanto seu carro vale hoje? Em 2 minutos eu registro aqui e nosso especialista te manda uma avaliação de mercado pelo WhatsApp, sem compromisso.",
  },
  {
    tag: "Objeção",
    title: "“Não estou pensando em vender agora”",
    text: "Tranquilo! Muita gente só quer saber quanto vale pra planejar. Deixo registrado e, quando fizer sentido, você já tem um especialista de confiança. Qual o carro?",
  },
  {
    tag: "Objeção",
    title: "“Vou vender por conta própria”",
    text: "Faz sentido — só que anúncio, curioso, test drive e transferência tomam tempo. A gente faz tudo isso e você só aprova a proposta. Quer ver quanto sairia?",
  },
  {
    tag: "Objeção",
    title: "“Já tenho proposta de outra loja”",
    text: "Ótimo, então você já sabe o mínimo que vale. Nossa avaliação é gratuita: se a gente não superar, você não perde nada. Me passa o modelo e o ano?",
  },
  {
    tag: "Fechamento",
    title: "Passagem pro especialista",
    text: "Perfeito! Registrei aqui. Nosso especialista vai continuar com você agora pelo WhatsApp — pode chamar no seu número?",
  },
];

export interface MicroLesson {
  id: string;
  title: string;
  minutes: number;
  summary: string;
  bullets: string[];
}

export const MICRO_LESSONS: MicroLesson[] = [
  {
    id: "abordagem-3-perguntas",
    title: "As 3 perguntas que qualificam em 30 segundos",
    minutes: 2,
    summary: "Qual o carro? Quando pensa em vender? Aceita uma avaliação gratuita? — com isso o especialista já sabe se é quente.",
    bullets: [
      "Pergunte o carro ANTES de pedir o WhatsApp — a pessoa se abre falando do próprio carro.",
      "Prazo curto (agora/30 dias) é o sinal mais forte de venda. Anote sempre.",
      "Peça autorização pro especialista chamar: sem isso o lead não pode ser trabalhado.",
    ],
  },
  {
    id: "captar-sem-ser-chato",
    title: "Captar sem parecer venda de plano",
    minutes: 2,
    summary: "A promotora oferece um serviço (avaliação gratuita), não pede um favor. Postura de quem ajuda.",
    bullets: [
      "Sorria, olhe nos olhos, fale o nome da Totex nos primeiros 5 segundos.",
      "Se a pessoa está com pressa, entregue o QR/cartão e peça só o WhatsApp.",
      "Nunca insista mais de uma vez — um 'não' educado preserva a marca no shopping.",
    ],
  },
  {
    id: "km-e-ano",
    title: "Por que KM e ano mudam o valor",
    minutes: 2,
    summary: "Com KM + ano o especialista já consegue precificar sem ligar. Lead completo = resposta mais rápida = cliente mais satisfeito.",
    bullets: [
      "KM aproximado já serve ('uns 60 mil').",
      "Ano-modelo, não ano de fabricação, é o que o mercado usa.",
      "Se não souber, marque como pendente e complete depois em 'Meus Leads'.",
    ],
  },
  {
    id: "handoff",
    title: "O que acontece depois que você capta",
    minutes: 1,
    summary: "Lead quente → especialista é avisado na hora. Morno → contato no mesmo dia. Frio → nutrição automática. Você vê o resultado em Meus Leads e em Intermediações.",
    bullets: [
      "Combine a expectativa: 'nosso especialista chama você ainda hoje'.",
      "Quando o proprietário assina o contrato de intermediação, a intermediação vira 'Contrato assinado' — é aí que entra o seu prêmio de captação.",
      "Cadastro completo (carro, ano, KM, autorização) = contrato sai mais rápido.",
      "Leads com dado errado (telefone inválido) voltam pra você corrigir.",
    ],
  },
];

/** Perguntas pra autoavaliação rápida (sem IA nessa fase). */
export const QUIZ: { q: string; options: string[]; answer: number }[] = [
  {
    q: "Qual sinal vale mais pontos no score de captação?",
    options: ["Aceita avaliação", "Quer vender em até 30 dias", "É o proprietário"],
    answer: 1,
  },
  {
    q: "O que é obrigatório para o especialista poder chamar o cliente?",
    options: ["Ter o KM do carro", "Autorização de contato", "Valor em mente"],
    answer: 1,
  },
  {
    q: "O cliente diz 'vou vender por conta própria'. Melhor resposta?",
    options: ["Ok, boa sorte!", "Mostrar que a Totex resolve anúncio, curiosos e documentação", "Insistir três vezes"],
    answer: 1,
  },
];
