import { MessageCircle, Plus, Search, Users } from "lucide-react";
import { SoonTag } from "./ui";

/** Direct messages and friends: layout only until the feature exists in the API. */
export function DirectMessagesSidebar() {
  return <aside className="sidebar" aria-label="Mensagens diretas">
    <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="dm-search">Encontrar conversa</label><input id="dm-search" className="search-input" disabled placeholder="Encontrar conversa" /></div>
    <button className="channel-item" disabled><Users size={18} /><span>Amigos</span></button>
    <div className="section-heading"><span>Mensagens diretas</span><button className="icon-button small" disabled aria-label="Nova mensagem direta (em breve)"><Plus size={17} /></button></div>
    <p className="sidebar-status">Suas conversas privadas aparecem aqui.</p>
  </aside>;
}

export function DirectMessages() {
  return <main className="dm-main">
    <div className="empty-state">
      <span className="empty-icon"><MessageCircle size={34} /></span>
      <h1>Mensagens diretas</h1>
      <p>Converse em particular com amigos e pessoas dos seus servidores. Essa área está sendo construída.</p>
      <SoonTag />
    </div>
  </main>;
}
