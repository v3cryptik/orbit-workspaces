import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity as ActivityIcon,
  Bell,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  FolderKanban,
  CalendarRange,
  Clock3,
  BarChart3,
  Globe2,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Orbit,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  request,
  json,
  type User,
  type Workspace,
  type Member,
  type Role,
  type Activity,
  type Invitation,
  type Overview,
  type ApiOptions,
} from "./api";
import "./styles.css";
import { WorkArea } from "./work/WorkArea";
import { InboxView, MailDeliveryPanel } from "./collaboration/Collaboration";
import { useWorkspaceLive } from "./collaboration/useLive";
import { MyTasks } from "./collaboration/MyTasks";
import { PlanningArea } from "./planning/Planning";
import type { Inbox, Navigation } from "../shared/collaboration";

type View =
  | "overview"
  | "projects"
  | "inbox"
  | "my-tasks"
  | "sprints"
  | "timesheets"
  | "reports"
  | "members"
  | "activity"
  | "settings";
type Modal = "create" | "invite" | "help" | { remove: Member } | null;
const roleCopy: Record<Role, string> = {
  owner: "Full control of this workspace",
  admin: "Manages workspace details and members",
  member: "Participates in workspace projects",
  guest: "Limited access to shared work",
};
const nav: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "inbox", label: "Inbox", icon: Bell },
  { id: "my-tasks", label: "My tasks", icon: CheckCheck },
  { id: "sprints", label: "Sprints", icon: CalendarRange },
  { id: "timesheets", label: "Timesheets", icon: Clock3 },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "members", label: "Members", icon: Users },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "settings", label: "Settings", icon: Settings2 },
];
const initial = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const titleCase = (value: string) => value[0].toUpperCase() + value.slice(1);
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
function time(value: string) {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date(value);
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "small" : ""}`} aria-hidden="true">
      {initial(name)}
    </span>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Orbit size={23} strokeWidth={1.7} />
      </span>
      <span>
        orbit<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function Spinner() {
  return <LoaderCircle className="spinner" size={18} aria-label="Loading" />;
}
function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function ModalShell({
  open,
  title,
  description,
  children,
  close,
}: {
  open: boolean;
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Close
            className="icon-button modal-close"
            aria-label="Close dialog"
          >
            <X size={18} />
          </Dialog.Close>
          <Dialog.Title className="modal-title">{title}</Dialog.Title>
          <Dialog.Description className="modal-description">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AuthPage({
  onAuth,
  invitation,
}: {
  onAuth: (user: User) => void;
  invitation: boolean;
}) {
  const [register, setRegister] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await request<{ user: User }>(
        `/auth/${register ? "register" : "login"}`,
        { method: "POST", body: json(values) },
      );
      onAuth(result.user);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-main">
        <Brand />
        <div className="auth-form-wrap">
          <div className="eyebrow">A LITTLE SPACE. A LOT OF POSSIBILITY.</div>
          <h1>{register ? "Good work starts here." : "Welcome back."}</h1>
          <p className="muted">
            {invitation
              ? "Sign in or create an account with your invited email to join your team."
              : register
                ? "Create your account. Bring your people together."
                : "Sign in to pick up where you left off."}
          </p>
          <form onSubmit={submit} className="form-stack">
            {register && (
              <Field label="Your name">
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  minLength={2}
                  maxLength={80}
                  required
                />
              </Field>
            )}
            <Field label="Email address">
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                maxLength={254}
                required
              />
            </Field>
            <Field
              label="Password"
              hint={register ? "At least 10 characters." : undefined}
            >
              <input
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 10 : 1}
                maxLength={128}
                placeholder="Enter your password"
                required
              />
            </Field>
            <ErrorMessage error={error} />
            <button disabled={busy} className="button primary full">
              {busy ? (
                <Spinner />
              ) : (
                <>
                  {register ? "Create account" : "Sign in"}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <p className="auth-switch">
            {register ? "Already have an account?" : "New to Orbit?"}{" "}
            <button
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError("");
              }}
            >
              {register ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
        <footer className="auth-footer">
          A shared space for your team and its work.
        </footer>
      </section>
      <aside className="auth-art">
        <div className="art-top">
          <span className="tiny-dot" /> ROOM TO DO YOUR BEST WORK
        </div>
        <div className="orbit-illustration">
          <div className="orbital orbital-one" />
          <div className="orbital orbital-two" />
          <div className="orbital orbital-three" />
          <span className="planet planet-one" />
          <span className="planet planet-two" />
          <div className="orbit-core">
            <Orbit size={68} strokeWidth={1} />
          </div>
          <div className="art-label label-people">
            <Users size={16} /> Your people
          </div>
          <div className="art-label label-work">
            <FolderKanban size={16} /> Your next big thing
          </div>
        </div>
        <div className="art-caption">
          <span className="art-index">01 / ONE SHARED SPACE</span>
          <h2>
            Bring the team.
            <br />
            Find your rhythm.
          </h2>
          <p>
            A workspace for every team.
            <br />A place for everything that comes next.
          </p>
        </div>
        <div className="art-bottom">
          LESS FRICTION. MORE FORWARD.
          <ArrowUpRight size={18} />
        </div>
      </aside>
    </div>
  );
}

function CreateWorkspace({
  create,
}: {
  create: (values: {
    name: string;
    slug: string;
    description: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [customSlug, setCustomSlug] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await create({ name, slug, description });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <Field label="Workspace name">
        <input
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!customSlug)
              setSlug(
                event.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "")
                  .slice(0, 50),
              );
          }}
          placeholder="e.g. Studio North"
          minLength={2}
          maxLength={80}
          required
        />
      </Field>
      <Field
        label="Workspace address"
        hint="A unique address using lowercase letters, numbers, and hyphens."
      >
        <div className="input-prefix">
          <span>orbit /</span>
          <input
            aria-label="Workspace address"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              setCustomSlug(true);
            }}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            minLength={3}
            maxLength={50}
            placeholder="studio-north"
            required
          />
        </div>
      </Field>
      <Field label="Description · optional">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What is your team working toward?"
          maxLength={300}
          rows={3}
        />
      </Field>
      <ErrorMessage error={error} />
      <button className="button primary full" disabled={busy}>
        {busy ? (
          <Spinner />
        ) : (
          <>
            Create workspace
            <ArrowRight size={16} />
          </>
        )}
      </button>
    </form>
  );
}

function InviteForm({
  invite,
}: {
  invite: (values: { email: string; role: string }) => Promise<{ url: string }>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [delivery, setDelivery] = useState("local");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await invite(
        Object.fromEntries(new FormData(event.currentTarget)) as {
          email: string;
          role: string;
        },
      );
      setLink(result.url);
      setDelivery((result as { delivery?: string }).delivery ?? "local");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return link ? (
    <div className="form-stack">
      <div className="success-note">
        <CheckCheck size={20} />
        <span>Invitation ready to share</span>
      </div>
      <p className="muted">
        Send this link to your teammate. It works once, expires in 48 hours, and
        can only be accepted with their invited email.
      </p>
      <Field label="Invitation link">
        <input
          value={link}
          readOnly
          onFocus={(event) => event.target.select()}
        />
      </Field>
      <button
        className="button primary full"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          } catch {
            setError("Select the link above and copy it manually.");
          }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
        {copied ? "Copied to clipboard" : "Copy invitation link"}
      </button>
      <ErrorMessage error={error} />
      <p className="fine-print">
        {delivery === "queued"
          ? "The invitation email is queued for delivery. You can also share the link directly."
          : "The invitation email is captured in your private local mailbox under Members. No external email was sent."}
      </p>
    </div>
  ) : (
    <form className="form-stack" onSubmit={submit}>
      <Field label="Email address">
        <input
          name="email"
          type="email"
          placeholder="teammate@company.com"
          required
          maxLength={254}
        />
      </Field>
      <Field label="Workspace role">
        <select name="role" defaultValue="member">
          <option value="member">Member — participates in projects</option>
          <option value="guest">Guest — limited access</option>
        </select>
      </Field>
      <div className="inline-note">
        <ShieldCheck size={18} />
        <span>Only this email address can accept the invitation.</span>
      </div>
      <ErrorMessage error={error} />
      <button className="button primary full" disabled={busy}>
        {busy ? (
          <Spinner />
        ) : (
          <>
            Create invitation link
            <ArrowRight size={16} />
          </>
        )}
      </button>
    </form>
  );
}

function ActivityList({
  items,
  full = false,
}: {
  items: Activity[];
  full?: boolean;
}) {
  return (
    <div className={`activity-list ${full ? "full-activity" : ""}`}>
      {items.length === 0 ? (
        <div className="small-empty">Your team's updates will appear here.</div>
      ) : (
        items.map((item) => (
          <div className="activity-row" key={item._id}>
            <div className="activity-avatar">
              <Avatar name={item.actorName} small />
            </div>
            <div className="activity-copy">
              <p>
                <strong>{item.actorName}</strong> {item.detail}.
              </p>
              <time dateTime={item.createdAt}>{time(item.createdAt)}</time>
            </div>
            {full && (
              <span className="activity-event">
                {item.action.split(".")[0]}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [active, setActive] = useState<Workspace | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [allActivity, setAllActivity] = useState<Activity[]>([]);
  const [inboxData, setInboxData] = useState<Inbox>({
    notifications: [],
    unread: 0,
  });
  const [workNavigation, setWorkNavigation] = useState<Navigation | null>(null);
  const [view, setView] = useState<View>("overview");
  const [modal, setModal] = useState<Modal>(null);
  const [switcher, setSwitcher] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [inviteToken, setInviteToken] = useState(() =>
    new URLSearchParams(location.search).get("invite"),
  );
  const [accepting, setAccepting] = useState(false);
  const context = useRef<{
    workspaceId: string;
    token: string;
    generation: number;
  } | null>(null);
  const generation = useRef(0);
  const switcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    request<{ user: User }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch((error) => {
        if (error.status !== 401) setError(error.message);
      })
      .finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!switcher) return;
    const close = (event: MouseEvent) => {
      if (!switcherRef.current?.contains(event.target as Node))
        setSwitcher(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSwitcher(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [switcher]);
  async function scoped<T>(
    path: string,
    options: ApiOptions = {},
    ctx = context.current,
  ): Promise<T> {
    if (!ctx) throw new Error("Choose a workspace first.");
    try {
      return await request<T>(`/w/${ctx.workspaceId}${path}`, {
        ...options,
        headers: { ...options.headers, "x-workspace-token": ctx.token },
      });
    } catch (error) {
      if ((error as Error).message.includes("workspace session expired")) {
        const renewed = await request<{ token: string }>(
          `/workspaces/${ctx.workspaceId}/session`,
          { method: "POST" },
        );
        ctx.token = renewed.token;
        return request<T>(`/w/${ctx.workspaceId}${path}`, {
          ...options,
          headers: { ...options.headers, "x-workspace-token": ctx.token },
        });
      }
      throw error;
    }
  }
  async function refresh(ctx = context.current) {
    if (!ctx) return;
    const result = await scoped<Overview>("/overview", {}, ctx);
    if (context.current !== ctx) return;
    setOverview(result);
    setActive(result.workspace);
    setWorkspaces((items) =>
      items.map((item) =>
        item.id === result.workspace.id ? result.workspace : item,
      ),
    );
    const [activity, invites, inbox] = await Promise.all([
      scoped<{ activity: Activity[] }>("/activity", {}, ctx),
      result.permissions.manageMembers
        ? scoped<{ invites: Invitation[] }>("/invites", {}, ctx)
        : Promise.resolve({ invites: [] }),
      scoped<Inbox>("/notifications", {}, ctx),
    ]);
    if (context.current !== ctx) return;
    setAllActivity(activity.activity);
    setInvitations(invites.invites);
    setInboxData(inbox);
  }
  async function selectWorkspace(workspace: Workspace) {
    const current = ++generation.current;
    context.current = null;
    setActive(workspace);
    setOverview(null);
    setAllActivity([]);
    setInvitations([]);
    setInboxData({ notifications: [], unread: 0 });
    setWorkNavigation(null);
    setLoading(true);
    setError("");
    setSwitcher(false);
    setModal(null);
    setMobileNav(false);
    setView("overview");
    setMemberFilter("");
    try {
      const result = await request<{ token: string; workspace: Workspace }>(
        `/workspaces/${workspace.id}/session`,
        { method: "POST" },
      );
      if (current !== generation.current) return;
      const ctx = {
        workspaceId: workspace.id,
        token: result.token,
        generation: current,
      };
      context.current = ctx;
      localStorage.setItem("orbit.workspace", workspace.id);
      await refresh(ctx);
    } catch (error) {
      if (current === generation.current) setError((error as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  async function loadWorkspaces(preferred?: string) {
    const result = await request<{ workspaces: Workspace[] }>("/workspaces");
    setWorkspaces(result.workspaces);
    const chosen =
      result.workspaces.find(
        (item) =>
          item.id === (preferred ?? localStorage.getItem("orbit.workspace")),
      ) ?? result.workspaces[0];
    if (chosen) await selectWorkspace(chosen);
    else {
      context.current = null;
      setActive(null);
    }
  }
  useEffect(() => {
    if (user) loadWorkspaces().catch((error) => setError(error.message));
  }, [user?.id]);
  async function logout() {
    try {
      await request("/auth/logout", { method: "POST" });
    } catch (error) {
      if ((error as { status?: number }).status !== 401) {
        setError((error as Error).message);
        return;
      }
    }
    ++generation.current;
    context.current = null;
    setUser(null);
    setActive(null);
    setOverview(null);
    setWorkspaces([]);
    setAllActivity([]);
    setInvitations([]);
    setError("");
    setToast("");
    setSwitcher(false);
    setView("overview");
    setModal(null);
    setMobileNav(false);
  }
  async function create(values: {
    name: string;
    slug: string;
    description: string;
  }) {
    const result = await request<{ workspace: Workspace }>("/workspaces", {
      method: "POST",
      body: json(values),
    });
    await loadWorkspaces(result.workspace.id);
    setModal(null);
    setToast("Your workspace is ready.");
  }
  async function acceptInvitation() {
    setAccepting(true);
    setError("");
    try {
      const result = await request<{ workspace: Workspace }>(
        "/invites/accept",
        { method: "POST", body: json({ token: inviteToken }) },
      );
      history.replaceState({}, "", "/");
      setInviteToken(null);
      await loadWorkspaces(result.workspace.id);
      setToast("You joined the workspace.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setAccepting(false);
    }
  }
  async function changeRole(member: Member, role: string) {
    const ctx = context.current;
    setBusyId(member.id);
    setError("");
    try {
      await scoped(
        `/members/${member.id}`,
        { method: "PATCH", body: json({ role }) },
        ctx,
      );
      await refresh(ctx);
      setToast("Member role updated.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusyId("");
    }
  }
  async function removeMember(member: Member) {
    const ctx = context.current;
    setBusyId(member.id);
    setError("");
    try {
      await scoped(`/members/${member.id}`, { method: "DELETE" }, ctx);
      await refresh(ctx);
      setModal(null);
      setToast("Member removed.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusyId("");
    }
  }
  const manage = !!overview?.permissions.manageMembers;
  const workContext = context.current;
  const live = useWorkspaceLive(
    workContext && overview ? active?.id : undefined,
    user?.id,
    async () => {
      const ctx = context.current;
      if (!ctx) throw new Error("No workspace");
      const result = await request<{ token: string }>(
        `/workspaces/${ctx.workspaceId}/session`,
        { method: "POST" },
      );
      if (context.current !== ctx) throw new Error("Workspace changed");
      ctx.token = result.token;
      return result.token;
    },
    () => {
      loadWorkspaces().catch(() => {
        context.current = null;
        setUser(null);
        setActive(null);
        setOverview(null);
        setInboxData({ notifications: [], unread: 0 });
      });
    },
  );
  useEffect(() => {
    if (live.pulse && context.current)
      refresh(context.current).catch((error) => setError(error.message));
  }, [live.pulse]);
  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
    setError("");
  };
  if (booting)
    return (
      <div className="boot">
        <Brand />
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <>
        <AuthPage invitation={!!inviteToken} onAuth={setUser} />
        {error && (
          <div className="standalone-error">
            <ErrorMessage error={error} />
          </div>
        )}
      </>
    );
  const members = overview?.members ?? [];
  const filteredMembers = members.filter((member) =>
    `${member.user.name} ${member.user.email} ${member.role}`
      .toLowerCase()
      .includes(memberFilter.toLowerCase()),
  );
  return (
    <div className="app-shell">
      {mobileNav && (
        <div className="sidebar-scrim" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="workspace-switch" ref={switcherRef}>
          <button
            className="workspace-trigger"
            aria-label="Switch workspace"
            aria-expanded={switcher}
            onClick={() => setSwitcher(!switcher)}
          >
            <span className="workspace-avatar">
              {active ? initial(active.name) : <Plus size={18} />}
            </span>
            <span className="workspace-trigger-copy">
              <strong>{active?.name ?? "Your workspace"}</strong>
              <small>
                {active
                  ? `${active.plan} workspace`
                  : "Make room for your team"}
              </small>
            </span>
            <ChevronDown size={15} />
          </button>
          {switcher && (
            <div className="workspace-menu">
              <div className="menu-search">
                <Search size={15} />
                <input
                  aria-label="Find a workspace"
                  placeholder="Find a workspace…"
                  value={workspaceFilter}
                  onChange={(event) => setWorkspaceFilter(event.target.value)}
                />
              </div>
              <div className="workspace-options">
                {workspaces
                  .filter((item) =>
                    item.name
                      .toLowerCase()
                      .includes(workspaceFilter.toLowerCase()),
                  )
                  .map((item) => (
                    <button
                      key={item.id}
                      className="workspace-option"
                      onClick={() => selectWorkspace(item)}
                    >
                      <span className="workspace-avatar mini">
                        {initial(item.name)}
                      </span>
                      <span>
                        {item.name}
                        <small>{titleCase(item.role)}</small>
                      </span>
                      {item.id === active?.id && <Check size={15} />}
                    </button>
                  ))}
                {!workspaces.some((item) =>
                  item.name
                    .toLowerCase()
                    .includes(workspaceFilter.toLowerCase()),
                ) && <p className="menu-empty">No workspaces found.</p>}
              </div>
              <button
                className="create-workspace-menu"
                onClick={() => {
                  setSwitcher(false);
                  setModal("create");
                }}
              >
                <Plus size={16} />
                Create workspace
              </button>
            </div>
          )}
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Workspace navigation">
          {nav
            .filter(
              (item) => !(item.id === "timesheets" && active?.role === "guest"),
            )
            .map((item) => (
              <button
                key={item.id}
                disabled={!active}
                className={`nav-item ${view === item.id && active ? "selected" : ""}`}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} strokeWidth={1.65} />
                {item.label}
                {item.id === "members" && members.length > 0 && (
                  <span className="nav-count">{members.length}</span>
                )}
                {item.id === "inbox" && inboxData.unread > 0 && (
                  <span className="nav-count unread-count">
                    {inboxData.unread}
                  </span>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <span className="note-icon">
              <Sparkles size={17} />
            </span>
            <strong>Better, together.</strong>
            <p>
              A little space for your team
              <br />
              and everything ahead.
            </p>
            {manage && (
              <button onClick={() => setModal("invite")}>
                Invite your teammates
                <ArrowUpRight size={14} />
              </button>
            )}
          </div>
          <button
            className="nav-item help-button"
            onClick={() => setModal("help")}
          >
            <CircleHelp size={18} />
            Workspace guide
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <Avatar name={user.name} />
            <span>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button
              className="icon-button"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span>{active?.name ?? "Getting started"}</span>
            <ChevronRight size={13} />
            <strong>{active ? titleCase(view) : "Welcome"}</strong>
          </div>
          <div className="topbar-right">
            {active && (
              <>
                <span
                  className={`live-status ${live.status === "Live" ? "online" : ""}`}
                >
                  <span />
                  {live.status}
                </span>
                <button
                  className="icon-button notification-bell"
                  aria-label={`Open inbox${inboxData.unread ? `, ${inboxData.unread} unread` : ""}`}
                  onClick={() => navigate("inbox")}
                >
                  <Bell size={17} />
                  {inboxData.unread > 0 && <i />}
                </button>
              </>
            )}
            <span className="today">
              {new Date().toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              onClick={() => setModal("help")}
              aria-label="Open workspace guide"
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main className="main-content">
          {inviteToken && (
            <div className="invite-banner">
              <div>
                <UserPlus size={20} />
                <span>
                  <strong>You have a workspace invitation</strong>
                  <small>
                    Accept with {user.email}, or sign out to use a different
                    account.
                  </small>
                </span>
              </div>
              <button
                className="button primary"
                onClick={acceptInvitation}
                disabled={accepting}
              >
                {accepting ? <Spinner /> : "Accept invitation"}
              </button>
            </div>
          )}
          {error && (
            <div className="page-error">
              <ErrorMessage error={error} />
              <button
                className="text-button"
                onClick={() =>
                  active ? selectWorkspace(active) : loadWorkspaces()
                }
              >
                Retry
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!active ? (
            <div className="onboarding">
              <div className="onboarding-orbit">
                <Orbit size={52} strokeWidth={1} />
              </div>
              <span className="eyebrow">YOUR NEXT CHAPTER</span>
              <h1>Make space for good work.</h1>
              <p>
                Create a workspace for your team. Keep your people,
                <br className="desktop-break" /> projects, and progress in one
                place.
              </p>
              <button
                className="button primary"
                onClick={() => setModal("create")}
              >
                <Plus size={17} />
                Create your first workspace
              </button>
              <div className="onboarding-details">
                <span>
                  <ShieldCheck size={16} />
                  Private to your team
                </span>
                <span>
                  <Users size={16} />
                  Made for working together
                </span>
              </div>
            </div>
          ) : loading || !overview ? (
            <div className="content-loading">
              <Spinner />
              <span>
                {error
                  ? "Workspace could not be loaded."
                  : "Opening your workspace…"}
              </span>
            </div>
          ) : (
            <div key={`${active.id}-${view}`} className="view-enter">
              {view !== "projects" &&
                view !== "inbox" &&
                view !== "sprints" &&
                view !== "timesheets" &&
                view !== "reports" &&
                view !== "my-tasks" && (
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">
                        {view === "overview"
                          ? "THE BIG PICTURE"
                          : view === "members"
                            ? "YOUR PEOPLE"
                            : view === "activity"
                              ? "KEEP IN THE LOOP"
                              : "MAKE IT YOURS"}
                      </div>
                      <h1>
                        {view === "overview"
                          ? "Workspace overview"
                          : view === "members"
                            ? "The people behind the work."
                            : view === "activity"
                              ? "A little progress, every day."
                              : "Workspace settings"}
                      </h1>
                      <p>
                        {view === "overview"
                          ? active.description ||
                            "Your team, your space, and everything ahead."
                          : view === "members"
                            ? "Bring your team together and give everyone the right access."
                            : view === "activity"
                              ? "A shared history of what’s happening in your workspace."
                              : "The details that make this space your own."}
                      </p>
                    </div>
                    {(view === "overview" || view === "members") && manage && (
                      <button
                        className="button primary"
                        onClick={() => setModal("invite")}
                      >
                        <UserPlus size={16} />
                        Invite member
                      </button>
                    )}
                  </div>
                )}
              {view === "projects" && workContext && (
                <WorkArea
                  key={active.id}
                  workspace={active}
                  user={user}
                  members={members}
                  api={(path, options) => scoped(path, options, workContext)}
                  changed={() => refresh(workContext)}
                  notify={setToast}
                  pulse={live.pulse}
                  liveStatus={live.status}
                  navigation={workNavigation}
                />
              )}
              {view === "inbox" && workContext && (
                <InboxView
                  data={inboxData}
                  api={(path, options) => scoped(path, options, workContext)}
                  refresh={() => refresh(workContext)}
                  open={(navigation) => {
                    setWorkNavigation(navigation);
                    navigate("projects");
                  }}
                />
              )}
              {view === "my-tasks" && workContext && (
                <MyTasks
                  key={active.id}
                  api={(path, options) => scoped(path, options, workContext)}
                  pulse={live.pulse}
                  open={(navigation) => {
                    setWorkNavigation(navigation);
                    navigate("projects");
                  }}
                />
              )}
              {workContext &&
                (view === "sprints" ||
                  view === "timesheets" ||
                  view === "reports") && (
                  <PlanningArea
                    key={`${active.id}-${view}`}
                    view={view}
                    api={(path, options) => scoped(path, options, workContext)}
                    workspace={active}
                    user={user}
                    members={members}
                    pulse={live.pulse}
                    notify={setToast}
                    open={(navigation) => {
                      setWorkNavigation(navigation);
                      navigate("projects");
                    }}
                  />
                )}
              {view === "overview" && (
                <>
                  <div className="overview-stats">
                    <div className="stat">
                      <span className="stat-label">
                        <Users size={16} />
                        Workspace members
                      </span>
                      <div>
                        <strong>
                          {members.length.toString().padStart(2, "0")}
                        </strong>
                        <span>
                          {members.length === 1
                            ? "A great place to start"
                            : "Working better together"}
                        </span>
                      </div>
                    </div>
                    <div className="stat">
                      <span className="stat-label">
                        <ShieldCheck size={16} />
                        Your access
                      </span>
                      <div>
                        <strong className="stat-word">
                          {titleCase(active.role)}
                        </strong>
                        <span>
                          {active.role === "owner"
                            ? "This is your workspace"
                            : "Your role in the team"}
                        </span>
                      </div>
                    </div>
                    <div className="stat">
                      <span className="stat-label">
                        <Globe2 size={16} />
                        Workspace address
                      </span>
                      <div>
                        <strong className="stat-slug">/{active.slug}</strong>
                        <span>One home for your team</span>
                      </div>
                    </div>
                  </div>
                  <div className="overview-columns">
                    <section className="main-column">
                      <div className="section-heading">
                        <h2>Your workspace</h2>
                        <span className="label-tag">
                          <span />
                          Active
                        </span>
                      </div>
                      <div className="workspace-feature">
                        <div className="feature-top">
                          <span className="feature-workspace-icon">
                            {initial(active.name)}
                          </span>
                          <div className="feature-orbits">
                            <span />
                            <span />
                            <Orbit size={75} strokeWidth={0.65} />
                          </div>
                          <span className="feature-label">A SHARED SPACE</span>
                        </div>
                        <div className="feature-body">
                          <div>
                            <h3>{active.name}</h3>
                            <p>
                              {active.description ||
                                "A fresh start for your team’s next chapter."}
                            </p>
                          </div>
                          <div className="feature-meta">
                            <span>
                              <Users size={14} />
                              {members.length}{" "}
                              {members.length === 1 ? "member" : "members"}
                            </span>
                            <span>Created {date(active.createdAt)}</span>
                          </div>
                          <button
                            className="feature-link"
                            onClick={() => navigate("projects")}
                          >
                            Open projects
                            <ArrowUpRight size={17} />
                          </button>
                        </div>
                      </div>
                      <div className="section-heading team-heading">
                        <h2>The team</h2>
                        <button
                          className="text-button subtle"
                          onClick={() => navigate("members")}
                        >
                          View all
                          <ArrowRight size={14} />
                        </button>
                      </div>
                      <div className="compact-members">
                        {members.slice(0, 4).map((member) => (
                          <div className="compact-member" key={member.id}>
                            <Avatar name={member.user.name} />
                            <span>
                              <strong>
                                {member.user.name}
                                {member.user.id === user.id && (
                                  <small> (you)</small>
                                )}
                              </strong>
                              <small>{member.user.email}</small>
                            </span>
                            <span className={`role-badge ${member.role}`}>
                              {titleCase(member.role)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                    <aside className="context-column">
                      <div className="section-heading">
                        <h2>Recent activity</h2>
                        <ActivityIcon size={16} />
                      </div>
                      <ActivityList items={overview.activity} />
                      <button
                        className="activity-all"
                        onClick={() => navigate("activity")}
                      >
                        All workspace activity
                        <ArrowRight size={15} />
                      </button>
                      <div className="getting-started">
                        <span className="eyebrow">SETTLE IN</span>
                        <h3>A good place to begin.</h3>
                        <p>Make this workspace feel like your team's home.</p>
                        <div className="start-step complete">
                          <span>
                            <Check size={12} />
                          </span>
                          <div>
                            <strong>Create a workspace</strong>
                            <small>You’re right where you need to be.</small>
                          </div>
                        </div>
                        <button
                          className={`start-step ${members.length > 1 ? "complete" : ""}`}
                          onClick={() =>
                            manage ? setModal("invite") : navigate("members")
                          }
                        >
                          <span>
                            {members.length > 1 ? <Check size={12} /> : "2"}
                          </span>
                          <div>
                            <strong>Bring your people</strong>
                            <small>
                              {members.length > 1
                                ? "Your team is coming together."
                                : "Good work is a team effort."}
                            </small>
                          </div>
                          <ArrowUpRight size={14} />
                        </button>
                        <button
                          className={`start-step ${active.description ? "complete" : ""}`}
                          onClick={() => navigate("settings")}
                        >
                          <span>
                            {active.description ? <Check size={12} /> : "3"}
                          </span>
                          <div>
                            <strong>Add a little context</strong>
                            <small>Give your workspace a description.</small>
                          </div>
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                    </aside>
                  </div>
                </>
              )}
              {view === "members" && (
                <>
                  <div className="members-toolbar">
                    <div className="tab-label">
                      All members <span>{members.length}</span>
                    </div>
                    <label className="search-input">
                      <Search size={16} />
                      <input
                        aria-label="Search members"
                        placeholder="Search name or email…"
                        value={memberFilter}
                        onChange={(event) =>
                          setMemberFilter(event.target.value)
                        }
                      />
                    </label>
                  </div>
                  <div className="table-scroll">
                    <table className="members-table">
                      <thead>
                        <tr>
                          <th>Member</th>
                          <th>Workspace role</th>
                          <th>Joined</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMembers.map((member) => {
                          const editable =
                            manage &&
                            member.role !== "owner" &&
                            member.user.id !== user.id &&
                            (active.role === "owner" ||
                              member.role !== "admin");
                          return (
                            <tr key={member.id}>
                              <td>
                                <div className="table-member">
                                  <Avatar name={member.user.name} />
                                  <span>
                                    <strong>
                                      {member.user.name}
                                      {member.user.id === user.id && (
                                        <em>you</em>
                                      )}
                                    </strong>
                                    <small>{member.user.email}</small>
                                  </span>
                                </div>
                              </td>
                              <td>
                                {editable ? (
                                  <select
                                    aria-label={`Role for ${member.user.name}`}
                                    value={member.role}
                                    disabled={busyId === member.id}
                                    onChange={(event) =>
                                      changeRole(member, event.target.value)
                                    }
                                  >
                                    {active.role === "owner" && (
                                      <option value="admin">Admin</option>
                                    )}
                                    <option value="member">Member</option>
                                    <option value="guest">Guest</option>
                                  </select>
                                ) : (
                                  <span className={`role-badge ${member.role}`}>
                                    {titleCase(member.role)}
                                  </span>
                                )}
                              </td>
                              <td className="date-cell">
                                {date(member.joinedAt)}
                              </td>
                              <td>
                                {editable && (
                                  <button
                                    className="icon-button"
                                    aria-label={`Remove ${member.user.name}`}
                                    onClick={() => setModal({ remove: member })}
                                    disabled={busyId === member.id}
                                  >
                                    <X size={16} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {filteredMembers.length === 0 && (
                      <div className="small-empty">
                        No members match “{memberFilter}”.
                      </div>
                    )}
                  </div>
                  {manage && (
                    <section className="pending-section">
                      <div className="section-heading">
                        <h2>
                          Pending invitations{" "}
                          <span className="number-badge">
                            {invitations.length}
                          </span>
                        </h2>
                      </div>
                      {invitations.length ? (
                        invitations.map((invite) => (
                          <div className="pending-row" key={invite._id}>
                            <span className="pending-icon">
                              <UserPlus size={17} />
                            </span>
                            <div>
                              <strong>{invite.email}</strong>
                              <small>
                                {titleCase(invite.role)} · Expires{" "}
                                {date(invite.expiresAt)}
                              </small>
                            </div>
                            <button
                              className="button quiet"
                              disabled={busyId === invite._id}
                              onClick={async () => {
                                const ctx = context.current;
                                setBusyId(invite._id);
                                try {
                                  await scoped(
                                    `/invites/${invite._id}`,
                                    { method: "DELETE" },
                                    ctx,
                                  );
                                  await refresh(ctx);
                                  setToast("Invitation revoked.");
                                } catch (error) {
                                  setError((error as Error).message);
                                } finally {
                                  setBusyId("");
                                }
                              }}
                            >
                              Revoke
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="pending-empty">
                          <UserPlus size={20} />
                          <span>
                            No invitations pending. Your next teammate is one
                            invite away.
                          </span>
                        </div>
                      )}
                    </section>
                  )}
                  <div className="permissions-footnote">
                    <ShieldCheck size={16} />
                    <span>
                      Owners and admins manage membership. Only owners can
                      manage admin access.
                    </span>
                  </div>
                  {manage && workContext && (
                    <MailDeliveryPanel
                      key={active.id}
                      api={(path, options) =>
                        scoped(path, options, workContext)
                      }
                      pulse={live.pulse + invitations.length}
                    />
                  )}
                </>
              )}
              {view === "activity" && (
                <section className="activity-page">
                  <div className="section-heading">
                    <h2>Latest updates</h2>
                    <span className="muted small-text">
                      Most recent 50 events
                    </span>
                  </div>
                  <ActivityList items={allActivity} full />
                </section>
              )}
              {view === "settings" && (
                <WorkspaceSettings
                  key={active.id}
                  workspace={active}
                  canEdit={!!overview.permissions.editWorkspace}
                  save={async (values) => {
                    const ctx = context.current;
                    await scoped(
                      "/settings",
                      { method: "PATCH", body: json(values) },
                      ctx,
                    );
                    await refresh(ctx);
                    setToast("Workspace details saved.");
                  }}
                />
              )}
            </div>
          )}
        </main>
        <footer className="app-footer">
          <span>
            <Orbit size={13} />A little more connected.
          </span>
          <span>ORBIT WORKSPACES</span>
        </footer>
      </div>
      <ModalShell
        open={modal === "create"}
        title="A new space for your team."
        description="Create a workspace. You can invite your people next."
        close={() => setModal(null)}
      >
        <CreateWorkspace create={create} />
      </ModalShell>
      <ModalShell
        open={modal === "invite"}
        title="Good work takes good people."
        description={`Invite someone to ${active?.name ?? "your workspace"}.`}
        close={() => setModal(null)}
      >
        {modal === "invite" && (
          <InviteForm
            invite={async (values) => {
              const ctx = context.current;
              const result = await scoped<{ url: string }>(
                "/invites",
                { method: "POST", body: json(values) },
                ctx,
              );
              await refresh(ctx);
              return result;
            }}
          />
        )}
      </ModalShell>
      <ModalShell
        open={modal === "help"}
        title="A little workspace guide."
        description="A few things to help your team get settled."
        close={() => setModal(null)}
      >
        <div className="guide-list">
          <div>
            <Users size={20} />
            <span>
              <strong>A workspace for each team</strong>
              <p>
                Switch teams using the workspace menu. Each space has its own
                members and activity.
              </p>
            </span>
          </div>
          <div>
            <UserPlus size={20} />
            <span>
              <strong>Bring your teammates</strong>
              <p>
                Create an invitation in Members. Share the link with the invited
                email address; it expires in 48 hours.
              </p>
            </span>
          </div>
          <div>
            <ShieldCheck size={20} />
            <span>
              <strong>The right level of access</strong>
              <p>
                Owners manage everything. Admins manage details and members.
                Members and guests can view this workspace.
              </p>
            </span>
          </div>
        </div>
      </ModalShell>
      <ModalShell
        open={typeof modal === "object" && modal !== null}
        title="Remove this member?"
        description={
          typeof modal === "object" && modal
            ? `${modal.remove.user.name} will lose access to this workspace. You can invite them again later.`
            : ""
        }
        close={() => setModal(null)}
      >
        <div className="modal-actions">
          <button className="button" onClick={() => setModal(null)}>
            Keep member
          </button>
          <button
            className="button danger"
            disabled={!!busyId}
            onClick={() =>
              typeof modal === "object" && modal && removeMember(modal.remove)
            }
          >
            {busyId ? <Spinner /> : "Remove member"}
          </button>
        </div>
      </ModalShell>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={14} />
          </span>
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function WorkspaceSettings({
  workspace,
  canEdit,
  save,
}: {
  workspace: Workspace;
  canEdit: boolean;
  save: (values: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    name !== workspace.name || description !== workspace.description;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save({ name, description });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-layout">
      <section>
        <div className="section-heading">
          <h2>General</h2>
        </div>
        <form className="form-stack settings-form" onSubmit={submit}>
          <Field label="Workspace name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={80}
              disabled={!canEdit}
              required
            />
          </Field>
          <Field
            label="Description"
            hint="A short introduction for everyone who joins your team."
          >
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={300}
              rows={4}
              disabled={!canEdit}
            />
          </Field>
          <Field
            label="Workspace address"
            hint="Your workspace address stays the same when you rename it."
          >
            <div className="input-prefix">
              <span>orbit /</span>
              <input value={workspace.slug} readOnly />
            </div>
          </Field>
          <ErrorMessage error={error} />
          {canEdit ? (
            <div className="settings-actions">
              <span>
                {dirty ? "You have unsaved changes." : "All changes saved."}
              </span>
              <button className="button primary" disabled={busy || !dirty}>
                {busy ? <Spinner /> : "Save changes"}
              </button>
            </div>
          ) : (
            <div className="inline-note">
              <ShieldCheck size={17} />
              <span>Only owners and admins can edit workspace details.</span>
            </div>
          )}
        </form>
      </section>
      <aside className="settings-context">
        <ShieldCheck size={24} strokeWidth={1.3} />
        <h3>
          One space.
          <br />
          The right access.
        </h3>
        <p>
          Your role is <strong>{workspace.role}</strong>.{" "}
          {roleCopy[workspace.role]}.
        </p>
        <dl>
          <div>
            <dt>Workspace plan</dt>
            <dd>{workspace.plan}</dd>
          </div>
          <div>
            <dt>Created on</dt>
            <dd>{date(workspace.createdAt)}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
