// Service Worker bem simples – só para permitir "Adicionar à tela inicial"
const CACHE_NAME = "glm-raios-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

// Por enquanto não faz cache agressivo (os dados mudam rápido)
self.addEventListener("fetch", (event) => {
  // Deixa o navegador tratar normalmente
});
