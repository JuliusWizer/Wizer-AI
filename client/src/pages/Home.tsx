import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Check, ChevronDown, Copy, Camera, FileUp, LogIn, Menu, Mic, PanelLeft, PanelLeftClose, Plus, Sparkles, Trash2, UserRound, Volume2, VolumeX, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { trpc } from "@/lib/trpc";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Chat = { id: string; title: string; messages: ChatMessage[]; updatedAt: number };
type Language = "auto" | "en" | "sw" | "ko" | "fr" | "zh" | "ar";
type PendingAttachment = { name: string; mimeType: string; dataUrl: string };

const STORAGE_KEY = "wizer-ai-chats-v1";
const suggestions = ["Explain artificial intelligence", "Help me learn Python", "Explain machine learning", "Help me write a project proposal"];
const languages: { value: Language; label: string; native: string }[] = [
  { value: "auto", label: "Auto-detect", native: "Auto · English default" },
  { value: "en", label: "English", native: "English" },
  { value: "sw", label: "Swahili", native: "Kiswahili" },
  { value: "ko", label: "Korean", native: "한국어" },
  { value: "fr", label: "French", native: "Français" },
  { value: "zh", label: "Chinese", native: "中文" },
  { value: "ar", label: "Arabic", native: "العربية" },
];

function loadChats(): Chat[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}

export default function Home() {
  const [chats, setChats] = useState<Chat[]>(loadChats);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [language, setLanguage] = useState<Language>("auto");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const speak = trpc.chat.speak.useMutation();
  const authMe = trpc.auth.me.useQuery(undefined, { retry: false });
  const authLogin = trpc.auth.login.useMutation();
  const authRegister = trpc.auth.register.useMutation();
  const updateAvatar = trpc.auth.updateAvatar.useMutation();
  const authLogout = trpc.auth.logout.useMutation();
  const utils = trpc.useUtils();
  const activeChat = chats.find(item => item.id === activeId);
  const messages = activeChat?.messages || [];

  const cloudChats = trpc.chat.list.useQuery(undefined, { enabled: Boolean(authMe.data), retry: false });
  const upsertCloudChat = trpc.chat.upsert.useMutation();
  const deleteCloudChat = trpc.chat.delete.useMutation();
  const deleteAllCloudChats = trpc.chat.deleteAll.useMutation();
  const migratedUserRef = useRef<number | null>(null);

  useEffect(() => {
    if (!authMe.data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    }
  }, [chats, authMe.data?.id]);

  useEffect(() => {
    const userId = authMe.data?.id;
    if (!userId || !cloudChats.data || migratedUserRef.current === userId) return;
    migratedUserRef.current = userId;
    const localChats = loadChats();
    const sync = async () => {
      if (cloudChats.data.length === 0 && localChats.length > 0) {
        for (const item of localChats) {
          await upsertCloudChat.mutateAsync({ id: item.id, title: item.title, messages: item.messages });
        }
        setChats(localChats);
        await cloudChats.refetch();
      } else {
        setChats(cloudChats.data);
        setActiveId(current => current && cloudChats.data.some(item => item.id === current) ? current : null);
      }
      localStorage.removeItem(STORAGE_KEY);
    };
    void sync();
  }, [authMe.data?.id, cloudChats.data, cloudChats.refetch, upsertCloudChat]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isStreaming]);

  const updateChat = (id: string, updater: (item: Chat) => Chat) => setChats(current => current.map(item => item.id === id ? updater(item) : item));
  const newChat = () => { setActiveId(null); setDraft(""); setStreamError(""); setSidebarOpen(false); setTimeout(() => inputRef.current?.focus(), 0); };
  const selectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) { setMediaError("Files must be 16 MB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = () => { setAttachment({ name: file.name, mimeType: file.type || "application/octet-stream", dataUrl: String(reader.result) }); setMediaError(""); };
    reader.onerror = () => setMediaError("Could not read that file.");
    reader.readAsDataURL(file);
  };
  const toggleRecording = async () => {
    setMediaError("");
    if (isRecording) { recorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            setMediaError("Converting voice to text…");
            const response = await fetch("/api/voice/transcribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({ dataUrl: String(reader.result), language }),
            });
            const result = await response.json() as { text?: string; error?: string };
            if (!response.ok || !result.text) throw new Error(result.error || "No speech was detected.");
            setDraft(current => current ? `${current} ${result.text}` : result.text || "");
            setMediaError("");
          } catch (error) {
            setMediaError(error instanceof Error ? error.message : "Voice transcription failed. Please try again.");
          }
        };
        reader.readAsDataURL(blob);
        setIsRecording(false);
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch { setMediaError("Microphone access was not available. Check your browser permission."); }
  };
  const removeChat = (id: string) => {
    setChats(current => current.filter(item => item.id !== id));
    if (authMe.data) void deleteCloudChat.mutateAsync({ id });
    if (activeId === id) newChat();
  };
  const removeAll = () => {
    setChats([]); setActiveId(null); setStreamError("");
    if (authMe.data) void deleteAllCloudChats.mutateAsync();
    else localStorage.removeItem(STORAGE_KEY);
  };

  const send = async (value?: string) => {
    const message = (value ?? draft).trim() || (attachment ? "Please analyze the attached file." : "");
    if (!message || isStreaming) return;
    setDraft(""); setStreamError("");
    const pendingAttachment = attachment;
    setAttachment(null);
    const id = activeId || crypto.randomUUID();
    const current = chats.find(item => item.id === id);
    const nextMessages = [...(current?.messages || []), { role: "user" as const, content: message }];
    const nextChat: Chat = { id, title: current?.title || message.slice(0, 34), messages: nextMessages, updatedAt: Date.now() };
    setActiveId(id);
    setChats(currentChats => currentChats.some(item => item.id === id) ? currentChats.map(item => item.id === id ? nextChat : item) : [nextChat, ...currentChats]);
    setIsStreaming(true);
    let assistant = "";
    let assistantStarted = false;
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        credentials: "same-origin",
        body: JSON.stringify({ conversationId: id, title: nextChat.title, message, history: current?.messages || [], language, attachments: pendingAttachment ? [pendingAttachment] : [] }),
      });
      if (!response.ok || !response.body) throw new Error("The AI stream could not be started.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (block: string) => {
        const data = block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim();
        if (!data) return;
        const event = JSON.parse(data) as { type: "start" | "delta" | "done" | "error"; text?: string; message?: string };
        if (event.type === "delta" && event.text) {
          assistant += event.text;
          assistantStarted = true;
          updateChat(id, item => ({ ...item, messages: [...nextMessages, { role: "assistant", content: assistant }], updatedAt: Date.now() }));
        }
        if (event.type === "error") throw new Error(event.message || "The AI could not complete this response.");
      };
      while (true) {
        const { value: chunk, done } = await reader.read();
        buffer += decoder.decode(chunk || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) handleEvent(block);
        if (done) break;
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!assistantStarted) throw new Error("The AI returned an empty response.");
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "Wizer AI could not answer right now.");
      if (!assistantStarted) updateChat(id, item => ({ ...item, messages: nextMessages, updatedAt: Date.now() }));
    } finally {
      setIsStreaming(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const playAudio = async (text: string, index: number) => {
    if (speakingIndex === index) { speak.reset(); setSpeakingIndex(null); return; }
    setSpeakingIndex(index);
    try { const result = await speak.mutateAsync({ text, language: language === "auto" ? "en" : language }); const audio = new Audio(result.audio); audio.onended = () => setSpeakingIndex(null); await audio.play(); }
    catch { setSpeakingIndex(null); }
  };
  const copy = async (content: string, index: number) => { await navigator.clipboard?.writeText(content); setCopied(index); setTimeout(() => setCopied(null), 1400); };
  const submitAuth = async (event: React.FormEvent) => {
    event.preventDefault(); setAuthError("");
    try {
      const result = authMode === "login"
        ? await authLogin.mutateAsync({ email: authEmail, password: authPassword })
        : await authRegister.mutateAsync({ name: authName, email: authEmail, password: authPassword });
      utils.auth.me.setData(undefined, result);
      await utils.auth.me.invalidate();
      setAuthOpen(false); setAuthName(""); setAuthEmail(""); setAuthPassword("");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Unable to complete authentication."); }
  };
  const signOut = async () => {
    await authLogout.mutateAsync();
    try { sessionStorage.removeItem("manus-cookie"); } catch {}
    try { localStorage.removeItem("manus-runtime-user-info"); } catch {}
    utils.auth.me.setData(undefined, null);
    await utils.auth.me.invalidate();
    migratedUserRef.current = null;
    setChats([]);
    setActiveId(null);
    localStorage.removeItem(STORAGE_KEY);
    setProfileOpen(false);
  };
  const openAuth = (mode: "login" | "register") => {
    setAuthMode(mode); setAuthError(""); setProfileOpen(false); setAuthOpen(true);
  };
  const initials = (name?: string | null) => (name || "Guest").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "G";
  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setAvatarError("");
    if (!file.type.match(/^image\/(png|jpeg|webp)$/)) { setAvatarError("Use a PNG, JPG, or WebP image."); return; }
    if (file.size > 1_000_000) { setAvatarError("Profile images must be 1 MB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await updateAvatar.mutateAsync({ dataUrl: String(reader.result) });
        utils.auth.me.setData(undefined, result);
        setAvatarError("");
      } catch (error) { setAvatarError(error instanceof Error ? error.message : "Could not upload the profile image."); }
    };
    reader.onerror = () => setAvatarError("Could not read that image.");
    reader.readAsDataURL(file);
  };

  return <div className="min-h-screen bg-[#101015] text-[#e8e8ee]" style={{ fontFamily: "'DM Sans', sans-serif" }}>
    <div className="flex min-h-screen">
      {sidebarOpen && <button aria-label="Close menu" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-20 bg-black/60 md:hidden" />}
      <aside className={`fixed inset-y-0 left-0 z-30 flex w-[270px] flex-col border-r border-white/[.08] bg-[#121218] px-[22px] py-7 transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"} ${historyVisible ? "" : "md:hidden"}`}>
        <div className="flex items-center gap-2.5"><div className="grid h-7 w-7 place-items-center rounded-lg bg-[#b8f35a] text-[#101015]"><Sparkles size={16} strokeWidth={2.5} /></div><span className="text-lg font-bold tracking-[-.06em]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Wizer <em className="not-italic text-[#b8f35a]">AI</em></span><button onClick={() => setSidebarOpen(false)} aria-label="Close navigation" className="ml-auto text-[#92929f] md:hidden"><X size={18} /></button></div>
        <button onClick={newChat} className="mt-9 flex h-11 items-center justify-center gap-2 rounded-xl bg-[#b8f35a] text-sm font-bold text-[#101015] transition hover:-translate-y-0.5 hover:bg-[#d2ff8b]"><Plus size={17} /> New chat</button>
        <div className="sticky top-0 z-10 mt-7 flex items-center justify-between bg-[#121218] py-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#5e5e6d]"><span>Chat history</span>{chats.length > 0 && <button onClick={removeAll} className="normal-case tracking-normal text-[#777783] transition hover:text-red-300">Delete all</button>}</div>
        <div className="mt-3 flex-1 space-y-1 overflow-y-auto">{chats.length === 0 ? <p className="py-4 text-[11px] leading-relaxed text-[#5e5e6d]">Your saved chats will appear here.</p> : chats.map(item => <div key={item.id} className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${item.id === activeId ? "bg-[#24242c] text-white" : "text-[#92929f] hover:bg-[#1b1b22] hover:text-white"}`}><button onClick={() => { setActiveId(item.id); setSidebarOpen(false); }} className="min-w-0 flex-1 truncate">{item.title}</button><button onClick={() => removeChat(item.id)} aria-label={`Delete ${item.title}`} className="shrink-0 text-[#5e5e6d] opacity-0 transition hover:text-red-300 group-hover:opacity-100"><Trash2 size={13} /></button></div>)}</div>
        <button onClick={() => setProfileOpen(value => !value)} className="flex items-center gap-2.5 border-t border-white/[.08] py-4 text-left transition hover:text-white"><div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[#282832] text-[10px] font-bold text-[#b8f35a]">{authMe.data?.avatarUrl ? <img src={authMe.data.avatarUrl} alt="Your profile" className="h-full w-full object-cover" /> : initials(authMe.data?.name)}</div><div className="min-w-0"><strong className="block truncate text-xs">{authMe.data?.name || authMe.data?.email || "Guest profile"}</strong><span className="mt-0.5 block truncate text-[10px] text-[#92929f]">{authMe.data?.email || "Sign in to personalize your profile"}</span></div></button><p className="text-[11px] leading-relaxed text-[#5e5e6d]">Your profile and chats<br />are private to your account.</p>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-white/[.08] bg-[#101015]/95 px-[18px] backdrop-blur md:h-[76px] md:px-[46px]"><button onClick={() => setSidebarOpen(true)} aria-label="Open navigation" className="mr-3 text-[#92929f] md:hidden"><Menu size={20} /></button><button onClick={() => setHistoryVisible(value => !value)} aria-label={historyVisible ? "Hide chat history" : "Show chat history"} title={historyVisible ? "Hide chat history" : "Show chat history"} className="mr-3 hidden text-[#92929f] transition hover:text-white md:block">{historyVisible ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}</button><div className="flex items-center gap-2 md:hidden"><div className="grid h-6 w-6 place-items-center rounded-lg bg-[#b8f35a] text-[#101015]"><Sparkles size={14} /></div><span className="font-bold tracking-[-.05em]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Wizer <em className="not-italic text-[#b8f35a]">AI</em></span></div><div className="ml-auto flex items-center gap-3"><div className="flex items-center gap-2 rounded-full border border-white/[.09] bg-[#17171f] px-3 py-1.5 text-[11px] text-[#92929f]"><span className="h-1.5 w-1.5 rounded-full bg-[#b8f35a] shadow-[0_0_10px_#b8f35a]" /> Online</div><button onClick={() => setProfileOpen(value => !value)} aria-label="Open profile menu" className="flex items-center gap-1.5 text-[11px] text-[#92929f] transition hover:text-white"><div className="grid h-6 w-6 place-items-center overflow-hidden rounded-full bg-[#282832] text-[9px] font-bold text-[#b8f35a]">{authMe.data?.avatarUrl ? <img src={authMe.data.avatarUrl} alt="Your profile" className="h-full w-full object-cover" /> : authMe.data ? initials(authMe.data.name) : <UserRound size={13} />}</div><span className="hidden max-w-[120px] truncate sm:inline">{authMe.data?.name || "Profile"}</span></button></div></header>
        <section className="flex min-h-0 flex-1 justify-center overflow-y-auto">
          {!messages.length ? <div className="w-full max-w-3xl px-5 pb-16 pt-[10vh] text-center md:pt-[14vh]"><div className="mx-auto mb-7 grid h-16 w-16 rotate-[-8deg] place-items-center rounded-[22px] bg-gradient-to-br from-[#b8f35a]/25 to-[#8ce7c3]/10"><div className="grid h-12 w-12 rotate-[8deg] place-items-center rounded-2xl bg-[#24272b] text-[#b8f35a]"><Bot size={29} strokeWidth={1.6} /></div></div><p className="mb-4 text-[10px] font-bold tracking-[.2em] text-[#b8f35a]">YOUR THOUGHTFUL AI ASSISTANT</p><h1 className="text-[42px] font-bold leading-[1.03] tracking-[-.07em] text-[#f4f4f6] md:text-[58px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>How can I help<br /><span className="text-[#777783]">you today?</span></h1><p className="mx-auto my-5 max-w-xl text-sm leading-relaxed text-[#92929f]">Ask me anything. Learn something new, work through a problem, or turn your ideas into something real.</p><div className="mx-auto flex max-w-2xl flex-wrap justify-center gap-2">{suggestions.map(item => <button key={item} onClick={() => void send(item)} className="flex items-center gap-2 rounded-lg border border-white/[.09] bg-[#1d1d25]/70 px-3 py-2.5 text-[11px] text-[#b7b7c1] transition hover:-translate-y-0.5 hover:border-[#b8f35a]/40 hover:text-white">{item}<ArrowUp size={14} className="text-[#73737d]" /></button>)}</div></div>
          : <div className="w-full max-w-[790px] px-[18px] pb-32 pt-8 md:px-[30px]">{messages.map((message, index) => <div key={`${index}-${message.content.slice(0, 10)}`} className={`mb-8 flex w-full gap-3 ${message.role === "user" ? "flex-row-reverse justify-start text-right" : "justify-start text-left"}`}><div className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg text-[9px] font-bold ${message.role === "assistant" ? "bg-[#b8f35a] text-[#101015]" : "bg-[#282831] text-[#aaa]"}`}>{message.role === "assistant" ? <Sparkles size={16} /> : "You"}</div><div className={`min-w-0 max-w-[82%] ${message.role === "assistant" ? "mr-auto" : "ml-auto"}`}><div className="mb-2 text-[11px] font-bold text-[#ddd]">{message.role === "assistant" ? "Wizer AI" : "You"}</div><div className="prose prose-invert max-w-none text-sm leading-7 text-[#c5c5ce]"><Streamdown>{message.content}</Streamdown>{isStreaming && message.role === "assistant" && index === messages.length - 1 && <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-[#b8f35a] align-middle" />}</div><div className={`mt-2 flex items-center gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}><button disabled={isStreaming && message.role === "assistant" && index === messages.length - 1} onClick={() => void playAudio(message.content, index)} className="flex items-center gap-1 text-[10px] text-[#676773] transition hover:text-[#b8f35a] disabled:opacity-30">{speakingIndex === index ? <VolumeX size={13} /> : <Volume2 size={13} />} {speakingIndex === index ? "Stop audio" : "Listen"}</button>{message.role === "assistant" && <button onClick={() => void copy(message.content, index)} className="flex items-center gap-1 text-[10px] text-[#676773] transition hover:text-[#b8f35a]">{copied === index ? <Check size={13} /> : <Copy size={13} />} {copied === index ? "Copied" : "Copy"}</button>}</div></div></div>)}{isStreaming && (!messages.length || messages[messages.length - 1]?.role === "user") && <div className="flex gap-3"><div className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-[#b8f35a] text-[#101015]"><Sparkles size={16} /></div><div className="pt-2 text-xs text-[#92929f]">Wizer AI is starting<span className="ml-1 animate-pulse text-[#b8f35a]">···</span></div></div>}<div ref={messagesEndRef} /></div>}
        </section>
        <div className="mx-auto w-[calc(100%-36px)] max-w-[790px] pb-5">{streamError && <div className="mb-2 flex items-center justify-between rounded-lg border border-red-300/20 bg-red-300/10 px-3 py-2 text-[11px] text-red-200"><span>{streamError}</span><button onClick={() => setStreamError("")}><X size={15} /></button></div>}<form onSubmit={event => { event.preventDefault(); void send(); }} className="rounded-[14px] border border-[#34343e] bg-[#191920] p-3.5 shadow-2xl transition focus-within:border-[#b8f35a]/40"><div className="mb-3 flex items-center gap-2"><label htmlFor="language" className="text-[10px] text-[#676773]">Respond in</label><div className="relative"><select id="language" value={language} onChange={event => setLanguage(event.target.value as Language)} className="appearance-none rounded-md border border-white/[.08] bg-[#24242c] py-1 pl-2 pr-7 text-[10px] text-[#c5c5ce] outline-none"><option value="auto">Auto-detect · English default</option>{languages.filter(item => item.value !== "auto").map(item => <option key={item.value} value={item.value}>{item.native}</option>)}</select><ChevronDown size={12} className="pointer-events-none absolute right-2 top-1.5 text-[#92929f]" /></div><span className="ml-auto text-[10px] text-[#5e5e6d]">Live response streaming enabled</span></div><input ref={fileInputRef} type="file" accept=".pdf,.txt,.csv,.json,.md,.xml,.sql,.js,.ts,.py,image/*,audio/*" onChange={selectFile} className="hidden" />{attachment && <div className="mb-2 flex items-center gap-2 rounded-lg border border-[#b8f35a]/20 bg-[#b8f35a]/5 px-2.5 py-2 text-[11px] text-[#c5c5ce]"><FileUp size={14} className="text-[#b8f35a]" /><span className="min-w-0 flex-1 truncate">{attachment.name}</span><button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment" className="text-[#92929f] hover:text-white"><X size={14} /></button></div>}{mediaError && <p className="mb-2 text-[10px] text-red-200">{mediaError}</p>}<textarea ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} rows={1} disabled={isStreaming} placeholder="Message Wizer AI..." className="block max-h-32 min-h-8 w-full resize-none border-0 bg-transparent px-0.5 pb-2 text-sm leading-6 text-white outline-none placeholder:text-[#676773]" /><div className="flex items-center justify-end"><div className="mr-auto flex items-center gap-1"><button type="button" onClick={() => fileInputRef.current?.click()} disabled={isStreaming} aria-label="Attach a file" title="Attach PDF, text, CSV, image, or audio" className="grid h-8 w-8 place-items-center rounded-full border border-white/[.12] text-[#92929f] transition hover:bg-[#24242c] hover:text-[#b8f35a] disabled:opacity-30"><Plus size={17} /></button><button type="button" onClick={() => void toggleRecording()} disabled={isStreaming} aria-label={isRecording ? "Stop recording" : "Record voice message"} title={isRecording ? "Stop recording" : "Record voice message"} className={`grid h-8 w-8 place-items-center rounded-lg transition ${isRecording ? "bg-red-400/20 text-red-200" : "text-[#92929f] hover:bg-[#24242c] hover:text-[#b8f35a]"} disabled:opacity-30`}><Mic size={16} /></button></div><span className="mr-auto hidden text-[10px] text-[#5d5d68] sm:inline">Press <kbd className="rounded border border-[#383841] px-1 py-0.5">Enter</kbd> to send · <kbd className="rounded border border-[#383841] px-1 py-0.5">Shift + Enter</kbd> for a new line</span><button disabled={(!draft.trim() && !attachment) || isStreaming} className="grid h-8 w-8 place-items-center rounded-lg bg-[#b8f35a] text-[#15151a] transition hover:-translate-y-0.5 hover:bg-[#d4ff8b] disabled:cursor-not-allowed disabled:opacity-30" aria-label="Send message"><ArrowUp size={18} /></button></div></form><p className="mt-2 text-center text-[10px] text-[#575762]">{authMe.data ? "Chats are saved securely to your account." : "Chats are saved on this device until you sign in."} Wizer AI can make mistakes.</p></div>
        <footer className="flex h-12 items-center justify-center gap-3 px-4 text-center text-[10px] text-[#50505c]"><span>Created by Julius Wizer</span><span className="h-3 w-px bg-[#373741]" /><span>Mbeya University of Science and Technology · Tanzania</span></footer>
        {profileOpen && <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)}><div onClick={event => event.stopPropagation()} className="absolute bottom-20 left-4 w-[250px] rounded-2xl border border-white/[.1] bg-[#1a1a22] p-4 shadow-2xl md:bottom-auto md:left-auto md:right-6 md:top-[68px]"><div className="flex items-center gap-3"><div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-[#282832] text-sm font-bold text-[#b8f35a]">{authMe.data?.avatarUrl ? <img src={authMe.data.avatarUrl} alt="Your profile" className="h-full w-full object-cover" /> : initials(authMe.data?.name)}</div><div className="min-w-0"><strong className="block truncate text-sm">{authMe.data?.name || "Guest profile"}</strong><span className="block truncate text-[11px] text-[#92929f]">{authMe.data?.email || "Not signed in"}</span></div></div>{authMe.data ? <><input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleAvatarUpload} className="hidden" /><button onClick={() => avatarInputRef.current?.click()} disabled={updateAvatar.isPending} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-white/[.1] bg-[#24242c] px-3 py-2.5 text-xs text-[#ddd] transition hover:border-[#b8f35a]/40 hover:text-white disabled:opacity-50"><Camera size={14} /> {updateAvatar.isPending ? "Uploading…" : "Change profile image"}</button>{avatarError && <p className="mt-2 text-[10px] leading-relaxed text-red-200">{avatarError}</p>}<button onClick={() => void signOut()} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs text-[#92929f] transition hover:bg-red-300/10 hover:text-red-200"><LogIn size={14} className="rotate-180" /> Log out</button></> : <><button onClick={() => openAuth("login")} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#b8f35a] px-3 py-2.5 text-xs font-bold text-[#101015] transition hover:bg-[#d4ff8b]"><LogIn size={14} /> Log in</button><button onClick={() => openAuth("register")} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-white/[.1] px-3 py-2.5 text-xs text-[#ddd] transition hover:border-[#b8f35a]/40 hover:text-white">Create account</button></>}</div></div>}
        {authOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4 backdrop-blur-sm"><div className="w-full max-w-md rounded-2xl border border-white/[.1] bg-[#1a1a22] p-6 shadow-2xl"><div className="mb-5 flex items-start justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#b8f35a]">Wizer AI account</p><h2 className="mt-2 text-2xl font-bold tracking-[-.05em]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>{authMode === "login" ? "Welcome back" : "Create your account"}</h2><p className="mt-1 text-xs text-[#92929f]">{authMode === "login" ? "Sign in to keep your chats organized." : "Save your conversations securely with Wizer AI."}</p></div><button onClick={() => setAuthOpen(false)} aria-label="Close authentication dialog" className="text-[#92929f] hover:text-white"><X size={18} /></button></div><form onSubmit={submitAuth} className="space-y-3">{authMode === "register" && <input value={authName} onChange={event => setAuthName(event.target.value)} required minLength={2} placeholder="Full name" className="w-full rounded-lg border border-white/[.1] bg-[#24242c] px-3 py-3 text-sm text-white outline-none placeholder:text-[#676773] focus:border-[#b8f35a]/50" />}<input type="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} required placeholder="Email address" className="w-full rounded-lg border border-white/[.1] bg-[#24242c] px-3 py-3 text-sm text-white outline-none placeholder:text-[#676773] focus:border-[#b8f35a]/50" /><input type="password" value={authPassword} onChange={event => setAuthPassword(event.target.value)} required minLength={authMode === "register" ? 8 : 1} placeholder={authMode === "register" ? "Password (8+ characters)" : "Password"} className="w-full rounded-lg border border-white/[.1] bg-[#24242c] px-3 py-3 text-sm text-white outline-none placeholder:text-[#676773] focus:border-[#b8f35a]/50" />{authError && <p className="rounded-lg border border-red-300/20 bg-red-300/10 px-3 py-2 text-xs text-red-200">{authError}</p>}<button disabled={authLogin.isPending || authRegister.isPending} className="w-full rounded-lg bg-[#b8f35a] py-3 text-sm font-bold text-[#101015] transition hover:bg-[#d4ff8b] disabled:opacity-50">{authMode === "login" ? "Sign in" : "Create account"}</button></form><p className="mt-5 text-center text-xs text-[#92929f]">{authMode === "login" ? "New to Wizer AI?" : "Already have an account?"} <button onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }} className="font-semibold text-[#b8f35a] hover:underline">{authMode === "login" ? "Create an account" : "Sign in instead"}</button></p><p className="mt-4 text-center text-[10px] text-[#5e5e6d]">Google, Microsoft, and password recovery will be added in the next authentication phase.</p></div></div>}
      </main>
    </div>
  </div>;
}
