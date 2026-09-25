import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { CloseIcon, SendIcon, SparkleIcon } from './icons.jsx';

const SUGGESTIONS = ['What bundles do you offer?', 'What comes in the Center of Excellence bundle?', 'Help me choose products for a breast imaging clinic'];

// **bold** inside a line
const inline = (text) =>
  text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));

// Just enough formatting for the assistant's answers (bold, bullet lists, paragraphs) - always rendered as text, never as HTML.
function Answer({ text }) {
  const blocks = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    // a markdown table row becomes a bullet (its header row and the --- divider row are dropped)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line) || /^[\s|:-]+$/.test(lines[n + 1] ?? '')) continue;
      line = `- ${line.split('|').map((c) => c.trim()).filter(Boolean).join(' — ')}`;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(bullet[1]);
      else blocks.push({ type: 'ul', items: [bullet[1]] });
    } else if (line.trim()) blocks.push({ type: 'p', text: line.trim() });
  }
  return blocks.map((b, i) =>
    b.type === 'ul' ? (
      <ul key={i}>
        {b.items.map((it, j) => (
          <li key={j}>{inline(it)}</li>
        ))}
      </ul>
    ) : (
      <p key={i}>{inline(b.text)}</p>
    ),
  );
}

// AI shopping assistant. Shown only when the server has an Anthropic key configured (/api/health -> chat).
export default function ChatWidget() {
  const { items } = useCart();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // { role: 'user' | 'assistant' | 'error', content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api
      .health()
      .then((h) => setEnabled(!!h?.chat))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, busy, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!enabled) return null;

  const send = async (text) => {
    const content = text.trim();
    if (!content || busy) return;
    const history = [...messages.filter((m) => m.role !== 'error'), { role: 'user', content }];
    setMessages((m) => [...m, { role: 'user', content }]);
    setInput('');
    setBusy(true);
    try {
      const { reply } = await api.chat(history, items.map(({ name, quantity }) => ({ name, quantity })));
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: err.message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        <button className="chat-fab" onClick={() => setOpen(true)} aria-label="Ask the AI assistant">
          <SparkleIcon width={20} height={20} />
          <span>Ask AI</span>
        </button>
      )}

      {open && (
        <section className="chat-panel" aria-label="AI assistant" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <header className="chat-head">
            <span className="chat-title">
              <SparkleIcon />
              DeepHealth AI Assistant
            </span>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close assistant">
              <CloseIcon />
            </button>
          </header>

          <div className="chat-body" ref={bodyRef} aria-live="polite">
            <div className="chat-msg assistant">
              <p>Hi! I can help you explore DeepHealth products, bundles and pricing. What are you looking for?</p>
            </div>
            {messages.length === 0 && (
              <div className="chat-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div className={`chat-msg ${m.role}`} key={i}>
                {m.role === 'assistant' ? <Answer text={m.content} /> : <p>{m.content}</p>}
              </div>
            ))}
            {busy && (
              <div className="chat-msg assistant typing" aria-label="The assistant is typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              ref={inputRef}
              value={input}
              maxLength={600}
              placeholder="Ask about products, bundles, prices…"
              onChange={(e) => setInput(e.target.value)}
              aria-label="Your question"
            />
            <button className="chat-send" type="submit" disabled={busy || !input.trim()} aria-label="Send">
              <SendIcon />
            </button>
          </form>
          <p className="chat-note">AI answers come from the live Salesforce catalog and may contain mistakes.</p>
        </section>
      )}
    </>
  );
}
