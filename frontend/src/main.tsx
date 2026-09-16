import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { io } from "socket.io-client";
import {
  ArrowRight,
  ArrowUpRight,
  Award,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileArchive,
  FileCheck2,
  FileText,
  History,
  LayoutDashboard,
  Mail,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  X,
  Send,
  Eye,
  Pause,
  Play,
  Square,
  LogOut,
  LoaderCircle,
  AlertCircle,
  Paperclip,
  Monitor,
  Smartphone,
  Link2,
  LockKeyhole,
} from "lucide-react";
import { api, API, setCSRF, getCSRF } from "./api";
import {
  defaults,
  type Batch,
  type Recipient,
  type Mapping,
  type Template,
} from "./types";
import {
  loadHistory,
  saveHistory,
  snapshot,
  mergeHistory,
  duplicateHistory,
  reportCSV,
  retryCSV,
  download,
  parseHistory,
  loadSettings,
  type HistoryEntry,
  type Settings,
} from "./storage";
import "./style.css";
const steps = [
  "Certificates",
  "Recipients",
  "Matching",
  "Email",
  "Preview",
  "Test",
  "Review",
  "Send",
];
const active = (b: Batch | null) =>
  !!b && ["sending", "paused", "stopping"].includes(b.status);
const formatDate = (s: string) =>
  new Date(s).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const bytes = (n: number) =>
  n > 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;
type Context = {
  user: string | null;
  loading: boolean;
  configured: boolean;
  batch: Batch | null;
  setBatch: (b: Batch | null) => void;
  history: HistoryEntry[];
  setHistory: (h: HistoryEntry[]) => void;
  settings: Settings;
  setSettings: (s: Settings) => void;
  notify: (message: string, error?: boolean) => void;
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  create: () => Promise<void>;
  connected: boolean;
};
const Ctx = createContext<Context>(null!);
const useApp = () => useContext(Ctx);
function App() {
  const [user, setUser] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [configured, setConfigured] = useState(false),
    [batch, setBatch] = useState<Batch | null>(null),
    [history, setHistoryState] = useState<HistoryEntry[]>([]),
    [settings, setSettingsState] = useState(loadSettings),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false);
  const navigate = useNavigate();
  const lock = useRef(false);
  const historyReadable = useRef(true);
  const notify = (message: string, error = false) =>
    setToast({ message, error });
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Something went wrong.", true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const setHistory = (h: HistoryEntry[]) => {
    saveHistory(h);
    historyReadable.current = true;
    setHistoryState(h);
  };
  const setSettings = (s: Settings) => {
    localStorage.setItem("certflow.settings", JSON.stringify(s));
    setSettingsState(s);
  };
  useEffect(() => {
    try {
      setHistoryState(loadHistory());
    } catch (e) {
      historyReadable.current = false;
      notify(
        `Local history could not be read: ${(e as Error).message}. Export it from Settings before clearing it.`,
        true,
      );
    }
    void api<{ email: string | null; csrf: string; configured: boolean }>(
      "/auth/me",
    )
      .then(async (data) => {
        setUser(data.email);
        setConfigured(data.configured);
        setCSRF(data.csrf);
        if (data.email) setBatch(await api<Batch | null>("/batch/status"));
      })
      .catch((e) => notify(e.message, true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : settings.theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);
  useEffect(() => {
    if (!batch?.records.length || !historyReadable.current) return;
    try {
      setHistoryState((h) => {
        const next = [
          snapshot(batch),
          ...h.filter((x) => x.batchId !== batch.batchId),
        ];
        try {
          saveHistory(next);
        } catch (e) {
          setToast({
            error: true,
            message: `History could not be saved: ${(e as Error).message}. Export your current report now.`,
          });
        }
        return next;
      });
    } catch {
      /* Storage errors are surfaced above. */
    }
  }, [batch]);
  useEffect(() => {
    if (!user) return;
    const socket = io(API || window.location.origin, {
      withCredentials: true,
      auth: { csrf: getCSRF() },
      transports: ["polling", "websocket"],
    });
    socket.on("batch", setBatch);
    socket.on("connect", () => {
      setConnected(true);
      void api<Batch | null>("/batch/status")
        .then(setBatch)
        .catch(() => undefined);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    return () => {
      socket.disconnect();
    };
  }, [user]);
  useEffect(() => {
    if (!active(batch)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    const timer = setInterval(() => {
      void api<Batch | null>("/batch/status")
        .then(setBatch)
        .catch(() => setConnected(false));
    }, 5000);
    return () => {
      window.removeEventListener("beforeunload", warn);
      clearInterval(timer);
    };
  }, [batch?.status]);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const create = async () => {
    await run(async () => {
      if (!historyReadable.current)
        throw Error('Export your unreadable local history from Settings, then import a valid backup or explicitly clear it before creating a batch.');
      let b = await api<Batch>("/batch/new", {});
      const { theme, ...template } = settings;
      b = await api<Batch>("/email/template", template);
      setBatch(b);
      navigate("/app/new?step=0");
    });
  };
  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        configured,
        batch,
        setBatch,
        history,
        setHistory,
        settings,
        setSettings,
        notify,
        busy,
        run,
        create,
        connected,
      }}
    >
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app/*" element={<Shell />} />
        <Route
          path="*"
          element={
            <div className="empty">
              <h1>Page not found</h1>
              <Link to="/">Return to CertFlow</Link>
            </div>
          }
        />
      </Routes>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <AlertCircle size={20} />
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={18} />
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-symbol">
        <Award size={24} />
      </span>
      certflow<span className="brand-dot">.</span>
    </Link>
  );
}
function GoogleButton({ small = false }: { small?: boolean }) {
  const { loading, busy } = useApp();
  return (
    <a
      className={`button primary ${small ? "small" : ""} ${loading || busy ? "disabled" : ""}`}
      href={`${API}/api/auth/google`}
    >
      <span className="google-g">G</span>Continue with Google
      <ArrowRight size={17} />
    </a>
  );
}
function Landing() {
  const { user, configured, loading } = useApp();
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Brand />
        <div className="landing-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#safety">Built for trust</a>
        </div>
        {user ? (
          <Link className="button primary small" to="/app">
            Open dashboard <ArrowRight size={16} />
          </Link>
        ) : (
          <GoogleButton small />
        )}
      </nav>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="tiny-line" /> BIG ACHIEVEMENTS. ZERO BUSYWORK.
            </span>
            <h1>
              Send Every
              <br />
              Certificate.
              <br />
              <em>Automatically.</em>
            </h1>
            <p>
              Upload certificates, match recipients, preview every email, and
              send personalized certificates directly from your Gmail account.
            </p>
            <div className="hero-actions">
              <GoogleButton />
              <a href="#how" className="button secondary">
                See how it works <ArrowUpRight size={17} />
              </a>
            </div>
            <div className="hero-trust">
              <ShieldCheck size={16} /> Your Gmail. Your files. Always in your
              control.
            </div>
            {!loading && !configured && (
              <p className="setup-note">
                Gmail connection is awaiting server configuration.{" "}
                <Link to="/app">
                  Explore the workspace <ArrowRight size={13} />
                </Link>
              </p>
            )}
          </div>
          <div className="hero-preview">
            <div className="preview-label">
              <span>AN ACHIEVEMENT, DELIVERED</span>
              <span>01 / CERTFLOW</span>
            </div>
            <div className="letter-card">
              <div className="letter-top">
                <div className="mini-logo">
                  <Award size={20} />
                </div>
                <span>ADVANCED TECH CLUB × CDU</span>
                <MoreHorizontal size={20} />
              </div>
              <div className="letter-body">
                <span className="celebrate">✦</span>
                <p className="overline">A LITTLE RECOGNITION GOES A LONG WAY</p>
                <h2>
                  You did something
                  <br />
                  <em>worth celebrating.</em>
                </h2>
                <p>
                  Every workshop. Every new skill.
                  <br />
                  Every step forward deserves recognition.
                </p>
                <div className="attachment-preview">
                  <div className="file-icon">
                    <FileText size={24} />
                  </div>
                  <div>
                    <strong>Your certificate</strong>
                    <small>Personalized. Attached. Ready to send.</small>
                  </div>
                  <Paperclip size={18} />
                </div>
                <div className="letter-footer">
                  Keep learning. Keep building. <ArrowUpRight size={16} />
                </div>
              </div>
            </div>
            <div className="float-note">
              <span className="check-icon">
                <Check size={16} />
              </span>
              <div>
                <strong>The right certificate. The right person.</strong>
                <small>Review every match before you send.</small>
              </div>
            </div>
            <div className="preview-caption">
              THOUGHTFUL EMAILS. WITHOUT THE REPETITIVE WORK.
            </div>
          </div>
        </section>
        <div className="trust-strip">
          <span>MADE FOR MOMENTS THAT MATTER</span>
          <strong>Workshops</strong>
          <span>✦</span>
          <strong>Communities</strong>
          <span>✦</span>
          <strong>Courses</strong>
          <span>✦</span>
          <strong>Events</strong>
        </div>
        <section className="section" id="how">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FROM FOLDER TO INBOX</span>
              <h2>
                A better way to wrap up
                <br />
                your next big event.
              </h2>
            </div>
            <p>
              Less time sending attachments.
              <br />
              More time making things happen.
            </p>
          </div>
          <div className="feature-grid">
            {[
              [
                FileArchive,
                "01",
                "Upload once",
                "Drop in your certificate ZIP and recipient CSV. We’ll help you make sense of every file.",
              ],
              [
                Link2,
                "02",
                "Make the right match",
                "Inspect suggested matches, fix issues, and make sure every achievement reaches its owner.",
              ],
              [
                Send,
                "03",
                "Send with confidence",
                "Personalize your email, send a real test, then confirm your batch and watch it go.",
              ],
            ].map(([Icon, n, title, copy]) => {
              const I = Icon as typeof Send;
              return (
                <article className="feature" key={String(n)}>
                  <div className="feature-top">
                    <I size={25} />
                    <span>{String(n)}</span>
                  </div>
                  <h3>{String(title)}</h3>
                  <p>{String(copy)}</p>
                </article>
              );
            })}
          </div>
        </section>
        <section className="section feature-band" id="features">
          <div>
            <span className="eyebrow">THE DETAILS ARE TAKEN CARE OF</span>
            <h2>
              Big batches.
              <br />
              Personal touches.
            </h2>
            <p>
              Real HTML previews. Individual attachments.
              <br />A clear record of every send.
            </p>
          </div>
          <div className="benefit-grid">
            {[
              [
                Eye,
                "Preview every email",
                "Switch between desktop and mobile before anything leaves your account.",
              ],
              [
                Users,
                "One person, one certificate",
                "Each message is generated individually. No CC or BCC lists.",
              ],
              [
                History,
                "History you control",
                "Keep local records and move them between browsers with JSON exports.",
              ],
              [
                Pause,
                "You set the pace",
                "Pause, resume, or stop a batch. Review failures with clear delivery status.",
              ],
            ].map(([Icon, title, copy]) => {
              const I = Icon as typeof Eye;
              return (
                <div key={String(title)}>
                  <I size={22} />
                  <h3>{String(title)}</h3>
                  <p>{String(copy)}</p>
                </div>
              );
            })}
          </div>
        </section>
        <section className="section safety" id="safety">
          <ShieldCheck size={42} />
          <span className="eyebrow">CONFIDENCE COMES BUILT IN</span>
          <h2>Nothing sends until you say so.</h2>
          <p>
            Connect securely with Google. Review every match. Send a test.
            <br />
            Only then, give your batch the green light.
          </p>
          <div className="safety-pills">
            <span>
              <Check size={15} /> No Gmail passwords
            </span>
            <span>
              <Check size={15} /> Temporary file processing
            </span>
            <span>
              <Check size={15} /> Explicit send confirmation
            </span>
          </div>
        </section>
        <section className="section faq">
          <h2>
            A few things you might
            <br />
            be wondering.
          </h2>
          <div>
            {[
              [
                "Can I use my own Gmail account?",
                "Yes. Connect through Google OAuth. CertFlow requests permission to send email, plus your basic account email for sign-in. It does not request access to read your inbox.",
              ],
              [
                "Where do my files and history live?",
                "Certificates are temporary on the server and are deleted after completion, stop, or expiry. History stays in this browser unless you export it. It is not shared automatically across devices.",
              ],
              [
                "What happens if a certificate cannot be matched?",
                "That recipient is blocked. Correct your CSV or ZIP, or explicitly skip the recipient. Suggested matches require your approval.",
              ],
              [
                "Can I retry failed emails?",
                "Yes. Create a retry batch from failed records and re-upload the original certificates. If delivery is uncertain, check Gmail Sent first; CertFlow does not automatically resend those messages.",
              ],
            ].map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <Plus size={18} />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="landing-cta">
          <div>
            <span className="eyebrow">GIVE EVERY ACHIEVEMENT ITS MOMENT</span>
            <h2>Ready to send something meaningful?</h2>
          </div>
          <GoogleButton />
        </section>
      </main>
      <footer>
        <Brand />
        <span>Every achievement, delivered.</span>
        <span>© {new Date().getFullYear()} CertFlow</span>
      </footer>
    </div>
  );
}
function Shell() {
  const { user, loading, batch, create, busy } = useApp();
  const [menu, setMenu] = useState(false);
  const nav = [
    [LayoutDashboard, "Dashboard", "/app"],
    [Plus, "New Batch", "/app/new?step=0"],
    [FileCheck2, "Certificates", "/app/new?step=0"],
    [Users, "Recipients", "/app/new?step=2"],
    [Mail, "Email Template", "/app/new?step=3"],
    [Eye, "Preview", "/app/new?step=4"],
    [Send, "Send", "/app/new?step=6"],
    [History, "History", "/app/history"],
    [SettingsIcon, "Settings", "/app/settings"],
  ] as const;
  return (
    <div className="workspace">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {nav.map(([Icon, label, url], i) => (
            <NavLink
              key={label}
              to={url}
              end={i === 0}
              className={({ isActive }) =>
                `${isActive && (i === 0 || i >= 7) ? "selected" : ""}`
              }
              onClick={() => setMenu(false)}
            >
              <Icon size={19} />
              {label}
              {label === "History" && <span className="nav-count">Local</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={24} />
          <strong>Your data. Your control.</strong>
          <p>
            History stays in this browser.
            <br />
            Export it to keep a backup.
          </p>
          <Link to="/app/history">
            Manage history <ArrowUpRight size={14} />
          </Link>
        </div>
        <div className="sidebar-account">
          <span className="avatar">{user ? user[0].toUpperCase() : "?"}</span>
          <div>
            <strong>{user ? "Gmail connected" : "Not connected"}</strong>
            <small>{user ?? "Connect to start sending"}</small>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="app-header">
          <button
            className="icon-button mobile-menu"
            aria-label="Toggle navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={22} />
          </button>
          <span className="breadcrumb">
            Workspace <span>/</span> CertFlow
          </span>
          <div>
            {user ? (
              <>
                <span className="connection">
                  <span /> Gmail connected
                </span>
                <Link
                  className="avatar"
                  to="/app/settings"
                  aria-label="Account settings"
                >
                  {user[0].toUpperCase()}
                </Link>
              </>
            ) : (
              <GoogleButton small />
            )}
          </div>
        </header>
        <main className="app-content">
          {loading ? (
            <div className="skeleton-stack" aria-label="Loading workspace">
              <div />
              <div />
              <div />
            </div>
          ) : (
            <>
              {!user && (
                <div className="notice">
                  <LockKeyhole size={20} />
                  <div>
                    <strong>Connect Gmail to create and send a batch.</strong>
                    <p>
                      You can explore the workspace and manage local history
                      here.
                    </p>
                  </div>
                </div>
              )}
              {active(batch) && (
                <Link to="/app/new?step=7" className="notice active-notice">
                  <LoaderCircle size={20} />
                  <span>
                    Batch {batch?.status} · {batch?.sent} sent · View live
                    progress <ArrowRight size={15} />
                  </span>
                </Link>
              )}
              <Routes>
                <Route index element={<Dashboard />} />
                <Route path="new" element={<Workflow />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Dashboard />} />
              </Routes>
            </>
          )}
        </main>
        <div className="workspace-footer">
          <span>
            <ShieldCheck size={14} /> Designed for careful sending.
          </span>
          <span>CertFlow · Browser-local history</span>
        </div>
      </div>
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Stats({ items }: { items: [string, number][] }) {
  return (
    <div className="stats">
      {items.map(([label, value]) => (
        <div className="stat" key={label}>
          <span>{label}</span>
          <strong>{value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}
function Dashboard() {
  const { batch, history, user, busy, create } = useApp();
  const records = history.flatMap((b) => b.records);
  return (
    <>
      <PageHeading
        eyebrow="A GOOD DAY TO CELEBRATE SOMEONE"
        title="Your sending workspace"
        description="From the last workshop to the next big milestone. All in one place."
        action={
          <button
            className="button primary"
            onClick={create}
            disabled={!user || busy || active(batch)}
          >
            <Plus size={18} /> Create new batch
          </button>
        }
      />
      <div className="section-label">
        <h2>At a glance</h2>
        <span className="pill">Local statistics</span>
      </div>
      <Stats
        items={[
          ["Total batches", history.length],
          ["Recipients", records.length],
          ["Certificates", history.reduce((n, b) => n + b.certificateCount, 0)],
          ["Sent", records.filter((r) => r.status === "sent").length],
          ["Failed", records.filter((r) => r.status === "failed").length],
        ]}
      />
      <div className="dashboard-grid">
        <section className="card current-batch">
          <div className="card-heading">
            <h2>{batch ? "Current batch" : "Your next batch starts here"}</h2>
            <span className="tag">{batch?.status ?? "Ready when you are"}</span>
          </div>
          {batch ? (
            <>
              <Stats
                items={[
                  ["Recipients", batch.total],
                  [
                    "Matched",
                    batch.records.filter((r) => r.certificateId).length,
                  ],
                  ["Ready", batch.ready],
                  ["Sent", batch.sent],
                ]}
              />
              <Link
                className="button primary"
                to={`/app/new?step=${active(batch) ? 7 : 0}`}
              >
                Continue batch <ArrowRight size={17} />
              </Link>
            </>
          ) : (
            <div className="empty batch-empty">
              <div className="large-icon">
                <FileArchive size={32} />
              </div>
              <h3>
                A folder full of achievements.
                <br />
                An inbox for every one.
              </h3>
              <p>
                Bring your certificate ZIP and recipient CSV.
                <br />
                We’ll help you get everything ready to send.
              </p>
              <button
                className="button secondary"
                onClick={create}
                disabled={!user || busy}
              >
                <Plus size={17} /> Create your first batch
              </button>
            </div>
          )}
        </section>
        <section className="card preparation">
          <span className="eyebrow">BEFORE YOU BEGIN</span>
          <h2>
            A little prep.
            <br />A smooth send.
          </h2>
          {[
            [
              "01",
              "Gather your certificates",
              "PDF, PNG or JPG, together in one ZIP.",
            ],
            [
              "02",
              "Prepare your recipient list",
              "A CSV with names, emails and filenames.",
            ],
            [
              "03",
              "Review, test, then send",
              "You approve every batch before it goes.",
            ],
          ].map(([n, title, p]) => (
            <div className="prep-item" key={n}>
              <span>{n}</span>
              <div>
                <strong>{title}</strong>
                <p>{p}</p>
              </div>
            </div>
          ))}
          <button
            className="text-button"
            onClick={() =>
              download(
                "certflow-recipients-example.csv",
                "name,email,certificate\nJohn Doe,john@gmail.com,John_Doe.pdf\nRahul Kumar,rahul@gmail.com,Rahul_Kumar.pdf\nPriya Sharma,priya@gmail.com,Priya_Sharma.pdf",
                "text/csv",
              )
            }
          >
            <Download size={16} /> Download CSV example
          </button>
        </section>
      </div>
      <div className="section-label">
        <h2>Recent batches</h2>
        <Link to="/app/history">
          View all history <ArrowRight size={15} />
        </Link>
      </div>
      <HistoryList entries={history.slice(0, 3)} />
      <div className="local-note">
        <History size={17} /> These statistics belong to this browser. Export
        history to keep a backup or move to another device.
      </div>
    </>
  );
}
function Dropzone({
  kind,
  onFile,
}: {
  kind: "ZIP" | "CSV";
  onFile: (file: File) => void;
}) {
  const { busy } = useApp();
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const Icon = kind === "ZIP" ? FileArchive : Users;
  return (
    <div
      className={`dropzone ${drag ? "drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!busy && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="large-icon">
        <Icon size={30} />
      </div>
      <h3>
        Drop your {kind === "ZIP" ? "certificate ZIP" : "recipient CSV"} here
      </h3>
      <p>
        {kind === "ZIP"
          ? "PDF, PNG, JPG or JPEG · Up to 50 MB ZIP · 1,000 certificates"
          : "UTF-8 CSV · Up to 2 MB · 1,000 recipients"}
      </p>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => ref.current?.click()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <Upload size={17} />
        )}{" "}
        Browse {kind}
      </button>
      <input
        ref={ref}
        type="file"
        accept={kind === "ZIP" ? ".zip" : ".csv"}
        aria-label={`Upload ${kind}`}
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
function Workflow() {
  const { batch, setBatch, user, create, busy, run } = useApp();
  const [params, setParams] = useSearchParams();
  const index = Math.min(7, Math.max(0, Number(params.get("step")) || 0));
  const go = (i: number) => setParams({ step: String(i) });
  const [newConfirm, setNewConfirm] = useState(false);
  const upload = (kind: "zip" | "csv", file: File) =>
    run(async () => {
      const data = new FormData();
      data.append("file", file);
      setBatch(await api<Batch>(`/batch/upload-${kind}`, data));
    });
  return (
    <>
      <PageHeading
        eyebrow={
          batch
            ? `BATCH ${batch.batchId.slice(0, 8).toUpperCase()}`
            : "YOUR NEXT MOMENT"
        }
        title={index === 7 ? "Delivery center" : "Let’s make it personal."}
        description="A few careful steps. Every certificate in the right hands."
        action={
          batch &&
          !active(batch) && (
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => setNewConfirm(true)}
            >
              <Plus size={16} /> New batch
            </button>
          )
        }
      />
      {newConfirm && (
        <Confirm
          title="Create a new batch?"
          text="The current batch’s temporary attachments will be deleted. Its recipient history remains in this browser."
          action="Create batch"
          onClose={() => setNewConfirm(false)}
          onConfirm={async () => {
            setNewConfirm(false);
            await create();
          }}
        />
      )}
      <div className="stepper" aria-label="Batch steps">
        {steps.map((s, i) => (
          <button
            key={s}
            className={`${index === i ? "current" : ""} ${index > i ? "past" : ""}`}
            aria-current={index === i ? "step" : undefined}
            onClick={() => go(i)}
          >
            <span>{index > i ? <Check size={14} /> : i + 1}</span>
            {s}
          </button>
        ))}
      </div>
      {!batch ? (
        <section className="card empty">
          <div className="large-icon">
            <Plus size={28} />
          </div>
          <h2>Start a new certificate batch</h2>
          <p>Connect Gmail, then upload your files to begin.</p>
          <button
            className="button primary"
            disabled={!user || busy}
            onClick={create}
          >
            <Plus size={17} /> Create batch
          </button>
        </section>
      ) : (
        <>
          {batch.status !== "draft" && index < 7 && (
            <div className="notice">
              This batch is {batch.status}. Its contents are locked.{" "}
              <button className="text-button" onClick={() => go(7)}>
                View delivery report
              </button>
            </div>
          )}
          {index === 0 && (
            <section className="card">
              <div className="card-heading">
                <div>
                  <h2>Upload your certificates</h2>
                  <p>Keep filenames unique, even inside nested folders.</p>
                </div>
                <span className="tag">Step 1 of 8</span>
              </div>
              {batch.status === "draft" && (
                <Dropzone kind="ZIP" onFile={(f) => upload("zip", f)} />
              )}
              <CertificateTable />
              <div className="card-actions">
                <span>
                  Files are temporary and deleted after sending or expiry.
                </span>
                <button
                  className="button primary"
                  disabled={!batch.certificates.length}
                  onClick={() => go(1)}
                >
                  Continue <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}
          {index === 1 && (
            <section className="card">
              <div className="card-heading">
                <div>
                  <h2>Who are we celebrating?</h2>
                  <p>Upload your CSV, then check the column mapping.</p>
                </div>
                <span className="tag">Step 2 of 8</span>
              </div>
              {batch.status === "draft" && (
                <Dropzone kind="CSV" onFile={(f) => upload("csv", f)} />
              )}
              <MappingEditor onContinue={() => go(2)} />
            </section>
          )}
          {index === 2 && (
            <section className="card">
              <div className="card-heading">
                <div>
                  <h2>Every certificate. The right person.</h2>
                  <p>
                    Inspect suggested matches and approve them individually.
                    Resolve or skip blocked records.
                  </p>
                </div>
                <span className="tag">
                  {batch.records.filter((r) => r.certificateId).length} /{" "}
                  {batch.total} matched
                </span>
              </div>
              <RecipientTable
                records={batch.records}
                editable={batch.status === "draft"}
              />
              <div className="card-actions">
                <span>
                  {batch.blocked} blocked · {batch.ready} ready ·{" "}
                  {batch.skipped} skipped
                </span>
                <button
                  className="button primary"
                  disabled={!batch.records.length}
                  onClick={() => go(3)}
                >
                  Customize email <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}
          {index === 3 && <EmailEditor onContinue={() => go(4)} />}{" "}
          {index === 4 && (
            <section className="card">
              <div className="card-heading">
                <div>
                  <h2>See exactly what they’ll receive</h2>
                  <p>
                    Personalized content, actual attachment, and your Gmail
                    identity.
                  </p>
                </div>
              </div>
              <EmailPreview />
              <div className="card-actions">
                <span>
                  Download and inspect the attachment before approving.
                </span>
                <button
                  className="button primary"
                  disabled={!batch.ready}
                  onClick={() => go(5)}
                >
                  Send a test <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}
          {index === 5 && <TestEmail onContinue={() => go(6)} />}{" "}
          {index === 6 && <FinalReview onSend={() => go(7)} />}{" "}
          {index === 7 && <Progress />}
        </>
      )}
    </>
  );
}
function CertificateTable() {
  const { batch } = useApp();
  if (!batch?.certificates.length) return null;
  const files = batch.certificates;
  return (
    <>
      <Stats
        items={[
          ["Total files", files.length],
          ["Valid", files.filter((c) => c.status === "valid").length],
          ["Invalid", files.filter((c) => c.status === "invalid").length],
          ["Duplicates", files.filter((c) => c.status === "duplicate").length],
        ]}
      />
      <p className="muted">
        Total size: {bytes(files.reduce((n, c) => n + c.size, 0))}
      </p>
      <div className="table-wrap limited">
        <table>
          <thead>
            <tr>
              <th>Filename</th>
              <th>Type</th>
              <th>Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {files.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.filename}</strong>
                  <small>{c.relativePath}</small>
                </td>
                <td>{c.mime.split("/")[1]?.toUpperCase() ?? "Unsupported"}</td>
                <td>{bytes(c.size)}</td>
                <td>
                  <Badge status={c.status} />
                  {c.error && <small className="danger-text">{c.error}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
function MappingEditor({ onContinue }: { onContinue: () => void }) {
  const { batch, setBatch, history, run, busy } = useApp();
  const [mapping, setMapping] = useState<Mapping>(
    batch?.mapping ?? { name: "", email: "", certificate: "" },
  );
  useEffect(() => {
    if (batch?.mapping) setMapping(batch.mapping);
  }, [batch?.mapping]);
  if (!batch?.headers.length) return null;
  return (
    <div className="mapping">
      <h3>Column mapping</h3>
      <p>
        Values are preserved exactly. Uncertain columns require your selection.
      </p>
      <div className="form-grid">
        {(["name", "email", "certificate", "certificate_id"] as const).map(
          (key) => (
            <label key={key}>
              {
                {
                  name: "Recipient name",
                  email: "Email address",
                  certificate: "Certificate filename",
                  certificate_id: "Certificate ID (optional)",
                }[key]
              }
              <select
                value={mapping[key] ?? ""}
                onChange={(e) =>
                  setMapping({ ...mapping, [key]: e.target.value })
                }
              >
                <option value="">
                  {key === "certificate"
                    ? "No reference — require match approval"
                    : "Select column"}
                </option>
                {batch.headers.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </select>
            </label>
          ),
        )}
      </div>
      <div className="card-actions">
        <span>Missing references are flagged, never silently ignored.</span>
        <button
          className="button primary"
          disabled={
            busy || !mapping.name || !mapping.email || batch.status !== "draft"
          }
          onClick={() =>
            run(async () => {
              setBatch(
                await api<Batch>("/batch/match", {
                  mapping,
                  history: duplicateHistory(history),
                }),
              );
              onContinue();
            })
          }
        >
          Analyze & match <Sparkles size={17} />
        </button>
      </div>
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status}`}>
      {["sent", "valid", "ready"].includes(status) && <Check size={12} />}{" "}
      {status}
    </span>
  );
}
function RecipientTable({
  records,
  editable = false,
}: {
  records: Recipient[];
  editable?: boolean;
}) {
  const { batch, setBatch, run, busy } = useApp();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState<"name" | "email" | "certificate" | "status">(
      "name",
    ),
    [desc, setDesc] = useState(false),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setPage(0), [query, filter]);
  const filtered = records
    .filter(
      (r) =>
        (filter === "all" ||
          (filter === "matched" && !!r.certificateId) ||
          (filter === "unmatched" && !r.certificateId) ||
          (filter === "valid" && !r.errors.length) ||
          (filter === "invalid" && !!r.errors.length) ||
          r.status === filter) &&
        `${r.name} ${r.email} ${r.certificate}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => a[sort].localeCompare(b[sort]) * (desc ? -1 : 1));
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 20) - 1),
  );
  const row = records.find((r) => r.id === selected);
  const action = (r: Recipient, action: string) =>
    run(async () =>
      setBatch(await api<Batch>("/batch/record", { id: r.id, action })),
    );
  return (
    <>
      <div className="table-tools">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search recipients"
            placeholder="Search name, email or certificate…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter recipients"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {[
            "all",
            "matched",
            "unmatched",
            "valid",
            "invalid",
            "ready",
            "blocked",
            "sent",
            "failed",
            "unknown",
            "skipped",
            "stopped",
          ].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {!filtered.length ? (
        <div className="empty compact">
          <Users size={28} />
          <h3>
            {records.length
              ? "No matching recipients"
              : "Your recipients will appear here"}
          </h3>
          <p>
            {records.length
              ? "Try another search or filter."
              : "Upload a CSV and analyze your certificate matches."}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {(["name", "email", "certificate", "status"] as const).map(
                  (key) => (
                    <th key={key}>
                      <button
                        onClick={() => {
                          setDesc(sort === key ? !desc : false);
                          setSort(key);
                        }}
                      >
                        {key[0].toUpperCase() + key.slice(1)}{" "}
                        {sort === key ? (desc ? "↓" : "↑") : ""}
                      </button>
                    </th>
                  ),
                )}
                <th>Match / action</th>
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice(currentPage * 20, currentPage * 20 + 20)
                .map((r, i) => (
                  <tr key={r.id}>
                    <td>{currentPage * 20 + i + 1}</td>
                    <td>
                      <button
                        className="row-name"
                        onClick={() => setSelected(r.id)}
                      >
                        {r.name || "Missing name"}
                      </button>
                    </td>
                    <td>{r.email}</td>
                    <td>{r.certificate || "—"}</td>
                    <td>
                      <Badge status={r.status} />
                    </td>
                    <td>
                      <small>{r.match}</small>
                      {editable &&
                        !["sent", "unknown", "skipped"].includes(r.status) && (
                          <div className="row-actions">
                            {!r.approved &&
                              r.certificateId &&
                              !r.errors.length && (
                                <button
                                  disabled={busy}
                                  onClick={() => setSelected(r.id)}
                                >
                                  Review match
                                </button>
                              )}
                            {r.warnings.some((w) =>
                              w.startsWith("POSSIBLE DUPLICATE"),
                            ) && (
                              <button
                                disabled={busy}
                                onClick={() => setSelected(r.id)}
                              >
                                Possible duplicate
                              </button>
                            )}
                            <button
                              disabled={busy}
                              onClick={() => action(r, "skip")}
                            >
                              Skip
                            </button>
                          </div>
                        )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>
          {filtered.length} recipients · Page {currentPage + 1} of{" "}
          {Math.max(1, Math.ceil(filtered.length / 20))}
        </span>
        <div>
          <button
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            aria-label="Next page"
            disabled={(currentPage + 1) * 20 >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      {row && (
        <Modal
          title={row.name || "Recipient details"}
          onClose={() => setSelected(null)}
        >
          <dl className="detail-list">
            <dt>Email</dt>
            <dd>{row.email}</dd>
            <dt>Certificate</dt>
            <dd>{row.certificate || "Missing"}</dd>
            <dt>Match method</dt>
            <dd>{row.match}</dd>
            <dt>Status</dt>
            <dd>
              <Badge status={row.status} />
            </dd>
            {row.gmailMessageId && (
              <>
                <dt>Gmail message ID</dt>
                <dd>{row.gmailMessageId}</dd>
              </>
            )}
            {row.timestamp && (
              <>
                <dt>Timestamp</dt>
                <dd>{row.timestamp}</dd>
              </>
            )}
          </dl>
          {[
            ...row.errors,
            ...row.warnings,
            ...(row.error ? [row.error] : []),
          ].map((e, i) => (
            <p className="notice" key={i}>
              {e}
            </p>
          ))}
          {batch?.filesAvailable && row.certificateId && (
            <a
              className="button secondary"
              href={`${API}/api/batch/attachment/${row.certificateId}`}
            >
              <Download size={16} /> Inspect certificate
            </a>
          )}
          {editable && row.status !== "sent" && row.status !== "unknown" && (
            <div className="modal-actions">
              {!row.approved && row.certificateId && !row.errors.length && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => action(row, "approve")}
                >
                  I verified this match
                </button>
              )}
              {row.warnings.some((w) => w.startsWith("POSSIBLE DUPLICATE")) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => action(row, "send-again")}
                >
                  Send again
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => action(row, "skip")}
              >
                Skip recipient
              </button>
            </div>
          )}
          {row.status === "failed" && <RetryButton records={[row]} />}
          {batch?.records.some((r) => r.id === row.id) && row.certificateId && (
            <EmailPreview fixedId={row.id} />
          )}
        </Modal>
      )}
    </>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="modal"
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Confirm({
  title,
  text,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  text: string;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{text}</p>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </Modal>
  );
}
function EmailEditor({ onContinue }: { onContinue: () => void }) {
  const { batch, setBatch, run, busy } = useApp();
  const [template, setTemplate] = useState<Template>(
      batch?.template ?? defaults,
    ),
    [field, setField] = useState<"body" | "subject">("body");
  useEffect(() => setTemplate(batch?.template ?? defaults), [batch?.template]);
  const dirty = JSON.stringify(template) !== JSON.stringify(batch?.template);
  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <h2>Write a note worth opening</h2>
          <p>
            Personalize the message. CertFlow wraps it in an email-compatible
            HTML card.
          </p>
        </div>
        <span className="tag">{dirty ? "Unsaved changes" : "Saved"}</span>
      </div>
      <div className="email-editor">
        <div className="editor-fields">
          <div className="form-grid">
            <label>
              Sender name
              <input
                value={template.senderName}
                onChange={(e) =>
                  setTemplate({ ...template, senderName: e.target.value })
                }
              />
            </label>
            <label>
              Event name
              <input
                value={template.event}
                onChange={(e) =>
                  setTemplate({ ...template, event: e.target.value })
                }
              />
            </label>
          </div>
          <label>
            Event date
            <input
              type="date"
              value={template.date}
              onChange={(e) =>
                setTemplate({ ...template, date: e.target.value })
              }
            />
          </label>
          <label>
            Subject
            <input
              maxLength={250}
              value={template.subject}
              onFocus={() => setField("subject")}
              onChange={(e) =>
                setTemplate({ ...template, subject: e.target.value })
              }
            />
          </label>
          <label>
            Message
            <textarea
              rows={14}
              value={template.body}
              onFocus={() => setField("body")}
              onChange={(e) =>
                setTemplate({ ...template, body: e.target.value })
              }
            />
          </label>
        </div>
        <aside className="variable-panel">
          <Sparkles size={24} />
          <h3>Make it theirs.</h3>
          <p>Click a variable to append it to the focused field.</p>
          {[
            "name",
            "email",
            "certificate",
            "event",
            "date",
            "certificate_id",
          ].map((v) => (
            <button
              key={v}
              onClick={() =>
                setTemplate({
                  ...template,
                  [field]: template[field] + `{{${v}}}`,
                })
              }
            >
              {`{{${v}}}`}
              <Plus size={14} />
            </button>
          ))}
          <small>
            Missing values block preview and sending. Text is escaped for safe
            HTML output.
          </small>
        </aside>
      </div>
      <div className="card-actions">
        <span>Saving changes requires a new test email.</span>
        <button
          className="button primary"
          disabled={busy || batch?.status !== "draft"}
          onClick={() =>
            run(async () => {
              if (dirty)
                setBatch(await api<Batch>("/email/template", template));
              onContinue();
            })
          }
        >
          Save & preview <ArrowRight size={17} />
        </button>
      </div>
    </section>
  );
}
function EmailPreview({ fixedId }: { fixedId?: string }) {
  const { batch } = useApp();
  const records = batch?.records.filter((r) => r.certificateId) ?? [];
  const [index, setIndex] = useState(0),
    [mobile, setMobile] = useState(false),
    [data, setData] = useState<{
      html: string;
      subject: string;
      from: string;
      to: string;
      certificate: string;
    } | null>(null),
    [error, setError] = useState("");
  const selected = fixedId
    ? records.find((r) => r.id === fixedId)
    : records[Math.min(index, records.length - 1)];
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    if (selected)
      void api<NonNullable<typeof data>>("/email/preview", { id: selected.id })
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, batch?.revision]);
  if (!selected)
    return (
      <div className="empty">
        <Mail size={30} />
        <h3>Match certificates to preview your emails</h3>
      </div>
    );
  return (
    <div className="email-preview">
      <div className="preview-controls">
        {!fixedId && (
          <div>
            <button
              aria-label="Previous recipient"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              {Math.min(index + 1, records.length)} / {records.length} ·{" "}
              {selected.name}
            </span>
            <button
              aria-label="Next recipient"
              disabled={index >= records.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        <div className="device-toggle">
          <button
            className={!mobile ? "chosen" : ""}
            onClick={() => setMobile(false)}
          >
            <Monitor size={16} /> Desktop
          </button>
          <button
            className={mobile ? "chosen" : ""}
            onClick={() => setMobile(true)}
          >
            <Smartphone size={16} /> Mobile
          </button>
        </div>
      </div>
      {error ? (
        <p className="notice danger-text">{error}</p>
      ) : !data ? (
        <div className="preview-loading">
          <LoaderCircle className="spin" /> Preparing email…
        </div>
      ) : (
        <div className={`gmail-window ${mobile ? "mobile-preview" : ""}`}>
          <div className="gmail-top">
            <span>
              <Mail size={18} /> Email preview
            </span>
            <MoreHorizontal size={18} />
          </div>
          <div className="gmail-meta">
            <h3>{data.subject}</h3>
            <p>
              <strong>From:</strong> {data.from}
            </p>
            <p>
              <strong>To:</strong> {data.to}
            </p>
            <a
              href={`${API}/api/batch/attachment/${selected.certificateId}`}
              className="attachment-link"
            >
              <Paperclip size={15} /> {data.certificate} <Download size={14} />
            </a>
          </div>
          <iframe
            sandbox=""
            referrerPolicy="no-referrer"
            title={`Email preview for ${selected.name}`}
            srcDoc={data.html}
          />
        </div>
      )}
    </div>
  );
}
function TestEmail({ onContinue }: { onContinue: () => void }) {
  const { batch, setBatch, user, run, busy } = useApp();
  const ready = batch?.records.filter((r) => r.status === "ready") ?? [];
  const [id, setId] = useState(ready[0]?.id ?? ""),
    [to, setTo] = useState(user ?? ""),
    [confirm, setConfirm] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    requestId.current = crypto.randomUUID();
    setConfirm(false);
  }, [id, to, batch?.revision]);
  const r = ready.find((r) => r.id === id);
  return (
    <section className="card test-card">
      <span className="eyebrow">ONE EMAIL. ONE FINAL CHECK.</span>
      <h2>Try it before you send it.</h2>
      <div className="notice">
        <ShieldCheck size={22} />
        <strong>
          TEST MODE — Only the selected test address will receive this email.
        </strong>
      </div>
      <p>
        Uses your actual Gmail account, current HTML template, and selected
        recipient’s real certificate.
      </p>
      <div className="form-grid">
        <label>
          Recipient data
          <select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select a ready recipient</option>
            {ready.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Send this one test to
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      <div className="attachment-preview">
        <Paperclip size={20} />
        <div>
          <strong>{r?.certificate ?? "Select a recipient above"}</strong>
          <small>Certificate tied to the selected recipient data.</small>
        </div>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />{" "}
        I approve sending this certificate to {to || "the test address"}.
      </label>
      <p className="muted">
        If you test to the recipient’s own address, that delivery is recorded as
        sent and excluded from bulk sending. A network error may require
        checking Gmail Sent.
      </p>
      {batch?.test && (
        <div className="notice success">
          <CheckCircle2 size={20} />
          <span>
            Test sent to {batch.test.to}.{" "}
            {batch.testedRevision === batch.revision
              ? "Current batch verified."
              : "The batch has changed; send a new test."}
          </span>
        </div>
      )}
      <div className="card-actions">
        <button
          className="button secondary"
          disabled={
            !r ||
            !to ||
            !confirm ||
            busy ||
            batch?.status !== "draft" ||
            batch.testedRevision === batch.revision
          }
          onClick={() =>
            run(async () => {
              setBatch(
                await api<Batch>("/email/test", {
                  id,
                  to,
                  requestId: requestId.current,
                  confirmed: true,
                }),
              );
              setConfirm(false);
            })
          }
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Send size={17} />
          )}{" "}
          Send test email
        </button>
        <button
          className="button primary"
          disabled={batch?.testedRevision !== batch?.revision}
          onClick={onContinue}
        >
          Final review <ArrowRight size={17} />
        </button>
      </div>
    </section>
  );
}
function FinalReview({ onSend }: { onSend: () => void }) {
  const { batch, user, setBatch, run, busy } = useApp();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [batch?.revision, batch?.batchId]);
  if (!batch) return null;
  const checks: [string, boolean][] = [
    ["Gmail connected", !!user],
    ["CSV loaded", !!batch.headers.length],
    ["ZIP loaded", batch.filesAvailable],
    [
      "Recipients valid or explicitly skipped",
      batch.blocked === 0 && batch.unknown === 0 && batch.total > 0,
    ],
    [
      "Certificates matched",
      batch.records
        .filter((r) => r.status === "ready")
        .every((r) => !!r.certificateId && r.approved),
    ],
    ["Attachments available", batch.filesAvailable],
    ["Current template tested", batch.testedRevision === batch.revision],
    ["Test email completed", !!batch.test],
  ];
  const allowed =
    checks.every(([, ok]) => ok) && batch.ready > 0 && batch.status === "draft";
  const warnings =
    batch.certificates.filter((c) => c.status !== "valid").length +
    batch.records.filter((r) => r.warnings.length && r.status !== "skipped")
      .length;
  return (
    <section className="card review-card">
      <div className="review-title">
        <div className="large-icon">
          <ShieldCheck size={30} />
        </div>
        <span className="eyebrow">A FINAL LOOK BEFORE LIFTOFF</span>
        <h2>Ready to make their day?</h2>
        <p>
          Sending from <strong>{user ?? "Gmail not connected"}</strong>
        </p>
      </div>
      <Stats
        items={[
          ["Ready", batch.ready],
          ["Matched", batch.records.filter((r) => r.certificateId).length],
          ["Blocked", batch.blocked + batch.unknown],
          ["Warnings", warnings],
          ["Already sent", batch.sent],
        ]}
      />
      <div className="checklist">
        {checks.map(([label, ok]) => (
          <div key={label} className={ok ? "ok" : ""}>
            {ok ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}{" "}
            {label}
          </div>
        ))}
      </div>
      {warnings > 0 && (
        <div className="notice">
          {warnings} file or recipient warnings remain in the review tables.
          Confirm only after you have inspected them. Skipped recipients and
          invalid files will not be sent.
        </div>
      )}
      <div className="confirmation-panel">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I have reviewed this batch, its attachments and warnings, and want to
          send it.
        </label>
        <button
          className="button primary send-button"
          disabled={!allowed || !confirmed || busy}
          onClick={() =>
            run(async () => {
              setBatch(
                await api<Batch>("/batch/send", {
                  batchId: batch.batchId,
                  revision: batch.revision,
                  confirmed: true,
                }),
              );
              onSend();
            })
          }
        >
          <Send size={18} /> Send {batch.ready} certificates{" "}
          <ArrowRight size={18} />
        </button>
        <small>
          One personalized email and one certificate per recipient. No CC. No
          BCC.
        </small>
      </div>
    </section>
  );
}
function Progress() {
  const { batch, setBatch, run, busy, connected, create } = useApp();
  const [stop, setStop] = useState(false);
  if (!batch) return null;
  const current = batch.records.find((r) => r.id === batch.currentRecipient);
  const live = active(batch);
  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">EVERY DELIVERY COUNTS</span>
          <h2>
            {batch.status === "complete"
              ? "Batch complete"
              : batch.status === "paused"
                ? "Sending paused"
                : batch.status === "stopped"
                  ? "Batch stopped"
                  : batch.status === "draft"
                    ? "Your batch is being prepared"
                    : "Sending certificates"}
          </h2>
          <p>
            {live
              ? "Keep this tab open. The active server session is temporary."
              : "Download your report for a lasting record."}
          </p>
        </div>
        <Badge status={batch.status} />
      </div>
      <div className="progress-track">
        <div
          style={{
            width: `${batch.total ? (batch.processed / batch.total) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="progress-caption">
        <strong>
          {batch.processed} / {batch.total} processed
        </strong>
        <span>
          {live
            ? connected
              ? "Live connection"
              : "Reconnecting · polling status"
            : "Final report"}
        </span>
      </div>
      <Stats
        items={[
          ["Sent", batch.sent],
          ["Failed", batch.failed],
          ["Uncertain", batch.unknown],
          [
            "Remaining",
            batch.records.filter((r) => ["ready", "sending"].includes(r.status))
              .length,
          ],
          ["Skipped", batch.skipped],
        ]}
      />
      {current && (
        <div className="current-recipient">
          <LoaderCircle className="spin" size={22} />
          <div>
            <strong>{current.name}</strong>
            <p>{current.email}</p>
            <small>{current.error ?? "Sending…"}</small>
          </div>
        </div>
      )}
      {batch.unknown > 0 && (
        <div className="notice">
          Some deliveries are uncertain. Check Gmail Sent before sending those
          certificates again. They are excluded from automatic retry.
        </div>
      )}
      <div className="report-actions">
        {live ? (
          <>
            {batch.status === "sending" && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setBatch(await api<Batch>("/batch/pause", {})),
                  )
                }
              >
                <Pause size={16} /> Pause
              </button>
            )}
            {batch.status === "paused" && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setBatch(await api<Batch>("/batch/resume", {})),
                  )
                }
              >
                <Play size={16} /> Resume
              </button>
            )}
            <button
              className="button danger"
              disabled={busy || batch.status === "stopping"}
              onClick={() => setStop(true)}
            >
              <Square size={16} />{" "}
              {batch.status === "stopping"
                ? "Stopping after current send…"
                : "Stop"}
            </button>
          </>
        ) : (
          <>
            <button
              className="button secondary"
              onClick={() =>
                download(
                  `certflow-${batch.batchId}.csv`,
                  reportCSV(batch.records),
                  "text/csv",
                )
              }
            >
              <Download size={16} /> CSV report
            </button>
            <button
              className="button secondary"
              onClick={() =>
                download(
                  `certflow-${batch.batchId}.json`,
                  JSON.stringify(
                    { version: 1, batches: [snapshot(batch)] },
                    null,
                    2,
                  ),
                )
              }
            >
              <Download size={16} /> JSON report
            </button>
            {batch.failed > 0 && <RetryButton records={batch.records} />}
            <button className="button primary" disabled={busy} onClick={create}>
              <Plus size={17} /> New batch
            </button>
          </>
        )}
      </div>
      <RecipientTable records={batch.records} />
      {stop && (
        <Confirm
          title="Stop sending this batch?"
          text="A message already in flight may finish. Remaining recipients will be marked stopped and temporary files will be deleted."
          action="Stop batch"
          onClose={() => setStop(false)}
          onConfirm={() => {
            setStop(false);
            void run(async () =>
              setBatch(await api<Batch>("/batch/stop", { confirmed: true })),
            );
          }}
        />
      )}
    </section>
  );
}
function RetryButton({ records }: { records: Recipient[] }) {
  const { run, setBatch, settings, notify } = useApp();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const failed = records.filter((r) => r.status === "failed");
  return (
    <>
      <button
        className="button secondary"
        disabled={!failed.length}
        onClick={() => setConfirm(true)}
      >
        Retry {failed.length === 1 ? "failed recipient" : "all failed"}
      </button>
      {confirm && (
        <Confirm
          title="Prepare a retry batch?"
          text="Only confirmed failures will be included. Upload the original certificate ZIP, then match, preview, test and explicitly confirm this new batch. Uncertain deliveries are excluded."
          action="Prepare retry"
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void run(async () => {
              await api("/batch/new", {});
              const { theme, ...template } = settings;
              await api("/email/template", template);
              const form = new FormData();
              form.append(
                "file",
                new File([retryCSV(failed)], "retry-recipients.csv", {
                  type: "text/csv",
                }),
              );
              setBatch(await api<Batch>("/batch/upload-csv", form));
              navigate("/app/new?step=0");
              notify(
                "Retry recipients loaded. Upload the original certificate ZIP.",
              );
            });
          }}
        />
      )}
    </>
  );
}
function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  return (
    <>
      {!entries.length ? (
        <div className="card empty compact">
          <History size={28} />
          <h3>A clean slate.</h3>
          <p>
            Your batch history will appear here after you analyze your first
            recipients.
          </p>
        </div>
      ) : (
        <div className="card history-list">
          {entries.map((b) => (
            <button
              className="history-row"
              key={b.batchId}
              onClick={() => setSelected(b)}
            >
              <span className="history-icon">
                <FileCheck2 size={22} />
              </span>
              <div>
                <strong>Batch {b.batchId.slice(0, 8).toUpperCase()}</strong>
                <small>
                  {formatDate(b.createdAt)} · {b.records.length} recipients
                </small>
              </div>
              <span className="history-count">
                {b.records.filter((r) => r.status === "sent").length} sent
              </span>
              <Badge status={b.status} />
              <ArrowUpRight size={18} />
            </button>
          ))}
        </div>
      )}
      {selected && (
        <Modal
          title={`Batch ${selected.batchId.slice(0, 8).toUpperCase()}`}
          onClose={() => setSelected(null)}
        >
          <p>
            {formatDate(selected.createdAt)} · {selected.records.length}{" "}
            recipients
          </p>
          {["sending", "paused", "stopping"].includes(selected.status) && (
            <div className="notice">
              This is a local snapshot, not proof that the server is still
              processing. Check the active batch and Gmail Sent before
              resending.
            </div>
          )}
          <div className="report-actions">
            <button
              className="button secondary"
              onClick={() =>
                download(
                  `certflow-${selected.batchId}.csv`,
                  reportCSV(selected.records),
                  "text/csv",
                )
              }
            >
              <Download size={16} /> Export CSV
            </button>
            <button
              className="button secondary"
              onClick={() =>
                download(
                  `certflow-${selected.batchId}.json`,
                  JSON.stringify({ version: 1, batches: [selected] }, null, 2),
                )
              }
            >
              <Download size={16} /> Export JSON
            </button>
            <RetryButton records={selected.records} />
          </div>
          <RecipientTable records={selected.records} />
        </Modal>
      )}
    </>
  );
}
function HistoryPage() {
  const { history, setHistory, notify, run, batch } = useApp();
  const ref = useRef<HTMLInputElement>(null);
  const [clear, setClear] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="A RECORD OF EVERY MOMENT"
        title="Batch history"
        description="History is stored locally in this browser unless exported."
        action={
          <div className="report-actions">
            <button
              className="button secondary"
              onClick={() => ref.current?.click()}
            >
              <Upload size={16} /> Import
            </button>
            <button
              className="button primary"
              onClick={() =>
                download(
                  "certflow-history.json",
                  JSON.stringify({ version: 1, batches: history }, null, 2),
                )
              }
            >
              <Download size={16} /> Export history
            </button>
          </div>
        }
      />
      <input
        hidden
        ref={ref}
        type="file"
        accept=".json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            void run(async () => {
              if (f.size > 20 * 1024 * 1024)
                throw Error("History file exceeds 20 MB.");
              const entries = parseHistory(await f.text());
              setHistory(mergeHistory(history, entries));
              notify("History imported. Existing sent records were preserved.");
            });
          e.target.value = "";
        }}
      />
      <div className="notice">
        <History size={20} />
        <span>
          Duplicate protection uses this browser’s history. It does not provide
          global protection across devices. Import a backup before sending from
          a new browser.
        </span>
      </div>
      <HistoryList entries={history} />
      <div className="card-actions">
        <span>{history.length} local batches</span>
        <button
          className="text-button danger-text"
          disabled={active(batch)}
          onClick={() => setClear(true)}
        >
          Delete local history
        </button>
      </div>
      {clear && (
        <Confirm
          title="Delete local history?"
          text="This removes your browser’s batch records and duplicate protection. Export a backup first. Sent emails will not be affected."
          action="Delete history"
          onClose={() => setClear(false)}
          onConfirm={() => {
            try {
              setHistory([]);
              setClear(false);
              notify("Local history deleted.");
            } catch (e) {
              notify((e as Error).message, true);
            }
          }}
        />
      )}
    </>
  );
}
function SettingsPage() {
  const { user, settings, setSettings, notify, run, busy, batch } = useApp();
  const [form, setForm] = useState(settings),
    [disconnect, setDisconnect] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="MAKE CERTFLOW YOURS"
        title="Settings"
        description="Your account, sending defaults, and local preferences."
      />
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Gmail account</h2>
            <p>{user ?? "No Gmail account connected"}</p>
          </div>
          {user && <Badge status="connected" />}
        </div>
        <div className="report-actions">
          <GoogleButton small />
          {user && (
            <button
              className="button secondary"
              disabled={busy || active(batch)}
              onClick={() => setDisconnect(true)}
            >
              <LogOut size={16} /> Disconnect
            </button>
          )}
        </div>
        <p className="muted">
          Reconnect using Continue with Google. Finish or stop an active batch
          first.
        </p>
      </section>
      <form
        className="card settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setSettings(form);
            notify("Settings saved. Sending defaults apply to new batches.");
          } catch {
            notify("Settings could not be saved in this browser.", true);
          }
        }}
      >
        <h2>Sending defaults</h2>
        <div className="form-grid">
          <label>
            Sender name
            <input
              required
              maxLength={100}
              value={form.senderName}
              onChange={(e) => setForm({ ...form, senderName: e.target.value })}
            />
          </label>
          <label>
            Event name
            <input
              value={form.event}
              onChange={(e) => setForm({ ...form, event: e.target.value })}
            />
          </label>
          <label>
            Event date
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </label>
          <label>
            Retry attempts (0–5)
            <input
              type="number"
              min="0"
              max="5"
              value={form.retryAttempts}
              onChange={(e) =>
                setForm({ ...form, retryAttempts: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Email delay (milliseconds)
            <input
              type="number"
              min="1000"
              max="60000"
              step="100"
              value={form.emailDelay}
              onChange={(e) =>
                setForm({ ...form, emailDelay: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Theme
            <select
              value={form.theme}
              onChange={(e) =>
                setForm({ ...form, theme: e.target.value as Settings["theme"] })
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
        </div>
        <label>
          Default subject
          <input
            required
            maxLength={250}
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </label>
        <label>
          Default template
          <textarea
            required
            rows={8}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </label>
        <div className="card-actions">
          <span>
            Retries apply only to confirmed temporary Gmail rejections.
          </span>
          <button className="button primary" type="submit">
            Save settings <Check size={16} />
          </button>
        </div>
      </form>
      <section className="card">
        <h2>Local history</h2>
        <p>
          No OAuth credentials are stored in your browser history. History
          contains recipient names, emails, certificate names and delivery
          results.
        </p>
        <div className="report-actions">
          <Link className="button secondary" to="/app/history">
            Manage history <ArrowRight size={16} />
          </Link>
          <button
            className="button secondary"
            onClick={() =>
              download(
                "certflow-history-backup.json",
                localStorage.getItem("certflow.history.v1") ??
                  '{"version":1,"batches":[]}',
              )
            }
          >
            Export raw backup
          </button>
        </div>
      </section>
      {disconnect && (
        <Confirm
          title="Disconnect Gmail?"
          text="Your temporary attachments will be deleted and Google authorization revoked. Browser-local history remains available."
          action="Disconnect"
          onClose={() => setDisconnect(false)}
          onConfirm={() =>
            run(async () => {
              await api("/auth/logout", {});
              window.location.href = "/";
            })
          }
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
