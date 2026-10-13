import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUp, Check, ChevronDown, CircleHelp, Copy, FileText, Globe2,
  History, LogIn, LogOut, Menu, MessageCircle, MoreHorizontal, Moon, PanelLeftClose,
  Plus, Search, Settings2, Sun, Trash2, Upload, UserRound, X, Pencil, Paperclip,
  LoaderCircle, BookOpen, Code2, Lightbulb, FileUp, ExternalLink, Eye, EyeOff,
} from "lucide-react";
import { signInWithPopup, signInWithRedirect, signOut as firebaseSignOut } from "firebase/auth";
import { firebaseAuth, firebaseConfigured, getGoogleRedirectResult, googleProvider } from "./firebase.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiRequest, apiStream, clearStoredTokens, getStoredTokens, storeTokens } from "./api.js";

const emptyUsage = { requests: 0, successfulRequests: 0, failedAttempts: 0, totalTokens: 0, averageLatencyMs: 0 };
const allowedExtensions = ["txt", "md", "csv", "json", "pdf"];
const LANGUAGE_TO_API = { "Auto-detect": "auto", English: "english", "Roman Urdu": "roman-urdu" };
const LANGUAGE_FROM_API = { auto: "Auto-detect", english: "English", "roman-urdu": "Roman Urdu" };

function idOf(item) { return String(item?.id || item?._id || ""); }
function mapConversation(item) {
  return {
    id: idOf(item), title: item?.title || "New chat", language: item?.language || "auto",
    messageCount: Number(item?.messageCount || 0), lastMessageAt: item?.lastMessageAt || item?.updatedAt || item?.createdAt,
  };
}
function mapMessage(item, docs = []) {
  const ids = (item?.documentIds || []).map((id) => String(id?._id || id));
  const docNames = ids.map((id) => docs.find((d) => idOf(d) === id)?.name || "Attached document");
  return {
    id: idOf(item) || `${item?.role || "message"}-${item?.createdAt || Math.random()}`,
    role: item?.role === "assistant" ? "assistant" : "user",
    content: item?.content || (item?.status === "failed" ? "This response couldn't be generated. Please try again." : ""),
    createdAt: item?.createdAt, status: item?.status || "complete", sources: item?.sources || [],
    documentIds: ids, attachments: docNames,
  };
}
function friendlyError(error) {
  const message = error?.message || "Something went wrong. Please try again.";
  if (/email already exists|already registered/i.test(message)) return "An account with this email already exists. Sign in instead.";
  if (/incorrect|invalid credentials/i.test(message)) return "Email or password is incorrect.";
  if (/expired|sign in again|session/i.test(message)) return "Your session has expired. Please sign in again.";
  if (/auth\/popup-closed-by-user|cancelled-popup-request/i.test(error?.code || "")) return "Google sign-in was cancelled. You can try again whenever you're ready.";
  if (/auth\/unauthorized-domain/i.test(error?.code || "")) return "This website is not authorized for Google sign-in yet. Add your deployed domain in Firebase Authentication settings.";
  if (/auth\/popup-blocked|auth\/operation-not-supported-in-this-environment/i.test(error?.code || "")) return "Your browser blocked the Google sign-in window. Please allow pop-ups or try again.";
  return message;
}
function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [chats, setChats] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [language, setLanguage] = useState("Auto-detect");
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [modal, setModal] = useState("");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("guftugo.theme") || "dark");
  const [toast, setToast] = useState("");
  const [generating, setGenerating] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [authName, setAuthName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [busyDocuments, setBusyDocuments] = useState(false);
  const [usage, setUsage] = useState(emptyUsage);
  const [usageBusy, setUsageBusy] = useState(false);
  const [profileName, setProfileName] = useState("");
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  const streamAbortRef = useRef(null);

  const activeChat = chats.find((chat) => chat.id === activeId);
  const visibleChats = useMemo(() => chats.filter((chat) => (chat.title || "").toLowerCase().includes(query.toLowerCase())), [chats, query]);
  const notify = useCallback((message) => setToast(message), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("guftugo.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (messages.length || generating) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, generating]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); newChat();
      }
      if (event.key === "Escape") { setMobileSidebar(false); setShowProfile(false); if (modal) setModal(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const loadConversations = useCallback(async () => {
    const response = await apiRequest("/conversations?page=1&limit=100");
    const items = (response?.data?.conversations || []).map(mapConversation);
    setChats(items);
    return items;
  }, []);
  const loadDocuments = useCallback(async () => {
    const response = await apiRequest("/documents?page=1&limit=100");
    const items = response?.data?.documents || [];
    setDocuments(items);
    return items;
  }, []);
  const loadMessages = useCallback(async (conversationId, docsOverride) => {
    if (!conversationId) { setMessages([]); return []; }
    const response = await apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`);
    const docs = docsOverride || documents;
    const rows = (response?.data?.messages || []).map((message) => mapMessage(message, docs));
    setMessages(rows);
    const conversation = mapConversation(response?.data?.conversation);
    setChats((previous) => {
      const found = previous.some((item) => item.id === conversation.id);
      return found ? previous.map((item) => item.id === conversation.id ? { ...item, ...conversation } : item) : [conversation, ...previous];
    });
    return rows;
  }, [documents]);

  const loadWorkspace = useCallback(async () => {
    const [, docs] = await Promise.all([loadConversations(), loadDocuments()]);
    return docs;
  }, [loadConversations, loadDocuments]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tokens = getStoredTokens();
      if (!tokens.accessToken && !tokens.refreshToken) { setAuthReady(true); return; }
      try {
        const response = await apiRequest("/auth/me");
        if (cancelled) return;
        const currentUser = response?.data?.user;
        setUser(currentUser || null);
        if (currentUser) {
          setProfileName(currentUser.name || "");
          setLanguage(LANGUAGE_FROM_API[currentUser.preferredLanguage] || "Auto-detect");
          await Promise.allSettled([loadWorkspace()]);
        }
      } catch (error) {
        if (error?.status === 401 || /session has expired|refresh session|invalid refresh/i.test(error?.message || "")) clearStoredTokens();
        if (!cancelled) { setUser(null); setChats([]); setMessages([]); }
      } finally { if (!cancelled) setAuthReady(true); }
    })();
    return () => { cancelled = true; };
  }, [loadWorkspace]);

  const newChat = useCallback(() => {
    if (generating) streamAbortRef.current?.abort();
    setActiveId(null); setMessages([]); setInput(""); setAttachedDocs([]); setMobileSidebar(false);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, [generating]);

  const openChat = async (chat) => {
    if (generating) streamAbortRef.current?.abort();
    setActiveId(chat.id); setMessages([]); setAttachedDocs([]); setMobileSidebar(false); setGenerating(false);
    try { await loadMessages(chat.id); }
    catch (error) { notify(friendlyError(error)); }
  };

  const openAuth = (mode = "login", notice = "") => {
    setAuthMode(mode);
    setAuthError("");
    setAuthNotice(notice);
    setModal("auth");
    setShowProfile(false);
  };

  const completeSignIn = async (data, successMessage) => {
    if (!data.accessToken || !data.refreshToken || !data.user) throw new Error("The server returned an incomplete sign-in response.");
    storeTokens(data); setUser(data.user); setProfileName(data.user.name || "");
    setLanguage(LANGUAGE_FROM_API[data.user.preferredLanguage] || language);
    setModal(""); setAuthPassword(""); setShowAuthPassword(false); setAuthError("");
    const docs = await loadWorkspace().catch((error) => { notify(`Signed in, but account data could not be loaded: ${friendlyError(error)}`); return []; });
    notify(successMessage);
    if (activeId) await loadMessages(activeId, docs).catch((error) => notify(friendlyError(error)));
  };

  const handleAuth = async (event) => {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    try {
      const payload = authMode === "register"
        ? { name: authName.trim(), email: authEmail.trim(), password: authPassword, preferredLanguage: LANGUAGE_TO_API[language] || "auto" }
        : { email: authEmail.trim(), password: authPassword };
      const response = await apiRequest(`/auth/${authMode === "register" ? "register" : "login"}`, { method: "POST", body: payload, auth: false });
      await completeSignIn(response?.data || {}, authMode === "register" ? "Your account has been created." : "Welcome back.");
    } catch (error) { setAuthError(friendlyError(error)); }
    finally { setAuthBusy(false); }
  };

  const handleGoogleSignIn = async () => {
    setAuthError("");
    if (!firebaseConfigured || !firebaseAuth) {
      setAuthError("Google sign-in is not configured yet. You can use email and password for now.");
      return;
    }
    setAuthBusy(true);
    try {
      let credential;
      // Prefer redirect on narrow/mobile screens; popup windows are often blocked there.
      if (window.matchMedia("(max-width: 640px)").matches) {
        await signInWithRedirect(firebaseAuth, googleProvider);
        return;
      }
      try {
        credential = await signInWithPopup(firebaseAuth, googleProvider);
      } catch (error) {
        if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) {
          await signInWithRedirect(firebaseAuth, googleProvider);
          return;
        }
        throw error;
      }
      const idToken = await credential.user.getIdToken();
      const response = await apiRequest("/auth/google", {
        method: "POST",
        body: { idToken, preferredLanguage: LANGUAGE_TO_API[language] || "auto" },
        auth: false,
      });
      const firstName = credential.user.displayName?.trim().split(/\s+/)[0];
      await completeSignIn(response?.data || {}, firstName ? `Welcome to Guftugo, ${firstName}!` : "Welcome to Guftugo!");
    } catch (error) {
      setAuthError(friendlyError(error));
      if (firebaseAuth) await firebaseSignOut(firebaseAuth).catch(() => {});
    } finally { setAuthBusy(false); }
  };

  useEffect(() => {
    if (!firebaseConfigured || !firebaseAuth) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const credential = await getGoogleRedirectResult();
        if (!credential || cancelled) return;
        setModal("auth"); setAuthMode("login"); setAuthBusy(true); setAuthError("");
        const idToken = await credential.user.getIdToken();
        const response = await apiRequest("/auth/google", {
          method: "POST",
          body: { idToken, preferredLanguage: LANGUAGE_TO_API[language] || "auto" },
          auth: false,
        });
        if (!cancelled) {
          const firstName = credential.user.displayName?.trim().split(/\s+/)[0];
          await completeSignIn(response?.data || {}, firstName ? `Welcome to Guftugo, ${firstName}!` : "Welcome to Guftugo!");
        }
      } catch (error) {
        if (!cancelled) { setModal("auth"); setAuthMode("login"); setAuthError(friendlyError(error)); }
        if (firebaseAuth) await firebaseSignOut(firebaseAuth).catch(() => {});
      } finally { if (!cancelled) setAuthBusy(false); }
    })();
    return () => { cancelled = true; };
  // This is intentionally a one-time redirect-result handler after Firebase returns to the app.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    const { refreshToken } = getStoredTokens();
    try { if (refreshToken) await apiRequest("/auth/logout", { method: "POST", body: { refreshToken } }); }
    catch { /* Tokens are cleared locally even if the server session has expired. */ }
    if (firebaseAuth) await firebaseSignOut(firebaseAuth).catch(() => {});
    clearStoredTokens(); setUser(null); setChats([]); setMessages([]); setActiveId(null); setDocuments([]); setAttachedDocs([]); setShowProfile(false); setModal("");
    notify("You have signed out.");
  };

  const changeLanguage = async (value) => {
    setLanguage(value);
    if (!user) return;
    try {
      const response = await apiRequest("/auth/me/language", { method: "PATCH", body: { preferredLanguage: LANGUAGE_TO_API[value] || "auto" } });
      setUser(response?.data?.user || user);
    } catch (error) { notify(friendlyError(error)); }
  };

  const uploadFiles = async (files) => {
    if (!files.length) return;
    if (!user) { notify("Sign in to upload and save documents."); openAuth("login"); return; }
    const supported = files.filter((file) => allowedExtensions.includes(file.name.split(".").pop().toLowerCase()));
    if (supported.length !== files.length) notify("Only TXT, MD, CSV, JSON and PDF files are supported.");
    let remainingSlots = Math.max(0, 5 - attachedDocs.length);
    if (remainingSlots === 0 && supported.length) { notify("Attach up to 5 documents per message."); return; }
    for (const file of supported) {
      if (remainingSlots <= 0) { notify("Attach up to 5 documents per message."); break; }
      if (file.size > 5 * 1024 * 1024) { notify(`${file.name} is larger than the 5 MB limit.`); continue; }
      const body = new FormData(); body.append("file", file);
      try {
        setBusyDocuments(true);
        const response = await apiRequest("/documents", { method: "POST", body });
        const doc = response?.data?.document;
        if (doc) {
          setDocuments((previous) => [doc, ...previous.filter((item) => idOf(item) !== idOf(doc))]);
          setAttachedDocs((previous) => previous.some((item) => idOf(item) === idOf(doc)) ? previous : [...previous, doc].slice(0, 5));
          remainingSlots -= 1;
          notify(`${file.name} uploaded and attached.`);
        }
      } catch (error) { notify(`${file.name}: ${friendlyError(error)}`); }
      finally { setBusyDocuments(false); }
    }
  };

  const handleFileSelection = (event) => {
    const files = Array.from(event.target.files || []); event.target.value = "";
    void uploadFiles(files);
  };

  const uploadButton = () => fileRef.current?.click();
  const toggleDocumentAttachment = (document) => {
    const id = idOf(document);
    setAttachedDocs((previous) => previous.some((item) => idOf(item) === id) ? previous.filter((item) => idOf(item) !== id) : [...previous, document].slice(0, 5));
  };
  const deleteDocument = async (document) => {
    try {
      await apiRequest(`/documents/${encodeURIComponent(idOf(document))}`, { method: "DELETE" });
      setDocuments((previous) => previous.filter((item) => idOf(item) !== idOf(document)));
      setAttachedDocs((previous) => previous.filter((item) => idOf(item) !== idOf(document)));
      notify("Document deleted.");
    } catch (error) { notify(friendlyError(error)); }
  };

  const renameChat = async (chat) => {
    const title = window.prompt("Rename conversation", chat.title);
    if (!title?.trim() || title.trim() === chat.title) return;
    try {
      const response = await apiRequest(`/conversations/${encodeURIComponent(chat.id)}`, { method: "PATCH", body: { title: title.trim() } });
      const updated = mapConversation(response?.data?.conversation || { ...chat, title: title.trim() });
      setChats((previous) => previous.map((item) => item.id === chat.id ? { ...item, ...updated } : item));
      notify("Conversation renamed.");
    } catch (error) { notify(friendlyError(error)); }
  };
  const deleteChat = async (chat) => {
    if (!window.confirm(`Delete “${chat.title}”? This cannot be undone.`)) return;
    try {
      await apiRequest(`/conversations/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      setChats((previous) => previous.filter((item) => item.id !== chat.id));
      if (activeId === chat.id) { setActiveId(null); setMessages([]); setAttachedDocs([]); }
      notify("Conversation deleted.");
    } catch (error) { notify(friendlyError(error)); }
  };

  const loadUsage = async () => {
    setUsageBusy(true);
    try {
      const response = await apiRequest("/usage/summary?days=7");
      setUsage(response?.data?.overall || emptyUsage);
    } catch (error) { notify(friendlyError(error)); }
    finally { setUsageBusy(false); }
  };

  const handleStreamEvent = (eventName, payload, assistantLocalId, conversationIdRef) => {
    if (eventName === "meta") {
      const id = payload?.conversationId;
      conversationIdRef.current = id || conversationIdRef.current;
      if (id) {
        setActiveId(id);
        setChats((previous) => {
          const item = { id, title: payload?.title || "New chat", lastMessageAt: new Date().toISOString() };
          return previous.some((chat) => chat.id === id) ? previous.map((chat) => chat.id === id ? { ...chat, ...item } : chat) : [item, ...previous];
        });
      }
    } else if (eventName === "token" && typeof payload?.token === "string") {
      setMessages((previous) => previous.map((message) => message.id === assistantLocalId ? { ...message, content: message.content + payload.token } : message));
    } else if (eventName === "done") {
      if (payload?.conversation?.id) conversationIdRef.current = payload.conversation.id;
      setMessages((previous) => previous.map((message) => message.id === assistantLocalId ? { ...message, status: "complete", sources: payload?.sources || [] } : message));
    } else if (eventName === "error") {
      throw new Error(payload?.message || "The response could not be generated. Please try again.");
    }
  };

  const sendMessage = async (value = input) => {
    const text = value.trim();
    if ((!text && attachedDocs.length === 0) || generating) return;
    if (!user) {
      openAuth(
        "login",
        "You're one step away! Sign in or create a free account to send your message and start chatting with Guftugo.",
      );
      return;
    }
    const prompt = text || "Please explain the attached document(s) and summarize the key points.";
    const attachmentSnapshot = [...attachedDocs];
    const userLocalId = `local-user-${Date.now()}`;
    const assistantLocalId = `local-assistant-${Date.now()}`;
    const localConversationId = activeId;
    const conversationIdRef = { current: activeId };
    setMessages((previous) => [...previous, { id: userLocalId, role: "user", content: prompt, createdAt: new Date().toISOString(), attachments: attachmentSnapshot.map((doc) => doc.name), documentIds: attachmentSnapshot.map(idOf) }, { id: assistantLocalId, role: "assistant", content: "", status: "pending", createdAt: new Date().toISOString(), sources: [] }]);
    if (!localConversationId) setActiveId(null);
    setGenerating(true); setInput(""); if (inputRef.current) inputRef.current.style.height = "auto"; setAttachedDocs([]); setMobileSidebar(false);
    const controller = new AbortController(); streamAbortRef.current = controller;
    try {
      const response = await apiStream("/chat/stream", {
        message: prompt,
        ...(localConversationId ? { conversationId: localConversationId } : {}),
        language: LANGUAGE_TO_API[language] || "auto",
        documentIds: attachmentSnapshot.map(idOf),
        webSearch: false,
      }, controller.signal);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = null;
      const processBlock = (block) => {
        const normalized = block.replace(/\r/g, "");
        const lines = normalized.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
        const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!dataText) return;
        let payload = {};
        try { payload = JSON.parse(dataText); } catch { return; }
        try { handleStreamEvent(eventName, payload, assistantLocalId, conversationIdRef); }
        catch (error) { streamError = error; }
      };
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); processBlock(block);
        }
        if (streamError) break;
      }
      if (buffer.trim() && !streamError) processBlock(buffer);
      if (streamError) throw streamError;
      const cid = conversationIdRef.current;
      if (cid) {
        await Promise.allSettled([loadConversations(), loadMessages(cid)]);
        setActiveId(cid);
      } else {
        await loadConversations().catch(() => {});
      }
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      if (!cancelled) {
        setMessages((previous) => previous.map((message) => message.id === assistantLocalId ? { ...message, status: "failed", content: message.content || `Sorry, ${friendlyError(error)}` } : message));
        notify(friendlyError(error));
      }
      if (conversationIdRef.current) {
        await Promise.allSettled([loadConversations(), loadMessages(conversationIdRef.current)]);
      }
    } finally {
      setGenerating(false); streamAbortRef.current = null;
    }
  };

  const saveSettings = async () => {
    if (!user) { setModal(""); openAuth("login"); return; }
    try {
      const patch = {};
      if (profileName.trim() && profileName.trim() !== user.name) patch.name = profileName.trim();
      if (Object.keys(patch).length) {
        const response = await apiRequest("/auth/me", { method: "PATCH", body: patch });
        setUser(response?.data?.user || { ...user, ...patch });
      }
      const response = await apiRequest("/auth/me/language", { method: "PATCH", body: { preferredLanguage: LANGUAGE_TO_API[language] || "auto" } });
      setUser(response?.data?.user || user);
      setModal(""); notify("Settings saved.");
    } catch (error) { notify(friendlyError(error)); }
  };

  const startPrompt = (prompt) => { setInput(prompt); window.setTimeout(() => inputRef.current?.focus(), 20); };
  const showWebSearchComingSoon = () => notify("Coming soon");

  return (
    <div className={`app ${theme}`}>
      <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"} ${mobileSidebar ? "mobile-open" : ""}`}>
        <div className="brand-row">
          <button className="brand-button" onClick={newChat} aria-label="New chat">
            <span className="sidebar-logo-surface"><img src="/assets/guftugo-logo.png" alt="Guftugo" className="brand-logo" /></span>
          </button>
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"} aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
            <PanelLeftClose size={18} />
          </button>
          <button className="icon-button mobile-close" onClick={() => setMobileSidebar(false)} title="Close sidebar" aria-label="Close sidebar"><X size={18} /></button>
        </div>
        <button className="new-chat-btn" onClick={newChat}><Plus size={17} /><span>New chat</span><kbd>Ctrl K</kbd></button>
        <button className="sidebar-link" onClick={() => { setQuery(""); document.querySelector(".search-input")?.focus(); }}><Search size={17} /><span>Search chats</span></button>
        <div className="sidebar-section">
          <div className="section-heading"><span>YOUR CHATS</span><button className="tiny-icon" onClick={() => setQuery("")} title="Clear search"><MoreHorizontal size={16} /></button></div>
          <div className="search-wrap"><Search size={14} /><input className="search-input" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="tiny-icon" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}</div>
          <div className="chat-list">
            {!authReady ? <div className="empty-search">Loading chats…</div> : visibleChats.length ? visibleChats.map((chat) => (
              <div key={chat.id} className={`chat-list-item ${activeId === chat.id ? "active" : ""}`}>
                <button className="chat-select" onClick={() => openChat(chat)} title={chat.title}><MessageCircle size={15} /><span>{chat.title}</span></button>
                <button className="chat-more tiny-icon" title="Conversation options" onClick={(event) => { event.stopPropagation(); setShowProfile(false); const choice = window.prompt("Type rename or delete", "rename"); if (choice === "delete") deleteChat(chat); else if (choice === "rename") renameChat(chat); }}><MoreHorizontal size={16} /></button>
              </div>
            )) : <div className="empty-search">{user ? "No conversations yet" : "Sign in to see your chats"}</div>}
          </div>
        </div>
        <div className="sidebar-bottom">
          <button className="sidebar-link" onClick={() => { if (!user) { openAuth(); return; } setModal("documents"); loadDocuments().catch((error) => notify(friendlyError(error))); }}><FileText size={17} /><span>My documents</span></button>
          <button className="sidebar-link" onClick={() => { if (!user) { openAuth(); return; } setModal("usage"); loadUsage(); }}><Activity size={17} /><span>Usage</span></button>
          <button className="sidebar-link" onClick={() => setModal("settings")}><Settings2 size={17} /><span>Settings</span></button>
          <div className="profile-wrap">
            <button className="profile-button" onClick={() => setShowProfile((open) => !open)}><div className="avatar">{(user?.name || "G").slice(0, 1).toUpperCase()}</div><div className="profile-copy"><strong>{user?.name || "Guest"}</strong><small>{user?.email || "Sign in to sync chats"}</small></div><ChevronDown size={15} /></button>
            {showProfile && <div className="profile-menu">
              {user ? <><button onClick={() => { setProfileName(user.name || ""); setModal("settings"); setShowProfile(false); }}><UserRound size={15} /> Account settings</button><button onClick={signOut}><LogOut size={15} /> Sign out</button></> : <><button onClick={() => openAuth("login")}><LogIn size={15} /> Sign in</button><button onClick={() => openAuth("register")}><UserRound size={15} /> Create account</button></>}
            </div>}
          </div>
        </div>
      </aside>
      {mobileSidebar && <button className="mobile-backdrop" onClick={() => setMobileSidebar(false)} aria-label="Close navigation" />}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileSidebar((open) => !open)} aria-label={mobileSidebar ? "Close sidebar" : "Open sidebar"}><Menu size={20} /></button>
            {!sidebarOpen && <button className="icon-button desktop-menu" onClick={() => setSidebarOpen(true)} aria-label="Expand sidebar"><PanelLeftClose size={18} /></button>}
            {activeChat && <div className="active-conversation-title" title={activeChat.title}>{activeChat.title}</div>}
          </div>
          <div className="topbar-right">
            <button className="icon-button theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
            <button className="icon-button help-button" onClick={() => setModal("help")} title="Help" aria-label="Help"><CircleHelp size={18} /></button>
            {user ? <button className="topbar-profile" onClick={() => { setProfileName(user?.name || ""); setModal("settings"); setShowProfile(false); }} title="Account"><span className="avatar">{(user.name || "G").slice(0, 1).toUpperCase()}</span></button> : <button className="topbar-signin" onClick={() => openAuth("login")}><LogIn size={15} /><span>Sign in</span></button>}
          </div>
        </header>
        <div className="workspace">
          <div className={`conversation ${messages.length ? "has-messages" : ""}`}>
            {messages.length === 0 ? <div className="welcome">
              <div className="welcome-mark"><img src="/assets/guftugo-logo.png" alt="Guftugo logo" /></div>
              <div className="eyebrow"><span className="eyebrow-line" /><span>YOUR AI CONVERSATION SPACE</span><span className="eyebrow-line" /></div>
              <h1>What can I help you <span>with?</span></h1>
              <p className="welcome-subtitle">Ask anything. Explore ideas, solve problems, and bring your thoughts to life.</p>
              <div className="suggestion-grid">
                {[{ icon: Code2, title: "Help me write code", desc: "Build, debug, and understand code", prompt: "Help me write and explain some code." }, { icon: BookOpen, title: "Learn something new", desc: "Get a clear, simple explanation", prompt: "Explain a new topic in simple terms." }, { icon: Lightbulb, title: "Brainstorm ideas", desc: "Explore ideas and solve problems", prompt: "Help me brainstorm ideas for a project." }, { icon: FileText, title: "Write something", desc: "Draft, improve, or summarize text", prompt: "Help me write something professional." }].map((item) => { const Icon = item.icon; return <button className="suggestion-card" key={item.title} onClick={() => startPrompt(item.prompt)}><span className="suggestion-icon"><Icon size={17} /></span><span className="suggestion-text"><strong>{item.title}</strong><small>{item.desc}</small></span><span className="suggestion-arrow">↗</span></button>; })}
              </div>
              <div className="quick-prompts"><span>TRY ASKING</span>{["Explain a complex topic", "Plan my next project", "Improve my writing", "Teach me something useful"].map((prompt) => <button key={prompt} onClick={() => startPrompt(prompt)}>{prompt}</button>)}</div>
            </div> : <div className="messages-area">
              {activeChat && <div className="conversation-title"><div><span className="title-kicker">CONVERSATION</span><h2>{activeChat.title}</h2></div><div className="conversation-actions"><button className="icon-button" onClick={() => renameChat(activeChat)} title="Rename conversation" aria-label="Rename conversation"><Pencil size={16} /></button></div></div>}
              {messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
                <div className={`message-avatar ${message.role}`}>{message.role === "assistant" ? <img src="/assets/guftugo-logo.png" alt="" /> : <span>{(user?.name || "Y").slice(0, 1).toUpperCase()}</span>}</div>
                <div className="message-content"><div className="message-meta">{message.role === "assistant" ? "Guftugo" : "You"}{message.role === "assistant" && message.status === "pending" && <span className="thinking-label">thinking</span>}</div>
                  {message.attachments?.length > 0 && <div className="message-attachments">{message.attachments.map((name, index) => <span key={`${name}-${index}`}><FileText size={14} />{name}</span>)}</div>}
                  {message.status === "pending" && !message.content ? <div className="thinking"><i /><i /><i /></div> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>}
                  {message.role === "assistant" && message.sources?.length > 0 && <div className="source-list"><strong>Sources</strong>{message.sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /><span>{source.title || source.url}</span></a>)}</div>}
                  {message.role === "assistant" && message.content && <div className="message-actions"><button onClick={() => { navigator.clipboard?.writeText(message.content).then(() => notify("Response copied."), () => notify("Could not copy response.")); }} title="Copy response" aria-label="Copy response"><Copy size={14} /></button></div>}
                </div>
              </article>)}<div ref={endRef} />
            </div>}
          </div>
          <div className={`composer-area ${messages.length ? "composer-followup" : ""}`}>
            {attachedDocs.length > 0 && <div className="attached-files outside-composer">{attachedDocs.map((doc) => <span key={idOf(doc)}><FileText size={14} />{doc.name}<button onClick={() => setAttachedDocs((previous) => previous.filter((item) => idOf(item) !== idOf(doc)))} title="Remove attachment" aria-label="Remove attachment"><X size={12} /></button></span>)}</div>}
            <div className="composer">
              <div className="composer-top">
                <textarea ref={inputRef} value={input} onChange={(event) => { setInput(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder={user ? "Message Guftugo..." : "Sign in to start a conversation..."} rows={1} aria-label="Message Guftugo" />
              </div>
              <div className="composer-tools">
                <div className="tools-left">
                  <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json" multiple hidden onChange={handleFileSelection} />
                  <button className="tool-btn" onClick={uploadButton} disabled={!user || busyDocuments} title={user ? "Upload a document" : "Sign in to upload documents"}><Paperclip size={16} /><span>{busyDocuments ? "Uploading…" : "Attach"}</span></button>
                  <button className="tool-btn disabled-feature" onClick={showWebSearchComingSoon} title="Coming soon" aria-label="Web search coming soon" aria-disabled="true"><Globe2 size={15} /><span>Web search</span><span className="toggle"><i /></span></button>
                  <div className="language-select"><Globe2 size={14} /><select value={language} onChange={(event) => changeLanguage(event.target.value)} aria-label="Response language"><option>Auto-detect</option><option>English</option><option>Roman Urdu</option></select><ChevronDown size={12} /></div>
                </div>
                <button className="send-btn" disabled={(!input.trim() && attachedDocs.length === 0) || generating} onClick={() => sendMessage()} aria-label="Send message" title={!user ? "Sign in to chat" : "Send message"}>{generating ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button>
              </div>
            </div>
            <div className="composer-disclaimer">Guftugo can make mistakes. Check important information.</div>
          </div>
        </div>
        <footer className="footer"><span className="footer-credit">Made with <span aria-label="love">❤️</span> by <a href="https://www.linkedin.com/in/zainraza861/" target="_blank" rel="noopener noreferrer">Zain Raza</a></span><span className="footer-right">Your thoughts, in conversation.</span></footer>
      </main>

      {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(""); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-head"><div><span className="modal-kicker">GUFTUGO</span><h2 id="modal-title">{modal === "auth" ? (authMode === "login" ? "Welcome back" : "Create your account") : modal === "settings" ? "Settings" : modal === "documents" ? "My documents" : modal === "usage" ? "Usage" : "Help center"}</h2></div><button className="icon-button" onClick={() => setModal("")} title="Close" aria-label="Close"><X size={18} /></button></div>
          {modal === "auth" && <form className="modal-body auth-form" onSubmit={handleAuth}>
            {authNotice && <div className="auth-notice" role="status">{authNotice}</div>}
            {authError && <div className="form-error" role="alert">{authError}</div>}
            <button className="google-auth-btn" type="button" onClick={handleGoogleSignIn} disabled={authBusy}>
              {authBusy ? <LoaderCircle size={17} className="spin" /> : <svg className="google-auth-icon" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.74 7.18l7.28 5.64c4.25-3.92 6.7-9.71 6.7-17.29z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-6.16l-7.28-5.64c-2.02 1.35-4.6 2.15-8.62 2.15-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>}
              <span>Continue with Google</span>
            </button>
            <div className="auth-divider"><span>or continue with email</span></div>
            {authMode === "register" && <label>Full name<input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="Your name" minLength={2} maxLength={80} required /></label>}
            <label>Email address<input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@example.com" maxLength={254} autoComplete="email" required /></label>
            <label>Password<div className="password-input-wrap"><input type={showAuthPassword ? "text" : "password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="At least 8 characters" minLength={authMode === "register" ? 8 : 1} maxLength={128} autoComplete={authMode === "register" ? "new-password" : "current-password"} required /><button className="password-visibility-btn" type="button" onClick={() => setShowAuthPassword((visible) => !visible)} aria-label={showAuthPassword ? "Hide password" : "Show password"} aria-pressed={showAuthPassword} title={showAuthPassword ? "Hide password" : "Show password"}>{showAuthPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            <button className="primary-btn" type="submit" disabled={authBusy}>{authBusy ? <LoaderCircle size={16} className="spin" /> : <>{authMode === "login" ? "Sign in" : "Create account"}</>}</button>
            <button className="text-btn" type="button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>{authMode === "login" ? "Don't have an account? Create one" : "Already have an account? Sign in"}</button>
          </form>}
          {modal === "settings" && <div className="modal-body settings-body">
            {user ? <><label className="standalone-label">Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength={2} maxLength={80} /></label><label className="standalone-label">Email address<input value={user.email} readOnly /></label></> : <div className="empty-docs">Sign in to manage your account settings.</div>}
            <div className="setting-row"><div className="setting-symbol"><Globe2 size={18} /></div><div className="setting-copy"><strong>Preferred language</strong><small>Choose the language for AI responses</small></div><select value={language} onChange={(event) => changeLanguage(event.target.value)}><option>Auto-detect</option><option>English</option><option>Roman Urdu</option></select></div>
            <div className="setting-row"><div className="setting-symbol">{theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}</div><div className="setting-copy"><strong>Appearance</strong><small>Light or dark workspace</small></div><select value={theme} onChange={(event) => setTheme(event.target.value)}><option value="dark">Dark</option><option value="light">Light</option></select></div>
            <button className="primary-btn" onClick={saveSettings} disabled={!user}>Save preferences</button>
          </div>}
          {modal === "documents" && <div className="modal-body">
            <div className="dropzone" onClick={uploadButton} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files || [])); }}><div className="drop-icon"><Upload size={22} /></div><strong>Upload a document</strong><span>Click or drag TXT, MD, CSV, or JSON files here</span><small>Maximum file size: 5 MB each</small></div>
            <div className="modal-list-heading">SAVED DOCUMENTS <span>{documents.length}</span></div>
            {documents.length ? documents.map((doc) => { const isAttached = attachedDocs.some((item) => idOf(item) === idOf(doc)); return <div className="document-row" key={idOf(doc)}><div className="document-icon"><FileText size={17} /></div><div className="document-copy"><strong title={doc.name}>{doc.name}</strong><small>{(Number(doc.sizeBytes || 0) / 1024).toFixed(1)} KB · {formatDate(doc.createdAt)}</small></div><button className={`outline-btn doc-attach ${isAttached ? "selected" : ""}`} onClick={() => toggleDocumentAttachment(doc)}>{isAttached ? "Attached" : "Attach"}</button><button className="tiny-icon" onClick={() => deleteDocument(doc)} title="Delete document" aria-label={`Delete ${doc.name}`}><Trash2 size={15} /></button></div>; }) : <div className="empty-docs">No documents uploaded yet.</div>}
            {attachedDocs.length > 0 && <button className="primary-btn" onClick={() => { setModal(""); notify(`${attachedDocs.length} document${attachedDocs.length > 1 ? "s" : ""} attached to your next message.`); }}>Done · {attachedDocs.length} attached</button>}
          </div>}
          {modal === "usage" && <div className="modal-body">
            <div className="usage-banner"><div className="usage-orb"><Activity size={21} /></div><div><strong>Last 7 days</strong><p>Your account activity and AI usage.</p></div><button className="tiny-icon" onClick={loadUsage} title="Refresh usage" aria-label="Refresh usage"><History size={16} /></button></div>
            <div className="usage-metrics"><div><span>Requests</span><strong>{usageBusy ? "…" : formatNumber(usage.requests)}</strong><small>Total attempts</small></div><div><span>Successful</span><strong>{usageBusy ? "…" : formatNumber(usage.successfulRequests)}</strong><small>Completed requests</small></div><div><span>Tokens</span><strong>{usageBusy ? "…" : formatNumber(usage.totalTokens)}</strong><small>Recorded usage</small></div><div><span>Avg. response</span><strong>{usageBusy ? "…" : `${Math.round(Number(usage.averageLatencyMs || 0))} ms`}</strong><small>Across responses</small></div></div>
            <p className="usage-footnote">Usage totals reflect recorded activity for this account.</p>
          </div>}
          {modal === "help" && <div className="modal-body help-body">
            <div className="help-item"><div className="setting-symbol"><MessageCircle size={18} /></div><div><strong>Start a conversation</strong><p>Ask a question or choose a suggestion. Press Enter to send, or Shift + Enter for a new line.</p></div></div>
            <div className="help-item"><div className="setting-symbol"><Globe2 size={18} /></div><div><strong>Choose your language</strong><p>Use automatic detection, English, or Roman Urdu in the composer.</p></div></div>
            <div className="help-item"><div className="setting-symbol"><FileUp size={18} /></div><div><strong>Attach documents</strong><p>Upload TXT, MD, CSV, or JSON files up to 5 MB and attach them to a message.</p></div></div>
            <div className="help-item"><div className="setting-symbol"><Globe2 size={18} /></div><div><strong>Web search</strong><p>Web search is coming soon.</p></div></div>
          </div>}
        </section>
      </div>}
      {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    </div>
  );
}

export default App;
