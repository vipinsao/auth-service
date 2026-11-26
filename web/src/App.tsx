import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { api, onRequest, refreshSession, type LogEntry } from "./api";

type User = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  emailVerified: boolean;
  createdAt: string;
};

type View = "loading" | "login" | "register" | "dashboard";
type Notice = { kind: "ok" | "error"; text: string } | null;

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    onRequest((entry) => setLog((prev) => [entry, ...prev].slice(0, 12)));
    void loadUser();
  }, []);

  /**
   * Who am I? If the short-lived access token has expired, try the refresh
   * token once (the server rotates it), then ask again. Otherwise show login.
   */
  async function loadUser() {
    let me = await api<User>("GET", "/auth/self");
    if (me.status === 401) {
      const refreshed = await refreshSession();
      if (refreshed.ok) me = await api<User>("GET", "/auth/self");
    }
    if (me.ok && me.data) {
      setUser(me.data);
      setView("dashboard");
    } else {
      setUser(null);
      setView("login");
    }
  }

  function go(next: View) {
    setNotice(null);
    setView(next);
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Auth Service</h1>
        <p className="subtitle">
          Live demo of a TypeScript + PostgreSQL authentication API.{" "}
          <a href="https://github.com/vipinsao/auth-service">
            Source on GitHub
          </a>
          {" · "}
          <a href="/api-docs">API docs</a>
        </p>
        <p className="demo-note">
          Public demo: please don't use a real password. Accounts may be wiped.
        </p>
      </header>

      <main className="layout">
        <section className="card">
          {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}
          {view === "loading" && <p>Checking your session…</p>}
          {view === "login" && (
            <LoginForm
              onDone={loadUser}
              onError={setNotice}
              onSwitch={() => go("register")}
            />
          )}
          {view === "register" && (
            <RegisterForm
              onDone={loadUser}
              onError={setNotice}
              onSwitch={() => go("login")}
            />
          )}
          {view === "dashboard" && user && (
            <Dashboard
              user={user}
              onNotice={setNotice}
              onLoggedOut={() => {
                setUser(null);
                go("login");
              }}
            />
          )}
        </section>

        <aside className="card log">
          <h2>Requests</h2>
          <p className="muted">
            Every call this page makes to the API. A 401 on first load just
            means you are not logged in yet.
          </p>
          {log.length === 0 && <p className="muted">None yet.</p>}
          <ul>
            {log.map((entry) => (
              <li key={entry.id}>
                <span className="method">{entry.method}</span>
                <span className="path">{entry.path}</span>
                <span className={`status s${String(entry.status)[0]}`}>
                  {entry.status || "network error"}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}

type FormProps = {
  onDone: () => Promise<void>;
  onError: (notice: Notice) => void;
  onSwitch: () => void;
};

function LoginForm({ onDone, onError, onSwitch }: FormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api("POST", "/auth/login", { email, password });
    setBusy(false);
    if (!result.ok) return onError({ kind: "error", text: result.error! });
    onError(null);
    await onDone();
  }

  return (
    <form onSubmit={submit}>
      <h2>Log in</h2>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Logging in…" : "Log in"}
      </button>
      <p className="muted">
        No account?{" "}
        <button type="button" className="link" onClick={onSwitch}>
          Create one
        </button>
      </p>
    </form>
  );
}

function RegisterForm({ onDone, onError, onSwitch }: FormProps) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);

  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [name]: e.target.value }),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api("POST", "/auth/register", form);
    setBusy(false);
    if (!result.ok) return onError({ kind: "error", text: result.error! });
    onError(null);
    await onDone();
  }

  return (
    <form onSubmit={submit}>
      <h2>Create an account</h2>
      <div className="row">
        <label>
          First name
          <input {...field("firstName")} autoComplete="given-name" required />
        </label>
        <label>
          Last name
          <input {...field("lastName")} autoComplete="family-name" required />
        </label>
      </div>
      <label>
        Email
        <input type="email" {...field("email")} autoComplete="email" required />
      </label>
      <label>
        Password
        <input
          type="password"
          {...field("password")}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <span className="hint">
          At least 8 characters; very common passwords are refused.
        </span>
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </button>
      <p className="muted">
        Already registered?{" "}
        <button type="button" className="link" onClick={onSwitch}>
          Log in
        </button>
      </p>
    </form>
  );
}

type DashboardProps = {
  user: User;
  onNotice: (notice: Notice) => void;
  onLoggedOut: () => void;
};

function Dashboard({ user, onNotice, onLoggedOut }: DashboardProps) {
  async function rotate() {
    const result = await refreshSession();
    onNotice(
      result.ok
        ? {
            kind: "ok",
            text: "New access and refresh tokens issued. The old refresh token is now revoked; reusing it would end this session.",
          }
        : { kind: "error", text: result.error! },
    );
  }

  async function callAdminRoute() {
    const result = await api<{ users: unknown[] }>("GET", "/users");
    if (result.ok) {
      onNotice({
        kind: "ok",
        text: `Admin access granted: ${result.data!.users.length} users.`,
      });
    } else if (result.status === 403) {
      onNotice({
        kind: "ok",
        text: `403 Forbidden, as expected: your role is "${user.role}", and only admins may list users. That is role-based access control at work.`,
      });
    } else {
      onNotice({ kind: "error", text: result.error! });
    }
  }

  async function logout() {
    await api("POST", "/auth/logout");
    onLoggedOut();
  }

  return (
    <div>
      <h2>
        Hello, {user.firstName} {user.lastName}
      </h2>
      <dl className="profile">
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Email verified</dt>
        <dd>{user.emailVerified ? "Yes" : "No"}</dd>
        <dt>Member since</dt>
        <dd>{new Date(user.createdAt).toLocaleString()}</dd>
      </dl>

      <div className="actions">
        <button type="button" onClick={rotate}>
          Rotate refresh token
        </button>
        <button type="button" onClick={callAdminRoute}>
          Call admin-only route
        </button>
        <button type="button" className="secondary" onClick={logout}>
          Log out
        </button>
      </div>

      <div className="explain">
        <h3>Where are the tokens?</h3>
        <p>
          In <code>httpOnly</code> cookies, so this page's JavaScript cannot
          read them. <code>document.cookie</code> here returns:{" "}
          <strong>{document.cookie ? document.cookie : "(empty)"}</strong>
        </p>
      </div>
    </div>
  );
}
