import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, FileText, X } from "lucide-react";
import type { Attachment } from "@disc-voice/shared";
import { mediaUrl } from "../lib/api";
import { openExternal } from "../lib/external";

/** Something shown in the media viewer. */
export interface Media {
  url: string;
  name: string;
  kind: "image" | "video";
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "code"; text: string }
  | { kind: "codeblock"; text: string }
  | { kind: "bold" | "italic" | "strike"; children: Segment[] };

const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[^\n]+?\*\*)|(~~(?=\S)[^\n]+?~~)|(\*(?=[^\s*])[^*\n]+?\*)|(https?:\/\/[^\s<>]+)/g;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif)$/i;

/** Drops punctuation that ends a sentence rather than the link. */
function trimUrl(url: string) {
  let end = url;
  const unbalanced = () => end.endsWith(")") && (end.match(/\(/g)?.length || 0) < (end.match(/\)/g)?.length || 0);
  while (/[.,!?;:'"]$/.test(end) || unbalanced()) end = end.slice(0, -1);
  return end;
}

function parseInline(text: string): Segment[] {
  const out: Segment[] = [];
  const push = (value: string) => {
    if (!value) return;
    const last = out.at(-1);
    if (last?.kind === "text") last.text += value; else out.push({ kind: "text", text: value });
  };
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [token, code, bold, strike, italic, url] = match;
    push(text.slice(last, match.index));
    if (code) out.push({ kind: "code", text: code.slice(1, -1) });
    else if (bold) out.push({ kind: "bold", children: parseInline(bold.slice(2, -2)) });
    else if (strike) out.push({ kind: "strike", children: parseInline(strike.slice(2, -2)) });
    else if (italic) out.push({ kind: "italic", children: parseInline(italic.slice(1, -1)) });
    else if (url) {
      const clean = trimUrl(url);
      out.push({ kind: "link", url: clean });
      push(url.slice(clean.length));
    }
    last = match.index! + token.length;
  }
  push(text.slice(last));
  return out;
}

/** Message text as segments: links, code and the basic Discord markdown. */
export function parseMessage(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(/```(?:[\w+-]*\n)?([\s\S]*?)```/g)) {
    out.push(...parseInline(text.slice(last, match.index)));
    out.push({ kind: "codeblock", text: match[1].replace(/\n$/, "") });
    last = match.index! + match[0].length;
  }
  out.push(...parseInline(text.slice(last)));
  return out;
}

/** Links in the text that point straight to an image. */
export function imageLinks(text: string) {
  const links = new Set<string>();
  const walk = (segments: Segment[]) => segments.forEach(segment => {
    if (segment.kind === "link") {
      try { if (IMAGE_PATH.test(new URL(segment.url).pathname)) links.add(segment.url); } catch { /* not a URL */ }
    } else if ("children" in segment) walk(segment.children);
  });
  walk(parseMessage(text));
  return [...links].slice(0, 4);
}

function render(segments: Segment[]): ReactNode {
  return segments.map((segment, index) => {
    switch (segment.kind) {
      case "text": return <Fragment key={index}>{segment.text}</Fragment>;
      case "code": return <code key={index} className="inline-code">{segment.text}</code>;
      case "codeblock": return <pre key={index} className="message-code"><code>{segment.text}</code></pre>;
      case "bold": return <strong key={index}>{render(segment.children)}</strong>;
      case "italic": return <em key={index}>{render(segment.children)}</em>;
      case "strike": return <s key={index}>{render(segment.children)}</s>;
      case "link": return <a key={index} href={segment.url} className="message-link" title={segment.url} target="_blank" rel="noopener noreferrer"
        onClick={event => { event.preventDefault(); void openExternal(segment.url); }}>{segment.url}</a>;
    }
  });
}

export function MessageText({ text }: { text: string }) {
  return <div className="message-text">{render(parseMessage(text))}</div>;
}

export function mediaKind(file: Attachment): "image" | "video" | "audio" | "file" {
  if (file.unavailable) return "file";
  const type = file.contentType?.toLowerCase() || "";
  const extension = file.filename.split(".").pop()?.toLowerCase() || "";
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(type) || (!type && ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension))) return "image";
  if (/^video\/(mp4|webm|ogg)$/.test(type) || (!type && ["mp4", "webm"].includes(extension))) return "video";
  if (/^audio\/(mpeg|ogg|wav|webm|mp4)$/.test(type) || (!type && ["mp3", "ogg", "wav"].includes(extension))) return "audio";
  return "file";
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

/** Keeps the thumbnail's box while the image loads. */
function thumbStyle(width?: number | null, height?: number | null) {
  if (!width || !height) return undefined;
  const scale = Math.min(1, 400 / width, 300 / height);
  return { width: Math.round(width * scale), aspectRatio: `${width} / ${height}` };
}

function FileCard({ file }: { file: Attachment }) {
  const url = mediaUrl(file.url);
  return <a className="file-card" href={url} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void openExternal(url); }}
    title={file.unavailable ? "Não foi possível copiar este arquivo do Discord; o link original pode ter expirado." : `Abrir ${file.filename}`}>
    <FileText size={22} aria-hidden="true" />
    <span><strong>{file.filename}</strong><small>{fileSize(file.size)}{file.unavailable ? " · pode ter expirado" : ""}</small></span>
  </a>;
}

export function ImageThumb({ url, name, width, height, onView }: { url: string; name: string; width?: number | null; height?: number | null; onView: (media: Media) => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <button type="button" className="media-thumb" style={thumbStyle(width, height)} aria-label={`Ver imagem ${name}`} onClick={() => onView({ url, name, kind: "image" })}>
    <img src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </button>;
}

export function Attachments({ files, onView }: { files: Attachment[]; onView: (media: Media) => void }) {
  return <div className="attachment-list" aria-label="Anexos">
    {files.map(file => {
      const url = mediaUrl(file.url);
      const kind = mediaKind(file);
      if (kind === "image") return <ImageThumb key={file.id} url={url} name={file.filename} width={file.width} height={file.height} onView={onView} />;
      if (kind === "video") return <div key={file.id} className="media-video">
        <video src={url} controls preload="metadata" style={thumbStyle(file.width, file.height)} aria-label={file.filename} />
        <button type="button" className="link-button subtle" onClick={() => onView({ url, name: file.filename, kind: "video" })}>Ampliar</button>
      </div>;
      if (kind === "audio") return <div key={file.id} className="media-audio"><small>{file.filename}</small><audio src={url} controls preload="metadata" aria-label={file.filename} /></div>;
      return <FileCard key={file.id} file={file} />;
    })}
  </div>;
}

/** Shows an image or video in the app, over everything else. */
export function MediaViewer({ media, onClose }: { media: Media; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="media-viewer" aria-label={media.name}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header>
      <span title={media.name}>{media.name}</span>
      <button type="button" className="icon-button" aria-label="Abrir no navegador" title="Abrir no navegador" onClick={() => void openExternal(media.url)}><ExternalLink size={18} /></button>
      <button type="button" className="icon-button" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}><X size={20} /></button>
    </header>
    {media.kind === "image"
      ? <img src={media.url} alt={media.name} referrerPolicy="no-referrer" />
      : <video src={media.url} controls autoPlay aria-label={media.name} />}
  </dialog>;
}
