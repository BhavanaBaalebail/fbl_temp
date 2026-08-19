/**
 * ChatWidget.jsx
 * --------------
 * Floating AI hardware assistant, styled to match the existing
 * navy / electric-blue dashboard theme (see src/utils/theme.js).
 *
 * Talks to the Flask backend's chatbot blueprint at:
 *   {LINUX_SERVER}/api/chatbot/message
 *   {LINUX_SERVER}/api/chatbot/reset
 *
 * Reuses the same LINUX_SERVER your other services already point at
 * (http://10.16.210.12:5000 by default, overridable via
 * VITE_LINUX_SERVER), so no new env var is needed.
 *
 * NOTE: bot replies come back as lightweight markdown (###, **bold**,
 * "* " bullets, "1. " numbered lists). MessageContent() below turns
 * that into real formatted JSX instead of showing raw symbols.
 */

import { useState, useRef, useEffect } from "react";
import { LINUX_SERVER } from "../../services/linuxMetricsService";
import { theme } from "../../utils/theme";

const SESSION_KEY = "fbl_chatbot_session_id";

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = "sess-" + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

const QUICK_PROMPTS = [
  "Summarize the current system health.",
  "Which component is unhealthy?",
  "Which component should I check first?",
  "What changed from before?",
  "Is the current issue real hardware or a synthetic demo?",
];

/* ---------------------------------------------------------------- *
 *  Tiny markdown renderer
 *  Handles: #### / ### / ## headers, **bold**, "* "/"- " bullets,
 *  "1. " numbered lists, and plain paragraphs. No external deps.
 * ---------------------------------------------------------------- */

function renderInline(str, keyPrefix) {
  const parts = str.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-${i}`} style={{ fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function parseMessage(text) {
  const lines = text.split("\n");
  const blocks = [];
  let listBuffer = null; // { ordered: bool, items: [] }

  function flushList() {
    if (listBuffer && listBuffer.items.length) {
      blocks.push({ type: "list", ...listBuffer });
    }
    listBuffer = null;
  }

  lines.forEach((raw) => {
    const line = raw.trim();

    if (!line) {
      flushList();
      return;
    }

    const headerMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headerMatch) {
      flushList();
      blocks.push({
        type: "header",
        level: headerMatch[1].length,
        text: headerMatch[2].replace(/\*\*/g, ""),
      });
      return;
    }

    const bulletMatch = line.match(/^[*-]\s+(.*)/);
    if (bulletMatch) {
      if (!listBuffer || listBuffer.ordered) flushList();
      if (!listBuffer) listBuffer = { ordered: false, items: [] };
      listBuffer.items.push(bulletMatch[1]);
      return;
    }

    const numberedMatch = line.match(/^\d+\.\s+(.*)/);
    if (numberedMatch) {
      if (!listBuffer || !listBuffer.ordered) flushList();
      if (!listBuffer) listBuffer = { ordered: true, items: [] };
      listBuffer.items.push(numberedMatch[1]);
      return;
    }

    flushList();
    blocks.push({ type: "para", text: line });
  });

  flushList();
  return blocks;
}

function MessageContent({ text }) {
  const blocks = parseMessage(text);

  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, i) => {
        if (block.type === "header") {
          return (
            <div
              key={i}
              className={i === 0 ? "" : "mt-1"}
              style={{
                fontWeight: 700,
                fontSize: block.level <= 2 ? "0.92rem" : "0.85rem",
              }}
            >
              {renderInline(block.text, `h${i}`)}
            </div>
          );
        }

        if (block.type === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag
              key={i}
              className={`ml-4 space-y-1 ${block.ordered ? "list-decimal" : "list-disc"}`}
            >
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>
              ))}
            </Tag>
          );
        }

        return (
          <p key={i} className="m-0">
            {renderInline(block.text, `p${i}`)}
          </p>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function Bubble({ role, text }) {
  const isUser = role === "user";
  const isError = role === "error";
  return (
    <div
      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed break-words ${
        isUser ? "self-end" : "self-start"
      }`}
      style={{
        background: isUser
          ? "rgba(34, 211, 238, 0.2)"
          : isError
            ? "rgba(239, 68, 68, 0.12)"
            : "rgba(14, 22, 34, 0.8)",
        color: isUser ? "#f1f5f9" : isError ? "#fca5a5" : "#cbd5e1",
        border: `1px solid ${isUser ? "rgba(34,211,238,0.3)" : isError ? "rgba(239,68,68,0.25)" : "rgba(34,211,238,0.1)"}`,
        borderBottomRightRadius: isUser ? 4 : undefined,
        borderBottomLeftRadius: !isUser ? 4 : undefined,
      }}
    >
      {isUser ? text : <MessageContent text={text} />}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1 self-start px-3 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: theme.electricBlue,
            animation: `fblChatBlink 1.2s ${i * 0.2}s infinite ease-in-out`,
          }}
        />
      ))}
    </div>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      if (next && messages.length === 0) {
        setMessages([
          {
            role: "system",
            text: "How can I help? I can explain live health, alerts, and telemetry for this machine.",
          },
        ]);
      }
      return next;
    });
  }

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch(`${LINUX_SERVER}/api/chatbot/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: getSessionId(), message: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "error", text: data.error || "Something went wrong." },
        ]);
      } else {
        setMessages((prev) => [...prev, { role: "bot", text: data.reply }]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "error", text: "Could not reach the assistant backend at " + LINUX_SERVER },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function resetConversation() {
    const sessionId = getSessionId();
    localStorage.removeItem(SESSION_KEY);
    setMessages([{ role: "system", text: "Conversation reset." }]);
    try {
      await fetch(`${LINUX_SERVER}/api/chatbot/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (e) {
      /* non-fatal */
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <>
      <style>{`
        @keyframes fblChatBlink {
          0%, 80%, 100% { opacity: 0.3; }
          40% { opacity: 1; }
        }
      `}</style>

      <button
        onClick={toggleOpen}
        title="Ask Assistant"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full transition-transform hover:scale-105"
        style={{
          background: "linear-gradient(145deg, rgba(8,145,178,0.5), rgba(34,211,238,0.25))",
          border: "1px solid rgba(34, 211, 238, 0.35)",
          boxShadow: "0 0 24px rgba(34, 211, 238, 0.2)",
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 flex w-[380px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl"
          style={{
            height: 540,
            maxHeight: "calc(100vh - 140px)",
            background: "rgba(10, 14, 20, 0.95)",
            border: "1px solid rgba(34, 211, 238, 0.2)",
            boxShadow: "0 16px 48px rgba(0, 0, 0, 0.5), 0 0 40px rgba(34, 211, 238, 0.08)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ background: theme.headerGradient, borderColor: "rgba(34,211,238,0.1)" }}
          >
            <div>
              <div className="text-sm font-semibold text-[#f1f5f9]">Assistant</div>
              <div className="text-xs text-[#64748b]">
                live telemetry
              </div>
            </div>
            <div className="flex gap-1">
              <button
                onClick={resetConversation}
                title="Reset conversation"
                className="rounded px-1.5 text-lg leading-none text-white/70 hover:text-white"
              >
                &#8635;
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                className="rounded px-1.5 text-xl leading-none text-white/70 hover:text-white"
              >
                &times;
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
            style={{ background: "rgba(8, 12, 18, 0.6)" }}
          >
            {messages.map((m, i) =>
              m.role === "system" ? (
                <div key={i} className="self-center text-center text-xs italic text-[#64748b]">
                  {m.text}
                </div>
              ) : (
                <Bubble key={i} role={m.role} text={m.text} />
              )
            )}
            {sending && <TypingDots />}
          </div>

          <div className="flex flex-wrap gap-1.5 border-t px-3 py-2" style={{ borderColor: "rgba(34,211,238,0.1)", background: "rgba(10,14,20,0.9)" }}>
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                className="rounded-full border px-2.5 py-1 text-xs text-[#94a3b8] transition-colors hover:border-cyan-500/30 hover:text-[#22d3ee]"
                style={{ borderColor: "rgba(34,211,238,0.15)" }}
              >
                {q.length > 28 ? q.slice(0, 26) + "…" : q}
              </button>
            ))}
          </div>

          <div className="flex gap-2 border-t p-2.5" style={{ borderColor: "rgba(34,211,238,0.1)", background: "rgba(10,14,20,0.95)" }}>
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about CPU, RAM, Disk, NIC..."
              className="max-h-20 flex-1 resize-none rounded-lg border px-2.5 py-2 text-sm text-[#f1f5f9] outline-none"
              style={{ borderColor: "rgba(34,211,238,0.15)", background: "rgba(8,12,18,0.8)" }}
            />
            <button
              onClick={() => send(input)}
              disabled={sending || !input.trim()}
              className="hw-btn-primary !px-3 !py-2 text-sm disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}