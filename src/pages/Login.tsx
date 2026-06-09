import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, ArrowRight, Eye, EyeOff, ShieldCheck, User } from 'lucide-react';

/* ─── Config ────────────────────────────────────────────────── */
const BRAND = {
  name: 'Totex Motors',
  tagline: 'Cada lead conduzido até a venda',
  features: [
    { label: 'Funil de Vendas', desc: 'Acompanhe cada lead do primeiro contato ao fechamento' },
    { label: 'Atendimento no WhatsApp', desc: 'Centralize as conversas de toda a equipe' },
    { label: 'Cockpit do Vendedor', desc: 'Hot leads, tarefas e agenda do dia em tempo real' },
  ],
};

/* ─── Geometric Shard Component ─────────────────────────────── */
function FloatingShard({ delay, x, y, size, rotation, opacity }: {
  delay: number; x: string; y: string; size: number; rotation: number; opacity: number;
}) {
  return (
    <motion.div
      className="absolute"
      style={{ left: x, top: y }}
      initial={{ opacity: 0, scale: 0.3, rotate: rotation - 20 }}
      animate={{
        opacity: [0, opacity, opacity, 0],
        scale: [0.3, 1, 1, 0.3],
        rotate: [rotation - 20, rotation, rotation + 5, rotation - 10],
        y: [0, -15, -15, 0],
      }}
      transition={{
        duration: 12,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    >
      <div
        className="border border-teal-400/20 bg-gradient-to-br from-teal-400/[0.04] to-transparent backdrop-blur-[2px]"
        style={{
          width: size,
          height: size * 1.4,
          clipPath: 'polygon(20% 0%, 100% 10%, 80% 100%, 0% 90%)',
        }}
      />
    </motion.div>
  );
}

/* ─── Ambient Orb ───────────────────────────────────────────── */
function AmbientOrb({ color, x, y, size, delay }: {
  color: string; x: string; y: string; size: number; delay: number;
}) {
  return (
    <motion.div
      className="absolute rounded-full blur-[100px]"
      style={{
        left: x, top: y, width: size, height: size,
        background: color,
      }}
      animate={{
        scale: [1, 1.2, 1],
        opacity: [0.15, 0.25, 0.15],
      }}
      transition={{ duration: 8, delay, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

/* ─── Main Login Page ───────────────────────────────────────── */
export default function Login() {
  const navigate = useNavigate();
  const { signIn, signUp, signUpAsAdmin } = useAuth();
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [isAdminSignUp, setIsAdminSignUp] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signUpName, setSignUpName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    if (isSignUp) {
      const name = signUpName || loginEmail.split('@')[0];
      const fn = isAdminSignUp ? signUpAsAdmin : signUp;
      const { error } = await fn(loginEmail, loginPassword, name);
      if (error) {
        toast({
          title: 'Erro ao criar conta',
          description: error.message,
          variant: 'destructive',
        });
      } else {
        toast({ title: isAdminSignUp ? 'Conta admin criada! Bem-vindo!' : 'Conta criada! Bem-vindo!' });
        navigate('/');
      }
    } else {
      const { error } = await signIn(loginEmail, loginPassword);
      if (error) {
        toast({
          title: 'Erro ao entrar',
          description: error.message === 'Invalid login credentials'
            ? 'Email ou senha incorretos'
            : error.message,
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Bem-vindo!' });
        navigate('/');
      }
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex bg-[#07070a]">
      {/* ─── Left Panel: Atmospheric Hero ─── */}
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden">
        {/* Deep gradient base */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0c0c10] via-[#0a0a12] to-[#08080c]" />

        {/* Ambient orbs */}
        <AmbientOrb color="#14b8a6" x="20%" y="30%" size={300} delay={0} />
        <AmbientOrb color="#0f3d3d" x="60%" y="60%" size={400} delay={2} />
        <AmbientOrb color="#14b8a6" x="70%" y="15%" size={200} delay={4} />

        {/* Grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(20,184,166,0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(20,184,166,0.3) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
          }}
        />

        {/* Floating geometric shards */}
        <FloatingShard delay={0} x="15%" y="20%" size={80} rotation={15} opacity={0.6} />
        <FloatingShard delay={2} x="65%" y="35%" size={60} rotation={-10} opacity={0.4} />
        <FloatingShard delay={4} x="35%" y="65%" size={100} rotation={25} opacity={0.5} />
        <FloatingShard delay={6} x="75%" y="70%" size={50} rotation={-20} opacity={0.3} />
        <FloatingShard delay={1} x="45%" y="15%" size={70} rotation={35} opacity={0.4} />
        <FloatingShard delay={3} x="20%" y="80%" size={55} rotation={-5} opacity={0.35} />

        {/* Diagonal accent line */}
        <motion.div
          className="absolute w-[1px] bg-gradient-to-b from-transparent via-teal-400/30 to-transparent"
          style={{ height: '120%', left: '40%', top: '-10%', rotate: '15deg' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 1.5 }}
        />

        {/* Content overlay */}
        <div className="relative z-10 flex flex-col justify-between p-12 xl:p-16 w-full">
          {/* Brand */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8 }}
          >
            <div className="flex items-center gap-3 mb-2">
              <img
                src="/logo_totex.png"
                alt={BRAND.name}
                className="h-12 w-auto object-contain drop-shadow-[0_0_25px_rgba(20,184,166,0.25)]"
              />
            </div>
          </motion.div>

          {/* Headline */}
          <div className="flex-1 flex flex-col justify-center max-w-lg">
            <motion.h1
              className="text-4xl xl:text-5xl font-extralight text-[#f8f6f1] leading-[1.15] mb-6 tracking-tight"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
            >
              {BRAND.tagline.split(' ').map((word, i) => (
                <span key={i}>
                  {i === BRAND.tagline.split(' ').length - 1 ? (
                    <span className="text-teal-300 font-semibold">{word}</span>
                  ) : (
                    word
                  )}{' '}
                </span>
              ))}
            </motion.h1>

            <motion.div
              className="w-16 h-[1px] bg-gradient-to-r from-teal-400/60 to-transparent mb-8"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ delay: 0.8, duration: 0.6 }}
              style={{ transformOrigin: 'left' }}
            />

            {/* Feature cards */}
            <div className="space-y-4">
              {BRAND.features.map((feature, i) => (
                <motion.div
                  key={feature.label}
                  className="flex items-start gap-4 group"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 1 + i * 0.15, duration: 0.5 }}
                >
                  <div className="w-1 h-10 rounded-full bg-gradient-to-b from-teal-400/50 to-teal-400/0 mt-0.5 group-hover:from-teal-300/80 transition-colors duration-500" />
                  <div>
                    <p className="text-[#f8f6f1]/90 text-sm font-medium">{feature.label}</p>
                    <p className="text-[#f8f6f1]/40 text-xs mt-0.5">{feature.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Bottom stats */}
          <motion.div
            className="flex gap-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.6, duration: 0.8 }}
          >
            {[
              { value: '+Controle', label: 'Gestão simplificada de Leads' },
              { value: '+Produtividade', label: 'Menos tarefas manuais' },
              { value: '+Resultados', label: 'Mais negócios fechados' },
            ].map((stat) => (
              <div key={stat.label}>
                <p className="text-teal-300 text-xl font-bold" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {stat.value}
                </p>
                <p className="text-[#f8f6f1]/30 text-[11px] tracking-wide uppercase">{stat.label}</p>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Right edge fade */}
        <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-[#07070a] to-transparent z-20" />
      </div>

      {/* ─── Right Panel: Login Form ─── */}
      <div className="w-full lg:w-[45%] flex items-center justify-center p-6 sm:p-10 relative">
        {/* Subtle background texture */}
        <div className="absolute inset-0 bg-[#07070a]" />
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(20,184,166,0.5) 1px, transparent 0)',
            backgroundSize: '32px 32px',
          }}
        />

        <motion.div
          className="w-full max-w-[380px] relative z-10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6 }}
        >
          {/* Mobile brand (hidden on desktop) */}
          <div className="lg:hidden text-center mb-10">
            <div className="flex items-center justify-center mb-3">
              <img
                src="/logo_totex.png"
                alt={BRAND.name}
                className="h-14 w-auto object-contain drop-shadow-[0_0_20px_rgba(20,184,166,0.25)]"
              />
            </div>
            <p className="text-[#f8f6f1]/30 text-xs mt-1 tracking-wider uppercase">{BRAND.tagline}</p>
          </div>

          {/* Form header */}
          <div className="mb-8">
            <motion.h2
              className="text-[#f8f6f1] text-2xl font-semibold mb-2 tracking-tight"
              style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4 }}
            >
              {isSignUp ? 'Criar conta' : 'Bem-vindo de volta'}
            </motion.h2>
            <motion.p
              className="text-[#f8f6f1]/35 text-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              {isSignUp ? 'Preencha seus dados para começar' : 'Entre com suas credenciais para continuar'}
            </motion.p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-5">
            {/* Name field (sign up only) */}
            <AnimatePresence>
              {isSignUp && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-5"
                >
                  <div>
                    <label
                      className={`block text-[11px] tracking-[0.15em] uppercase mb-2 transition-colors duration-300 ${
                        focusedField === 'name' ? 'text-teal-300' : 'text-[#f8f6f1]/30'
                      }`}
                    >
                      Nome
                    </label>
                    <div className="relative group">
                      <input
                        type="text"
                        value={signUpName}
                        onChange={(e) => setSignUpName(e.target.value)}
                        onFocus={() => setFocusedField('name')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="Seu nome"
                        className="w-full bg-[#f8f6f1]/[0.03] border border-[#f8f6f1]/[0.06] rounded-xl px-4 py-3.5 text-[#f8f6f1] text-sm placeholder:text-[#f8f6f1]/15 outline-none transition-all duration-300 focus:border-teal-400/40 focus:bg-[#f8f6f1]/[0.05] focus:shadow-[0_0_0_3px_rgba(20,184,166,0.06)] hover:border-[#f8f6f1]/[0.12]"
                      />
                      <div className={`absolute bottom-0 left-4 right-4 h-[1px] bg-gradient-to-r from-teal-400/60 via-teal-300/40 to-transparent transition-transform duration-500 origin-left ${focusedField === 'name' ? 'scale-x-100' : 'scale-x-0'}`} />
                    </div>
                  </div>

                  {/* Account type toggle */}
                  <div>
                    <label className="block text-[11px] tracking-[0.15em] uppercase mb-2 text-[#f8f6f1]/30">
                      Tipo de conta
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setIsAdminSignUp(false)}
                        className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm font-medium transition-all duration-300 ${
                          !isAdminSignUp
                            ? 'border-teal-400/50 bg-teal-400/10 text-teal-300'
                            : 'border-[#f8f6f1]/[0.06] bg-[#f8f6f1]/[0.03] text-[#f8f6f1]/40 hover:border-[#f8f6f1]/[0.12]'
                        }`}
                      >
                        <User className="w-4 h-4 shrink-0" />
                        <span>Vendedor</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsAdminSignUp(true)}
                        className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm font-medium transition-all duration-300 ${
                          isAdminSignUp
                            ? 'border-teal-400/50 bg-teal-400/10 text-teal-300'
                            : 'border-[#f8f6f1]/[0.06] bg-[#f8f6f1]/[0.03] text-[#f8f6f1]/40 hover:border-[#f8f6f1]/[0.12]'
                        }`}
                      >
                        <ShieldCheck className="w-4 h-4 shrink-0" />
                        <span>Admin</span>
                      </button>
                    </div>
                    {isAdminSignUp && (
                      <p className="mt-2 text-[11px] text-teal-300/60 leading-relaxed">
                        Acesso total ao CRM. Use apenas para o primeiro cadastro da empresa.
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Email field */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.55 }}
            >
              <label
                className={`block text-[11px] tracking-[0.15em] uppercase mb-2 transition-colors duration-300 ${
                  focusedField === 'email' ? 'text-teal-300' : 'text-[#f8f6f1]/30'
                }`}
              >
                Email
              </label>
              <div className="relative group">
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="seu@email.com"
                  required
                  className="w-full bg-[#f8f6f1]/[0.03] border border-[#f8f6f1]/[0.06] rounded-xl px-4 py-3.5 text-[#f8f6f1] text-sm placeholder:text-[#f8f6f1]/15 outline-none transition-all duration-300 focus:border-teal-400/40 focus:bg-[#f8f6f1]/[0.05] focus:shadow-[0_0_0_3px_rgba(20,184,166,0.06)] hover:border-[#f8f6f1]/[0.12]"
                />
                <div className={`absolute bottom-0 left-4 right-4 h-[1px] bg-gradient-to-r from-teal-400/60 via-teal-300/40 to-transparent transition-transform duration-500 origin-left ${focusedField === 'email' ? 'scale-x-100' : 'scale-x-0'}`} />
              </div>
            </motion.div>

            {/* Password field */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.65 }}
            >
              <div className="flex items-center justify-between mb-2">
                <label
                  className={`text-[11px] tracking-[0.15em] uppercase transition-colors duration-300 ${
                    focusedField === 'password' ? 'text-teal-300' : 'text-[#f8f6f1]/30'
                  }`}
                >
                  Senha
                </label>
                <Link
                  to="/forgot-password"
                  className="text-[11px] text-[#f8f6f1]/25 hover:text-teal-300/70 transition-colors duration-300"
                >
                  Esqueceu?
                </Link>
              </div>
              <div className="relative group">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="••••••••"
                  required
                  className="w-full bg-[#f8f6f1]/[0.03] border border-[#f8f6f1]/[0.06] rounded-xl px-4 py-3.5 pr-11 text-[#f8f6f1] text-sm placeholder:text-[#f8f6f1]/15 outline-none transition-all duration-300 focus:border-teal-400/40 focus:bg-[#f8f6f1]/[0.05] focus:shadow-[0_0_0_3px_rgba(20,184,166,0.06)] hover:border-[#f8f6f1]/[0.12]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#f8f6f1]/20 hover:text-[#f8f6f1]/50 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <div className={`absolute bottom-0 left-4 right-4 h-[1px] bg-gradient-to-r from-teal-400/60 via-teal-300/40 to-transparent transition-transform duration-500 origin-left ${focusedField === 'password' ? 'scale-x-100' : 'scale-x-0'}`} />
              </div>
            </motion.div>

            {/* Submit button */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.75 }}
              className="pt-2"
            >
              <button
                type="submit"
                disabled={isLoading}
                className="w-full relative group overflow-hidden rounded-xl py-3.5 px-6 text-sm font-medium transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {/* Button gradient background */}
                <div className="absolute inset-0 bg-gradient-to-r from-teal-500 via-teal-400 to-teal-500 transition-all duration-500 group-hover:from-teal-400 group-hover:via-teal-300 group-hover:to-teal-400" />

                {/* Shimmer effect */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                </div>

                {/* Button content */}
                <span className="relative z-10 flex items-center justify-center gap-2 text-[#07070a]">
                  <AnimatePresence mode="wait">
                    {isLoading ? (
                      <motion.span
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2"
                      >
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {isSignUp ? 'Criando conta...' : 'Entrando...'}
                      </motion.span>
                    ) : (
                      <motion.span
                        key="idle"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2"
                      >
                        {isSignUp ? 'Criar conta' : 'Entrar'}
                        <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </button>
            </motion.div>
          </form>

          {/* Toggle sign up / login */}
          <motion.p
            className="text-center text-[#f8f6f1]/35 text-sm mt-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
          >
            {isSignUp ? 'Já tem uma conta?' : 'Não tem conta?'}{' '}
            <button
              type="button"
              onClick={() => { setIsSignUp(!isSignUp); setIsAdminSignUp(false); }}
              className="text-teal-300 hover:text-teal-200 transition-colors font-medium"
            >
              {isSignUp ? 'Entrar' : 'Criar conta'}
            </button>
          </motion.p>

          {/* Footer */}
          <motion.p
            className="text-center text-[#f8f6f1]/15 text-[11px] mt-6 tracking-wide"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2 }}
          >
            Plataforma protegida com criptografia de ponta a ponta
          </motion.p>
        </motion.div>
      </div>

      {/* Google Fonts */}
      <link
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@200;300;400;500;600;700;800&display=swap"
        rel="stylesheet"
      />
    </div>
  );
}

