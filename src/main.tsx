import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { patchAudioWorkletForWavoip } from "./lib/wavoip-init";
import { installErrorBuffer } from "./lib/errorBuffer";

// Aplica patch no AudioWorklet antes de qualquer import do SDK WaVoIP rodar.
patchAudioWorkletForWavoip();

// Ring buffer de erros do frontend — o report de melhorias anexa os erros
// recentes sozinho ("já pega o log do erro"). Instalar ANTES do app montar.
installErrorBuffer();

// Quando um chunk lazy falha (index.html cacheado com hashes antigos após deploy),
// recarrega a página para buscar o index.html novo e os chunks corretos.
window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
