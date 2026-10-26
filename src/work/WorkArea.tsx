import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  useDroppable,
  pointerWithin,
  closestCorners,
  DragOverlay,
  type DragEndEvent,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  Circle,
  CircleDashed,
  Clock3,
  FolderKanban,
  GripVertical,
  LayoutGrid,
  List,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Tag,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { json, type User, type Member, type Workspace } from "../api";
import {
  statusNames,
  priorityNames,
  taskStatuses,
  taskPriorities,
  type BoardSnapshot,
  type Project,
  type ProjectValues,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskValues,
} from "../../shared/work";
import "./work.css";
import {
  TaskCollaboration,
  type ScopedApi,
} from "../collaboration/Collaboration";
import type { Navigation } from "../../shared/collaboration";
import type { Sprint } from "../../shared/planning";

type WorkspaceApi = ScopedApi;
type Props = {
  workspace: Workspace;
  user: User;
  members: Member[];
  api: WorkspaceApi;
  changed: () => Promise<void>;
  notify: (message: string) => void;
  pulse: number;
  liveStatus: string;
  navigation: Navigation | null;
};
type Drawer = { id: string } | { create: TaskStatus; parentTaskId?: string };
type Filters = {
  search: string;
  status: string;
  priority: string;
  assignee: string;
  label: string;
  sprint: string;
};
const emptyFilters: Filters = {
  search: "",
  status: "",
  priority: "",
  assignee: "",
  label: "",
  sprint: "",
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const date = (value: string) =>
  new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const overdue = (task: Task) => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return !!task.dueDate && task.status !== "done" && task.dueDate < today;
};
const taskCode = (project: Project, task: Task) =>
  `${project.key}-${task.number}`;
function StatusIcon({
  status,
  size = 14,
}: {
  status: TaskStatus;
  size?: number;
}) {
  const Icon =
    status === "done"
      ? CheckCircle2
      : status === "in_progress"
        ? Clock3
        : status === "backlog"
          ? CircleDashed
          : Circle;
  return (
    <Icon
      size={size}
      className={`status-icon status-${status}`}
      strokeWidth={1.7}
    />
  );
}
function Priority({
  value,
  words = false,
}: {
  value: TaskPriority;
  words?: boolean;
}) {
  const Icon =
    value === "urgent"
      ? TriangleAlert
      : value === "high"
        ? SignalHigh
        : value === "medium"
          ? SignalMedium
          : SignalLow;
  return (
    <span
      className={`task-priority priority-${value}`}
      title={`${priorityNames[value]} priority`}
    >
      <Icon size={14} strokeWidth={1.8} />
      {words && priorityNames[value]}
    </span>
  );
}
function Person({
  member,
  small = false,
}: {
  member?: Member;
  small?: boolean;
}) {
  return member ? (
    <span
      className={`work-avatar ${small ? "small" : ""}`}
      title={member.user.name}
    >
      {initials(member.user.name)}
    </span>
  ) : (
    <span
      className={`work-avatar unassigned ${small ? "small" : ""}`}
      title="Unassigned"
    >
      <UserRound size={13} />
    </span>
  );
}
function WorkDialog({
  title,
  description,
  children,
  close,
  wide = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal-content work-modal ${wide ? "wide" : ""}`}
        >
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
function ErrorNote({ message }: { message: string }) {
  return message ? (
    <div role="alert" className="work-error">
      <TriangleAlert size={16} />
      <span>{message}</span>
    </div>
  ) : null;
}

export function WorkArea({
  workspace,
  user,
  members,
  api,
  changed,
  notify,
  pulse,
  liveStatus,
  navigation,
}: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [projectModal, setProjectModal] = useState<"create" | "edit" | null>(
    null,
  );
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [mode, setMode] = useState<"board" | "list">("board");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  useEffect(() => {
    let active = true;
    setSprints([]);
    if (selectedId)
      api<{ sprints: Sprint[] }>(`/projects/${selectedId}/sprints`)
        .then((value) => {
          if (active) setSprints(value.sprints);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [selectedId, pulse]);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectStatus, setProjectStatus] = useState("active");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const selection = useRef<string | null>(null);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const keyboardTarget = useRef<string | null>(null);
  const manager = ["owner", "admin"].includes(workspace.role);
  const writable =
    workspace.role !== "guest" && snapshot?.project.status === "active";
  const keyboardCoordinates: KeyboardCoordinateGetter = (
    event,
    { context },
  ) => {
    if (
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)
    )
      return;
    event.preventDefault();
    const tasks = snapshot?.tasks.filter((task) => !task.parentTaskId) ?? [];
    const currentId =
      keyboardTarget.current ?? String(context.over?.id ?? context.active?.id);
    const currentTask = tasks.find((task) => task.id === currentId);
    const currentStatus =
      currentTask?.status ?? (currentId.replace("column:", "") as TaskStatus);
    if (!taskStatuses.includes(currentStatus)) return;
    let targetId: string | undefined;
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      const nextStatus =
        taskStatuses[
          taskStatuses.indexOf(currentStatus) +
            (event.code === "ArrowLeft" ? -1 : 1)
        ];
      if (!nextStatus) return;
      const column = tasks
        .filter((task) => task.status === nextStatus)
        .sort((a, b) => a.order - b.order);
      targetId =
        column[Math.min(currentTask?.order ?? 0, column.length - 1)]?.id ??
        `column:${nextStatus}`;
    } else {
      const column = tasks
        .filter((task) => task.status === currentStatus)
        .sort((a, b) => a.order - b.order);
      const index = currentTask
        ? column.findIndex((task) => task.id === currentTask.id)
        : 0;
      targetId = column[index + (event.code === "ArrowUp" ? -1 : 1)]?.id;
    }
    if (!targetId) return;
    const rect = context.droppableRects.get(targetId);
    if (rect) {
      keyboardTarget.current = targetId;
      return { x: rect.left, y: rect.top };
    }
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
    }),
  );
  useEffect(() => {
    alive.current = true;
    reloadProjects().finally(() => {
      if (alive.current) setLoading(false);
    });
    return () => {
      alive.current = false;
      ++loadSequence.current;
    };
  }, [workspace.id]);
  async function reloadProjects() {
    try {
      const result = await api<{ projects: Project[] }>("/projects");
      if (alive.current) setProjects(result.projects);
      return result.projects;
    } catch (error) {
      if (alive.current) setError((error as Error).message);
      return null;
    }
  }
  async function openProject(projectId: string) {
    const sequence = ++loadSequence.current;
    selection.current = projectId;
    setSelectedId(projectId);
    setSnapshot(null);
    setLoading(true);
    setError("");
    setFilters(emptyFilters);
    setDrawer(null);
    try {
      const result = await api<BoardSnapshot>(`/projects/${projectId}/board`);
      if (alive.current && loadSequence.current === sequence)
        setSnapshot((previous) =>
          previous &&
          previous.project.id === result.project.id &&
          previous.project.boardVersion > result.project.boardVersion
            ? previous
            : result,
        );
    } catch (error) {
      if (alive.current && loadSequence.current === sequence)
        setError((error as Error).message);
    } finally {
      if (alive.current && loadSequence.current === sequence) setLoading(false);
    }
  }
  function back() {
    ++loadSequence.current;
    selection.current = null;
    setSelectedId(null);
    setSnapshot(null);
    setDrawer(null);
    setError("");
    reloadProjects();
  }
  async function reloadBoard(projectId = selection.current) {
    if (!projectId) return;
    const result = await api<BoardSnapshot>(`/projects/${projectId}/board`);
    if (alive.current && selection.current === projectId)
      setSnapshot((previous) =>
        previous &&
        previous.project.id === result.project.id &&
        previous.project.boardVersion > result.project.boardVersion
          ? previous
          : result,
      );
    return result;
  }
  useEffect(() => {
    if (!pulse || busy) return;
    let current = true;
    void reloadProjects();
    if (selection.current)
      void reloadBoard().catch((error) => {
        if (current && alive.current) {
          if ([403, 404].includes(error.status)) {
            selection.current = null;
            setSelectedId(null);
            setSnapshot(null);
            setDrawer(null);
          }
          setError(error.message);
        }
      });
    return () => {
      current = false;
    };
  }, [pulse, busy]);
  useEffect(() => {
    if (navigation)
      void openProject(navigation.projectId).then(() => {
        if (
          alive.current &&
          selection.current === navigation.projectId &&
          navigation.taskId
        )
          setDrawer({ id: navigation.taskId });
      });
  }, [navigation?.nonce]);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    message: string,
  ) {
    if (!snapshot) throw new Error("Open a project first.");
    const projectId = snapshot.project.id;
    setBusy(true);
    setError("");
    try {
      const result = await api<BoardSnapshot>(path, {
        method,
        body: json(body),
      });
      if (alive.current && selection.current === projectId) {
        setSnapshot((previous) =>
          previous &&
          previous.project.id === result.project.id &&
          previous.project.boardVersion > result.project.boardVersion
            ? previous
            : result,
        );
        notify(message);
      }
      await reloadProjects();
      await changed().catch(() => {});
      return result;
    } catch (error) {
      if (alive.current && selection.current === projectId) {
        setError((error as Error).message);
        if ((error as { status?: number }).status === 409)
          await reloadBoard(projectId).catch(() => {});
      }
      throw error;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const roots = snapshot?.tasks.filter((task) => !task.parentTaskId) ?? [];
  const filtering = Object.values(filters).some(Boolean);
  const visible = roots.filter((task) => {
    const text =
      `${task.title} ${task.description} ${snapshot!.project.key}-${task.number} ${task.labels.join(" ")}`.toLowerCase();
    return (
      (!filters.search || text.includes(filters.search.toLowerCase())) &&
      (!filters.status || task.status === filters.status) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!filters.label || task.labels.includes(filters.label)) &&
      (!filters.sprint ||
        (filters.sprint === "none"
          ? !task.sprintId
          : task.sprintId === filters.sprint)) &&
      (!filters.assignee ||
        (filters.assignee === "unassigned"
          ? !task.assigneeId
          : task.assigneeId === filters.assignee))
    );
  });
  const labels = [...new Set(roots.flatMap((task) => task.labels))].sort();
  async function move(
    taskId: string,
    status: TaskStatus,
    beforeId: string | null,
  ) {
    if (!snapshot || !writable || busy) return;
    const previous = snapshot;
    const moving = snapshot.tasks.find((task) => task.id === taskId)!;
    const destination = roots
      .filter((task) => task.status === status && task.id !== taskId)
      .sort((a, b) => a.order - b.order);
    destination.splice(
      beforeId
        ? destination.findIndex((task) => task.id === beforeId)
        : destination.length,
      0,
      { ...moving, status },
    );
    const newOrders = new Map(
      destination.map((task, index) => [task.id, index]),
    );
    setSnapshot({
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.id === taskId
          ? { ...task, status, order: newOrders.get(task.id)! }
          : newOrders.has(task.id)
            ? { ...task, order: newOrders.get(task.id)! }
            : task,
      ),
    });
    try {
      await mutate(
        `/projects/${snapshot.project.id}/tasks/${taskId}/move`,
        "PATCH",
        { status, beforeId, boardVersion: snapshot.project.boardVersion },
        "Task moved.",
      );
    } catch (error) {
      if (alive.current && selection.current === previous.project.id) {
        if ((error as { status?: number }).status !== 409) {
          setSnapshot(previous);
          await reloadBoard(previous.project.id).catch(() => {});
        }
      }
    }
  }
  function dragEnd(event: DragEndEvent) {
    setDraggedId(null);
    keyboardTarget.current = null;
    const { active, over } = event;
    if (!over || !snapshot || active.id === over.id) return;
    const task = roots.find((task) => task.id === active.id);
    if (!task) return;
    const target = roots.find((task) => task.id === over.id);
    const status =
      target?.status ?? (String(over.id).replace("column:", "") as TaskStatus);
    if (!taskStatuses.includes(status)) return;
    const column = roots
      .filter((item) => item.status === status && item.id !== task.id)
      .sort((a, b) => a.order - b.order);
    let beforeId = target?.id ?? null;
    if (target && target.status === task.status && task.order < target.order)
      beforeId =
        column[column.findIndex((item) => item.id === target.id) + 1]?.id ??
        null;
    move(task.id, status, beforeId);
  }
  const collision: CollisionDetection = (args) => {
    if (
      !args.pointerCoordinates &&
      keyboardTarget.current &&
      args.droppableContainers.some(
        (container) =>
          container.id === keyboardTarget.current && !container.disabled,
      )
    )
      return [{ id: keyboardTarget.current }];
    const hits = pointerWithin(args);
    const cards = hits.filter((hit) => !String(hit.id).startsWith("column:"));
    return cards.length ? cards : hits.length ? hits : closestCorners(args);
  };
  function dragDescription(id: string | number) {
    const task = roots.find((task) => task.id === id);
    return task && snapshot
      ? `${taskCode(snapshot.project, task)}: ${task.title}`
      : `${statusNames[String(id).replace("column:", "") as TaskStatus] ?? "board"} column`;
  }
  const selectedTask =
    drawer && "id" in drawer
      ? snapshot?.tasks.find((task) => task.id === drawer.id)
      : undefined;
  const displayedProjects = projects.filter(
    (project) =>
      (!projectStatus || project.status === projectStatus) &&
      `${project.name} ${project.key} ${project.description}`
        .toLowerCase()
        .includes(projectSearch.toLowerCase()),
  );

  return (
    <div className="work-area">
      {!selectedId ? (
        <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">A PLACE FOR THE WORK</div>
              <h1>Projects</h1>
              <p>Turn your team’s ideas into something you can move forward.</p>
            </div>
            {manager && (
              <button
                className="button primary"
                onClick={() => setProjectModal("create")}
              >
                <Plus size={16} />
                New project
              </button>
            )}
          </div>
          <div className="project-toolbar">
            <div className="work-tabs" aria-label="Project status">
              {[
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
                { id: "", label: "All projects" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  aria-pressed={projectStatus === tab.id}
                  className={projectStatus === tab.id ? "current" : ""}
                  onClick={() => setProjectStatus(tab.id)}
                >
                  {tab.label}
                  <span>
                    {
                      projects.filter((p) => !tab.id || p.status === tab.id)
                        .length
                    }
                  </span>
                </button>
              ))}
            </div>
            <label className="search-input">
              <Search size={15} />
              <input
                aria-label="Search projects"
                placeholder="Search projects…"
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </label>
          </div>
          <ErrorNote message={error} />
          {loading ? (
            <div className="work-loading">
              <LoaderCircle className="spinner" size={19} />
              Loading projects…
            </div>
          ) : displayedProjects.length ? (
            <div className="project-list">
              <div className="project-list-head">
                <span>Project</span>
                <span>Progress</span>
                <span>Lead</span>
                <span />
              </div>
              {displayedProjects.map((project) => {
                const lead = members.find(
                  (member) => member.user.id === project.leadId,
                );
                return (
                  <button
                    key={project.id}
                    className="project-row"
                    onClick={() => openProject(project.id)}
                  >
                    <span className="project-name-cell">
                      <span className="project-mark">
                        <FolderKanban size={20} strokeWidth={1.4} />
                      </span>
                      <span>
                        <strong>
                          {project.name}
                          {project.status === "archived" && (
                            <span className="archived-label">Archived</span>
                          )}
                        </strong>
                        <small>
                          {project.key} <span>·</span>{" "}
                          {project.description || "No description yet"}
                        </small>
                      </span>
                    </span>
                    <span className="project-progress">
                      <span>
                        <span
                          style={{
                            width: `${project.taskCount ? (project.completedCount / project.taskCount) * 100 : 0}%`,
                          }}
                        />
                      </span>
                      <small>
                        {project.completedCount}/{project.taskCount} tasks
                      </small>
                    </span>
                    <span className="project-lead">
                      <Person member={lead} />
                      <span>{lead?.user.name.split(" ")[0] ?? "No lead"}</span>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="project-empty">
              <span className="empty-project-mark">
                <FolderKanban size={32} strokeWidth={1.25} />
              </span>
              <h2>
                {projectSearch
                  ? "No projects match your search."
                  : projectStatus === "archived"
                    ? "Nothing on the shelf yet."
                    : workspace.role === "guest"
                      ? "Your shared projects will appear here."
                      : "Your next project starts here."}
              </h2>
              <p>
                {projectSearch
                  ? "Try another name or project key."
                  : projectStatus === "archived"
                    ? "Archived projects stay available for reference."
                    : workspace.role === "guest"
                      ? "Ask an owner or admin to share a project with you."
                      : "Give your work a home, then break it into manageable tasks."}
              </p>
              {manager && !projectSearch && projectStatus !== "archived" && (
                <button
                  className="button primary"
                  onClick={() => setProjectModal("create")}
                >
                  <Plus size={16} />
                  Create a project
                </button>
              )}
            </div>
          )}
          <div className="work-footnote">
            <ShieldCheck size={14} />
            {workspace.role === "guest"
              ? "You can view only projects shared with you."
              : "Projects belong to this workspace. Guests see only projects shared with them."}
          </div>
        </>
      ) : (
        <>
          <button className="back-to-projects" onClick={back}>
            <ArrowLeft size={14} />
            All projects
          </button>
          {loading || !snapshot ? (
            <>
              <ErrorNote message={error} />
              <div className="work-loading">
                <LoaderCircle size={19} className="spinner" />
                {error ? "Project could not be opened." : "Opening project…"}
              </div>
              {error && (
                <button
                  className="button"
                  onClick={() => openProject(selectedId)}
                >
                  Try again
                </button>
              )}
            </>
          ) : (
            <>
              <div className="project-page-heading">
                <div className="project-title-group">
                  <span className="project-mark large">
                    <FolderKanban size={24} strokeWidth={1.4} />
                  </span>
                  <div>
                    <div className="project-kicker">
                      {snapshot.project.key}
                      <span>·</span>
                      {snapshot.project.status === "archived"
                        ? "Archived project"
                        : "Workspace project"}
                    </div>
                    <h1>{snapshot.project.name}</h1>
                  </div>
                </div>
                <div className="project-heading-actions">
                  <button
                    className="icon-button"
                    aria-label="Refresh project"
                    title="Refresh project"
                    disabled={busy}
                    onClick={() =>
                      reloadBoard().catch((error) => setError(error.message))
                    }
                  >
                    <RefreshCw size={16} />
                  </button>
                  {manager && (
                    <button
                      className="button"
                      onClick={() => setProjectModal("edit")}
                      disabled={busy}
                    >
                      <Settings2 size={14} />
                      Settings
                    </button>
                  )}
                  {writable && (
                    <button
                      className="button primary"
                      onClick={() => setDrawer({ create: "todo" })}
                      disabled={busy}
                    >
                      <Plus size={16} />
                      New task
                    </button>
                  )}
                </div>
              </div>
              {snapshot.project.description && (
                <p className="project-description">
                  {snapshot.project.description}
                </p>
              )}
              <div className="project-subline">
                <span>
                  <span className="member-stack">
                    {members
                      .filter(
                        (member) =>
                          member.role !== "guest" ||
                          snapshot.project.guestIds.includes(member.user.id),
                      )
                      .slice(0, 4)
                      .map((member) => (
                        <Person key={member.id} member={member} small />
                      ))}
                  </span>
                  {snapshot.project.taskCount}{" "}
                  {snapshot.project.taskCount === 1 ? "task" : "tasks"}
                  <span className="subline-dot">·</span>
                  {snapshot.project.completedCount} completed
                </span>
                <span>
                  {workspace.role === "guest" ? (
                    <>
                      <ShieldCheck size={13} />
                      Read-only access
                    </>
                  ) : snapshot.project.status === "archived" ? (
                    <>
                      <Archive size={13} />
                      Archived · read-only
                    </>
                  ) : (
                    "Private to this workspace"
                  )}
                </span>
              </div>
              <div className="board-toolbar">
                <div className="work-tabs view-tabs">
                  <button
                    aria-pressed={mode === "board"}
                    className={mode === "board" ? "current" : ""}
                    onClick={() => setMode("board")}
                  >
                    <LayoutGrid size={14} />
                    Board
                  </button>
                  <button
                    aria-pressed={mode === "list"}
                    className={mode === "list" ? "current" : ""}
                    onClick={() => setMode("list")}
                  >
                    <List size={15} />
                    List
                  </button>
                </div>
                <span className="board-version">
                  {busy ? (
                    <>
                      <LoaderCircle size={12} className="spinner" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <CheckCheck size={13} />
                      {liveStatus === "Live"
                        ? "Live updates on"
                        : "Changes saved"}
                    </>
                  )}
                </span>
              </div>
              <div className="task-filterbar">
                <label className="task-search">
                  <Search size={15} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Search tasks…"
                    value={filters.search}
                    onChange={(event) =>
                      setFilters({ ...filters, search: event.target.value })
                    }
                  />
                </label>
                <select
                  aria-label="Filter by status"
                  value={filters.status}
                  onChange={(event) =>
                    setFilters({ ...filters, status: event.target.value })
                  }
                >
                  <option value="">All statuses</option>
                  {taskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {statusNames[status]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by assignee"
                  value={filters.assignee}
                  onChange={(event) =>
                    setFilters({ ...filters, assignee: event.target.value })
                  }
                >
                  <option value="">All assignees</option>
                  <option value={user.id}>Assigned to me</option>
                  <option value="unassigned">Unassigned</option>
                  {members
                    .filter(
                      (member) =>
                        member.user.id !== user.id && member.role !== "guest",
                    )
                    .map((member) => (
                      <option key={member.id} value={member.user.id}>
                        {member.user.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Filter by priority"
                  value={filters.priority}
                  onChange={(event) =>
                    setFilters({ ...filters, priority: event.target.value })
                  }
                >
                  <option value="">All priorities</option>
                  {taskPriorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priorityNames[priority]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by label"
                  value={filters.label}
                  onChange={(event) =>
                    setFilters({ ...filters, label: event.target.value })
                  }
                >
                  <option value="">All labels</option>
                  {labels.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by sprint"
                  value={filters.sprint}
                  onChange={(event) =>
                    setFilters({ ...filters, sprint: event.target.value })
                  }
                >
                  <option value="">All sprints</option>
                  <option value="none">Not in a sprint</option>
                  {sprints.map((sprint) => (
                    <option key={sprint.id} value={sprint.id}>
                      {sprint.name}
                    </option>
                  ))}
                </select>
                {filtering && (
                  <button
                    className="text-button"
                    onClick={() => setFilters(emptyFilters)}
                  >
                    Clear
                  </button>
                )}
              </div>
              <ErrorNote message={error} />
              {filtering && (
                <div className="filter-summary">
                  Showing {visible.length} of {roots.length} top-level tasks.{" "}
                  {writable && "Clear filters to reorder tasks."}
                </div>
              )}
              {mode === "board" ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={collision}
                  onDragStart={(event) => {
                    keyboardTarget.current = String(event.active.id);
                    setDraggedId(String(event.active.id));
                  }}
                  onDragEnd={dragEnd}
                  onDragCancel={() => {
                    keyboardTarget.current = null;
                    setDraggedId(null);
                  }}
                  accessibility={{
                    announcements: {
                      onDragStart: ({ active }) =>
                        `Picked up ${dragDescription(active.id)}.`,
                      onDragOver: ({ active, over }) =>
                        over
                          ? `${dragDescription(active.id)} over ${dragDescription(over.id)}.`
                          : "Outside the board.",
                      onDragEnd: ({ active, over }) =>
                        over
                          ? `Dropped ${dragDescription(active.id)} on ${dragDescription(over.id)}.`
                          : "Move cancelled.",
                      onDragCancel: () => "Move cancelled.",
                    },
                    screenReaderInstructions: {
                      draggable:
                        "Press space to pick up a task. Use arrow keys to move. Press space to drop, or escape to cancel. You can also change its status in the task editor.",
                    },
                  }}
                >
                  <div className="kanban-board" aria-label="Project task board">
                    {taskStatuses.map((status) => (
                      <BoardColumn
                        key={status}
                        status={status}
                        tasks={visible
                          .filter((task) => task.status === status)
                          .sort((a, b) => a.order - b.order)}
                        snapshot={snapshot}
                        members={members}
                        disabled={!writable || busy || filtering}
                        canCreate={!!writable && !busy}
                        open={(task) => setDrawer({ id: task.id })}
                        create={() => setDrawer({ create: status })}
                      />
                    ))}
                  </div>
                  <DragOverlay>
                    {draggedId &&
                    roots.find((task) => task.id === draggedId) ? (
                      <div className="task-drag-preview">
                        <span>
                          {taskCode(
                            snapshot.project,
                            roots.find((task) => task.id === draggedId)!,
                          )}
                        </span>
                        <strong>
                          {roots.find((task) => task.id === draggedId)!.title}
                        </strong>
                      </div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              ) : (
                <TaskList
                  tasks={visible}
                  snapshot={snapshot}
                  members={members}
                  open={(task) => setDrawer({ id: task.id })}
                />
              )}
              <div className="work-board-footer">
                <span>
                  {filtering
                    ? `${visible.length} matching tasks`
                    : `${roots.length} ${roots.length === 1 ? "task" : "tasks"} across ${taskStatuses.length} statuses`}
                </span>
                <span>
                  {writable
                    ? filtering
                      ? "Clear filters to reorder, or open a task to change status."
                      : "Drag a task by its handle, or open it to change status."
                    : "View task details by selecting a task."}
                </span>
              </div>
            </>
          )}
        </>
      )}
      {projectModal && (
        <WorkDialog
          title={
            projectModal === "create"
              ? "Make room for a new project."
              : "Project settings"
          }
          description={
            projectModal === "create"
              ? "A clear name and a little context go a long way."
              : "Manage project details, guest access, and its lifecycle."
          }
          close={() => setProjectModal(null)}
        >
          <ProjectForm
            key={projectModal}
            project={projectModal === "edit" ? snapshot?.project : undefined}
            members={members}
            save={async (values) => {
              if (projectModal === "create") {
                setBusy(true);
                try {
                  const result = await api<BoardSnapshot>("/projects", {
                    method: "POST",
                    body: json(values),
                  });
                  await reloadProjects();
                  if (!alive.current) return;
                  setProjectModal(null);
                  selection.current = result.project.id;
                  setSelectedId(result.project.id);
                  setSnapshot(result);
                  setFilters(emptyFilters);
                  notify("Project created.");
                  await changed();
                } finally {
                  if (alive.current) setBusy(false);
                }
              } else if (snapshot) {
                await mutate(
                  `/projects/${snapshot.project.id}`,
                  "PATCH",
                  values,
                  "Project details saved.",
                );
                setProjectModal(null);
              }
            }}
            remove={
              snapshot
                ? async () => {
                    const project = snapshot.project;
                    await api(`/projects/${project.id}`, {
                      method: "DELETE",
                      body: json({
                        revision: project.revision,
                        boardVersion: project.boardVersion,
                      }),
                    });
                    setProjectModal(null);
                    back();
                    notify("Project deleted.");
                    await changed();
                  }
                : undefined
            }
          />
        </WorkDialog>
      )}
      {drawer && snapshot && ("create" in drawer || selectedTask) && (
        <TaskDrawer
          key={
            "id" in drawer
              ? drawer.id
              : `new-${drawer.parentTaskId ?? "root"}-${drawer.create}`
          }
          task={selectedTask}
          initialStatus={"create" in drawer ? drawer.create : undefined}
          parentId={"create" in drawer ? drawer.parentTaskId : undefined}
          snapshot={snapshot}
          members={members}
          user={user}
          canWrite={!!writable}
          manager={manager}
          busy={busy}
          api={api}
          pulse={pulse}
          close={() => setDrawer(null)}
          openTask={(task) => setDrawer({ id: task.id })}
          save={async (values, revision) => {
            const result = await mutate(
              `/projects/${snapshot.project.id}/tasks${selectedTask ? `/${selectedTask.id}` : ""}`,
              selectedTask ? "PATCH" : "POST",
              {
                ...values,
                boardVersion: snapshot.project.boardVersion,
                ...(selectedTask
                  ? { revision }
                  : {
                      parentTaskId:
                        "create" in drawer
                          ? (drawer.parentTaskId ?? null)
                          : null,
                    }),
              },
              selectedTask ? "Task updated." : "Task created.",
            );
            if (!selectedTask && result) setDrawer(null);
            return result;
          }}
          addSubtask={async (title) => {
            await mutate(
              `/projects/${snapshot.project.id}/tasks`,
              "POST",
              {
                title,
                status: "todo",
                parentTaskId: selectedTask!.id,
                boardVersion: snapshot.project.boardVersion,
              },
              "Subtask added.",
            );
          }}
          toggleSubtask={async (task) => {
            await mutate(
              `/projects/${snapshot.project.id}/tasks/${task.id}`,
              "PATCH",
              {
                ...taskToValues(task),
                status: task.status === "done" ? "todo" : "done",
                revision: task.revision,
                boardVersion: snapshot.project.boardVersion,
              },
              "Subtask updated.",
            );
          }}
          remove={
            selectedTask
              ? async (revision) => {
                  await mutate(
                    `/projects/${snapshot.project.id}/tasks/${selectedTask.id}`,
                    "DELETE",
                    { revision, boardVersion: snapshot.project.boardVersion },
                    "Task deleted.",
                  );
                  setDrawer(null);
                }
              : undefined
          }
          reload={() => reloadBoard()}
        />
      )}
    </div>
  );
}

function BoardColumn({
  status,
  tasks,
  snapshot,
  members,
  disabled,
  canCreate,
  open,
  create,
}: {
  status: TaskStatus;
  tasks: Task[];
  snapshot: BoardSnapshot;
  members: Member[];
  disabled: boolean;
  canCreate: boolean;
  open: (task: Task) => void;
  create: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    disabled,
  });
  return (
    <section
      ref={setNodeRef}
      className={`board-column ${isOver ? "drag-over" : ""}`}
      aria-label={`${statusNames[status]} column`}
    >
      <div className="column-heading">
        <div>
          <StatusIcon status={status} />
          <h2>{statusNames[status]}</h2>
          <span>{tasks.length}</span>
        </div>
        {canCreate && (
          <button
            className="icon-button"
            aria-label={`Add task to ${statusNames[status]}`}
            onClick={create}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <SortableContext
        items={tasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="column-tasks">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              snapshot={snapshot}
              members={members}
              disabled={disabled}
              open={() => open(task)}
            />
          ))}
        </div>
      </SortableContext>
      {canCreate ? (
        <button className="column-add" onClick={create}>
          <Plus size={14} />
          Add task
        </button>
      ) : (
        !tasks.length && <div className="column-empty">No tasks here</div>
      )}
    </section>
  );
}
function TaskCard({
  task,
  snapshot,
  members,
  disabled,
  open,
}: {
  task: Task;
  snapshot: BoardSnapshot;
  members: Member[];
  disabled: boolean;
  open: () => void;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled });
  const subtasks = snapshot.tasks.filter(
    (item) => item.parentTaskId === task.id,
  );
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-card ${isDragging ? "is-dragging" : ""}`}
    >
      <div className="task-card-top">
        <span>{taskCode(snapshot.project, task)}</span>
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={disabled}
          className="task-grip"
          aria-label={`Move ${taskCode(snapshot.project, task)}`}
          title={
            disabled
              ? "Use the task editor to change status"
              : "Drag to reorder · Space to move with keyboard"
          }
        >
          <GripVertical size={14} />
        </button>
      </div>
      <button className="task-title" onClick={open}>
        {task.title}
      </button>
      {task.labels.length > 0 && (
        <div className="task-labels">
          {task.labels.slice(0, 3).map((label) => (
            <span key={label}>{label}</span>
          ))}
          {task.labels.length > 3 && <small>+{task.labels.length - 3}</small>}
        </div>
      )}
      {subtasks.length > 0 && (
        <span className="subtask-count">
          <CheckCheck size={13} />
          {subtasks.filter((item) => item.status === "done").length}/
          {subtasks.length} subtasks
        </span>
      )}
      <div className="task-card-bottom">
        <Priority value={task.priority} />
        {task.dueDate && (
          <span className={`task-date ${overdue(task) ? "overdue" : ""}`}>
            <CalendarDays size={12} />
            {date(task.dueDate)}
          </span>
        )}
        {task.estimateHours !== null && (
          <span className="task-estimate">{task.estimateHours}h</span>
        )}
        <Person
          member={members.find((member) => member.user.id === task.assigneeId)}
          small
        />
      </div>
    </article>
  );
}
function TaskList({
  tasks,
  snapshot,
  members,
  open,
}: {
  tasks: Task[];
  snapshot: BoardSnapshot;
  members: Member[];
  open: (task: Task) => void;
}) {
  return (
    <div className="task-list-scroll">
      <table className="task-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Assignee</th>
            <th>Due date</th>
          </tr>
        </thead>
        <tbody>
          {[...tasks]
            .sort(
              (a, b) =>
                taskStatuses.indexOf(a.status) -
                  taskStatuses.indexOf(b.status) || a.order - b.order,
            )
            .map((task) => (
              <tr key={task.id}>
                <td>
                  <button
                    className="task-list-title"
                    onClick={() => open(task)}
                  >
                    <span>{taskCode(snapshot.project, task)}</span>
                    <strong>{task.title}</strong>
                    {snapshot.tasks.some(
                      (item) => item.parentTaskId === task.id,
                    ) && <CheckCheck size={13} />}
                  </button>
                </td>
                <td>
                  <span className="list-status">
                    <StatusIcon status={task.status} />
                    {statusNames[task.status]}
                  </span>
                </td>
                <td>
                  <Priority value={task.priority} words />
                </td>
                <td>
                  <span className="list-assignee">
                    <Person
                      member={members.find(
                        (member) => member.user.id === task.assigneeId,
                      )}
                      small
                    />
                    <span>
                      {members.find(
                        (member) => member.user.id === task.assigneeId,
                      )?.user.name ??
                        (task.assigneeId ? "Former member" : "Unassigned")}
                    </span>
                  </span>
                </td>
                <td className={overdue(task) ? "overdue" : ""}>
                  {task.dueDate ? date(task.dueDate) : "—"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {!tasks.length && (
        <div className="task-list-empty">
          <CircleDashed size={23} />
          <span>No matching tasks. Add a task or adjust your filters.</span>
        </div>
      )}
    </div>
  );
}

function ProjectForm({
  project,
  members,
  save,
  remove,
}: {
  project?: Project;
  members: Member[];
  save: (
    values:
      | ProjectValues
      | (Omit<ProjectValues, "key"> & {
          status: "active" | "archived";
          revision: number;
        }),
  ) => Promise<void>;
  remove?: () => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [key, setKey] = useState(project?.key ?? "");
  const [customKey, setCustomKey] = useState(false);
  const [description, setDescription] = useState(project?.description ?? "");
  const [leadId, setLeadId] = useState(project?.leadId ?? "");
  const [guestIds, setGuestIds] = useState(project?.guestIds ?? []);
  const [status, setStatus] = useState(project?.status ?? "active");
  const [originalRevision] = useState(project?.revision ?? 0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteKey, setDeleteKey] = useState("");
  const [deleting, setDeleting] = useState(false);
  const guests = members.filter((member) => member.role === "guest");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const values = {
        name,
        description,
        leadId: leadId || null,
        guestIds: guestIds.filter((id) =>
          guests.some((guest) => guest.user.id === id),
        ),
      };
      await save(
        project
          ? { ...values, status, revision: originalRevision }
          : { ...values, key },
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-stack project-form" onSubmit={submit}>
      <label className="field">
        <span>Project name</span>
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!project && !customKey)
              setKey(
                event.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 5),
              );
          }}
          placeholder="e.g. Website refresh"
          minLength={2}
          maxLength={80}
          required
        />
      </label>
      <div className="form-pair">
        <label className="field">
          <span>Project key</span>
          <input
            value={key}
            onChange={(event) => {
              setKey(event.target.value.toUpperCase());
              setCustomKey(true);
            }}
            placeholder="WEB"
            minLength={2}
            maxLength={8}
            pattern="[A-Z][A-Z0-9]{1,7}"
            disabled={!!project}
            required
          />
          <small>
            {project
              ? "Task identifiers keep this key."
              : "2–8 uppercase letters and numbers."}
          </small>
        </label>
        <label className="field">
          <span>Project lead</span>
          <select
            value={leadId}
            onChange={(event) => setLeadId(event.target.value)}
          >
            <option value="">No lead</option>
            {leadId &&
              !members.some(
                (member) =>
                  member.user.id === leadId && member.role !== "guest",
              ) && (
                <option value={leadId} disabled>
                  Former member — choose a new lead
                </option>
              )}
            {members
              .filter((member) => member.role !== "guest")
              .map((member) => (
                <option key={member.id} value={member.user.id}>
                  {member.user.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="What are you working toward?"
        />
      </label>
      {guests.length > 0 && (
        <fieldset className="guest-sharing">
          <legend>Share with workspace guests</legend>
          <p>
            Guests can view tasks in this project. They cannot make changes.
          </p>
          {guests.map((guest) => (
            <label key={guest.id}>
              <input
                type="checkbox"
                checked={guestIds.includes(guest.user.id)}
                onChange={(event) =>
                  setGuestIds(
                    event.target.checked
                      ? [...guestIds, guest.user.id]
                      : guestIds.filter((id) => id !== guest.user.id),
                  )
                }
              />
              <Person member={guest} small />
              <span>
                {guest.user.name}
                <small>{guest.user.email}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {project && (
        <label className="field">
          <span>Project status</span>
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "active" | "archived")
            }
          >
            <option value="active">Active — tasks can be changed</option>
            <option value="archived">Archived — keep tasks read-only</option>
          </select>
        </label>
      )}
      <ErrorNote message={error} />
      {project && project.revision !== originalRevision && (
        <ErrorNote message="This project changed while you were editing. Close settings and reopen them to review the latest details before saving." />
      )}
      <button
        className="button primary full"
        disabled={busy || (!!project && project.revision !== originalRevision)}
      >
        {busy ? (
          <LoaderCircle size={16} className="spinner" />
        ) : project ? (
          "Save project"
        ) : (
          <>
            <Plus size={16} />
            Create project
          </>
        )}
      </button>
      {project?.status === "archived" && remove && (
        <div className="project-delete-zone">
          {!deleting ? (
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={13} />
              Delete archived project
            </button>
          ) : (
            <>
              <strong>
                Permanently delete this project and all its tasks?
              </strong>
              <p>
                Type <b>{project.key}</b> to confirm. This cannot be undone.
              </p>
              <input
                aria-label="Project key to confirm deletion"
                value={deleteKey}
                onChange={(event) => setDeleteKey(event.target.value)}
              />
              <div>
                <button
                  type="button"
                  className="button"
                  onClick={() => setDeleting(false)}
                >
                  Keep project
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={busy || deleteKey !== project.key}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await remove();
                    } catch (error) {
                      setError((error as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete project
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </form>
  );
}

const taskToValues = (task: Task): TaskValues => ({
  title: task.title,
  description: task.description,
  status: task.status,
  priority: task.priority,
  assigneeId: task.assigneeId,
  dueDate: task.dueDate,
  estimateHours: task.estimateHours,
  labels: task.labels,
});
type TaskDrawerProps = {
  task?: Task;
  initialStatus?: TaskStatus;
  parentId?: string;
  snapshot: BoardSnapshot;
  members: Member[];
  user: User;
  canWrite: boolean;
  manager: boolean;
  busy: boolean;
  close: () => void;
  openTask: (task: Task) => void;
  save: (values: TaskValues, revision?: number) => Promise<BoardSnapshot>;
  addSubtask: (title: string) => Promise<void>;
  toggleSubtask: (task: Task) => Promise<void>;
  remove?: (revision: number) => Promise<void>;
  reload: () => Promise<BoardSnapshot | undefined>;
  api: ScopedApi;
  pulse: number;
};
function TaskDrawer({
  task,
  initialStatus,
  parentId,
  snapshot,
  members,
  user,
  canWrite,
  manager,
  busy,
  close,
  openTask,
  save,
  addSubtask,
  toggleSubtask,
  remove,
  reload,
  api,
  pulse,
}: TaskDrawerProps) {
  const [values, setValues] = useState<TaskValues>(
    task
      ? taskToValues(task)
      : {
          title: "",
          description: "",
          status: initialStatus ?? "todo",
          priority: "medium",
          assigneeId: null,
          dueDate: null,
          estimateHours: null,
          labels: [],
        },
  );
  const [baseline, setBaseline] = useState(task ? taskToValues(task) : values);
  const [collaborationDirty, setCollaborationDirty] = useState(false);
  const [revision, setRevision] = useState(task?.revision ?? 0);
  const [labelText, setLabelText] = useState(values.labels.join(", "));
  const [error, setError] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const dirty =
    JSON.stringify(values) !== JSON.stringify(baseline) ||
    labelText !== baseline.labels.join(", ");
  useEffect(() => {
    if (task && task.revision !== revision && !dirty && !busy) {
      const fresh = taskToValues(task);
      setValues(fresh);
      setBaseline(fresh);
      setLabelText(fresh.labels.join(", "));
      setRevision(task.revision);
    }
  }, [task?.revision, dirty, busy]);
  const subtasks = task
    ? snapshot.tasks
        .filter((item) => item.parentTaskId === task.id)
        .sort((a, b) => a.number - b.number)
    : [];
  const parent = snapshot.tasks.find(
    (item) => item.id === (task?.parentTaskId ?? parentId),
  );
  const stale = task && task.revision !== revision;
  const canDelete =
    canWrite &&
    task &&
    (manager || task.createdBy === user.id) &&
    (manager || subtasks.every((subtask) => subtask.createdBy === user.id));
  function safely(action: () => void) {
    if (dirty || collaborationDirty) setPendingAction(() => action);
    else action();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const labels = [
        ...new Set(
          labelText
            .split(",")
            .map((label) => label.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      const result = await save({ ...values, labels }, revision);
      if (task) {
        const updated = result.tasks.find((item) => item.id === task.id);
        if (updated) {
          const fresh = taskToValues(updated);
          setValues(fresh);
          setBaseline(fresh);
          setRevision(updated.revision);
          setLabelText(fresh.labels.join(", "));
        }
      }
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function resetFromServer() {
    try {
      const result = await reload();
      const current = result?.tasks.find((item) => item.id === task?.id);
      if (current) {
        const fresh = taskToValues(current);
        setValues(fresh);
        setBaseline(fresh);
        setLabelText(fresh.labels.join(", "));
        setRevision(current.revision);
        setError("");
      }
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !busy && !open && safely(close)}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content
          className="task-drawer"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
            else if (dirty || collaborationDirty) {
              event.preventDefault();
              safely(close);
            }
          }}
          onPointerDownOutside={(event) => {
            if (dirty || collaborationDirty || busy) event.preventDefault();
          }}
        >
          <div className="drawer-topbar">
            <span>
              <FolderKanban size={14} />
              {snapshot.project.key}
              <span>/</span>
              {task
                ? taskCode(snapshot.project, task)
                : parent
                  ? "New subtask"
                  : "New task"}
            </span>
            <button
              className="icon-button"
              aria-label="Close task"
              disabled={busy}
              onClick={() => safely(close)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="drawer-scroll">
            <Dialog.Title className="sr-only">
              {task
                ? `${taskCode(snapshot.project, task)} task details`
                : "Create a task"}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              {canWrite
                ? "Edit task details, assignment, status, and subtasks."
                : "Read-only task details."}
            </Dialog.Description>
            {parent && (
              <button
                className="parent-task-link"
                onClick={() => safely(() => openTask(parent))}
              >
                <ArrowLeft size={13} />
                {taskCode(snapshot.project, parent)}
                <span>{parent.title}</span>
              </button>
            )}
            {pendingAction && (
              <div className="unsaved-note" role="alert">
                <strong>You have unsaved changes.</strong>
                <p>Keep editing or discard this draft to continue.</p>
                <div>
                  <button
                    className="button"
                    onClick={() => setPendingAction(null)}
                  >
                    Keep editing
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      const action = pendingAction;
                      setPendingAction(null);
                      action();
                    }}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            )}
            {stale && !busy && (
              <div className="stale-note">
                <RefreshCw size={16} />
                <span>
                  This task changed while you were editing. Your draft is
                  preserved.
                </span>
                <button
                  className="text-button"
                  onClick={resetFromServer}
                  disabled={busy}
                >
                  Reload task
                </button>
              </div>
            )}
            <form className="task-edit-form" onSubmit={submit}>
              <label className="task-title-field">
                <span className="sr-only">Task title</span>
                <textarea
                  aria-label="Task title"
                  value={values.title}
                  onChange={(event) =>
                    setValues({ ...values, title: event.target.value })
                  }
                  placeholder="What needs to happen?"
                  rows={2}
                  maxLength={180}
                  required
                  disabled={!canWrite || busy}
                />
              </label>
              <div className="task-property-grid">
                <label>
                  <span>
                    <StatusIcon status={values.status} />
                    Status
                  </span>
                  <select
                    aria-label="Task status"
                    value={values.status}
                    onChange={(event) =>
                      setValues({
                        ...values,
                        status: event.target.value as TaskStatus,
                      })
                    }
                    disabled={!canWrite || busy}
                  >
                    {taskStatuses.map((status) => (
                      <option key={status} value={status}>
                        {statusNames[status]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>
                    <Priority value={values.priority} />
                    Priority
                  </span>
                  <select
                    aria-label="Task priority"
                    value={values.priority}
                    onChange={(event) =>
                      setValues({
                        ...values,
                        priority: event.target.value as TaskPriority,
                      })
                    }
                    disabled={!canWrite || busy}
                  >
                    {taskPriorities.map((priority) => (
                      <option key={priority} value={priority}>
                        {priorityNames[priority]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>
                    <UserRound size={14} />
                    Assignee
                  </span>
                  <select
                    aria-label="Task assignee"
                    value={values.assigneeId ?? ""}
                    onChange={(event) =>
                      setValues({
                        ...values,
                        assigneeId: event.target.value || null,
                      })
                    }
                    disabled={!canWrite || busy}
                  >
                    <option value="">Unassigned</option>
                    {values.assigneeId &&
                      !members.some(
                        (member) =>
                          member.user.id === values.assigneeId &&
                          member.role !== "guest",
                      ) && (
                        <option value={values.assigneeId} disabled>
                          Former member — reassign or clear
                        </option>
                      )}
                    {members
                      .filter((member) => member.role !== "guest")
                      .map((member) => (
                        <option key={member.id} value={member.user.id}>
                          {member.user.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>
                    <CalendarDays size={14} />
                    Due date
                  </span>
                  <input
                    aria-label="Task due date"
                    type="date"
                    name="dueDate"
                    value={values.dueDate ?? ""}
                    min="1900-01-01"
                    max="9999-12-31"
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setValues((previous) => ({
                        ...previous,
                        dueDate: value || null,
                      }));
                    }}
                    onChange={(event) =>
                      setValues({
                        ...values,
                        dueDate: event.target.value || null,
                      })
                    }
                    disabled={!canWrite || busy}
                  />
                </label>
                <label>
                  <span>
                    <Clock3 size={14} />
                    Estimate
                  </span>
                  <div className="estimate-input">
                    <input
                      aria-label="Estimated hours"
                      type="number"
                      min="0"
                      max="10000"
                      step="0.25"
                      value={values.estimateHours ?? ""}
                      placeholder="Not estimated"
                      onChange={(event) =>
                        setValues({
                          ...values,
                          estimateHours:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                      disabled={!canWrite || busy}
                    />
                    <span>hours</span>
                  </div>
                </label>
                <label>
                  <span>
                    <Tag size={14} />
                    Labels
                  </span>
                  <input
                    aria-label="Task labels"
                    value={labelText}
                    onChange={(event) => setLabelText(event.target.value)}
                    placeholder="design, research"
                    maxLength={208}
                    disabled={!canWrite || busy}
                  />
                </label>
              </div>
              <label className="task-description-field">
                <span>Description</span>
                <textarea
                  aria-label="Task description"
                  value={values.description}
                  onChange={(event) =>
                    setValues({ ...values, description: event.target.value })
                  }
                  placeholder="Add context, decisions, or a clear definition of done…"
                  rows={5}
                  maxLength={8000}
                  disabled={!canWrite || busy}
                />
              </label>
              <ErrorNote message={error} />
              <div className="task-save-row">
                <span>
                  {!canWrite
                    ? "Read-only task"
                    : stale
                      ? "Review the latest version before saving."
                      : dirty
                        ? "Unsaved changes"
                        : task
                          ? "All changes saved"
                          : "A little clarity goes a long way."}
                </span>
                {canWrite && (
                  <button
                    className="button primary"
                    disabled={busy || !!stale || (!!task && !dirty)}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="spinner" />
                    ) : task ? (
                      "Save changes"
                    ) : (
                      "Create task"
                    )}
                  </button>
                )}
              </div>
            </form>
            {task && !task.parentTaskId && (
              <section className="subtasks-section">
                <div className="section-heading">
                  <h2>
                    Subtasks
                    <span>
                      {subtasks.filter((item) => item.status === "done").length}
                      /{subtasks.length}
                    </span>
                  </h2>
                  <span className="subtasks-line">
                    <span
                      style={{
                        width: `${subtasks.length ? (subtasks.filter((item) => item.status === "done").length / subtasks.length) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </div>
                {subtasks.length ? (
                  subtasks.map((subtask) => (
                    <div className="subtask-row" key={subtask.id}>
                      <button
                        className={`subtask-check ${subtask.status === "done" ? "checked" : ""}`}
                        disabled={!canWrite || busy}
                        aria-label={`${subtask.status === "done" ? "Reopen" : "Complete"} subtask ${subtask.title}`}
                        onClick={async () => {
                          setError("");
                          try {
                            await toggleSubtask(subtask);
                          } catch (error) {
                            setError((error as Error).message);
                          }
                        }}
                      >
                        {subtask.status === "done" && <Check size={12} />}
                      </button>
                      <button
                        className={`subtask-title ${subtask.status === "done" ? "completed" : ""}`}
                        onClick={() => safely(() => openTask(subtask))}
                      >
                        {subtask.title}
                        <small>{taskCode(snapshot.project, subtask)}</small>
                      </button>
                      <Person
                        member={members.find(
                          (member) => member.user.id === subtask.assigneeId,
                        )}
                        small
                      />
                    </div>
                  ))
                ) : (
                  <p className="no-subtasks">
                    Break this task into a few smaller steps.
                  </p>
                )}
                {canWrite && (
                  <form
                    className="add-subtask"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!subtaskTitle.trim()) return;
                      setError("");
                      try {
                        await addSubtask(subtaskTitle.trim());
                        setSubtaskTitle("");
                      } catch (error) {
                        setError((error as Error).message);
                      }
                    }}
                  >
                    <Plus size={15} />
                    <input
                      aria-label="New subtask title"
                      value={subtaskTitle}
                      onChange={(event) => setSubtaskTitle(event.target.value)}
                      placeholder="Add a subtask…"
                      maxLength={180}
                      disabled={busy}
                    />
                    <button
                      className="button quiet"
                      disabled={busy || !subtaskTitle.trim()}
                    >
                      Add
                    </button>
                  </form>
                )}
              </section>
            )}
            {task && (
              <TaskCollaboration
                projectId={snapshot.project.id}
                taskId={task.id}
                user={user}
                members={members}
                guestIds={snapshot.project.guestIds}
                canWrite={canWrite}
                manager={manager}
                api={api}
                pulse={pulse}
                dirtyChanged={setCollaborationDirty}
              />
            )}
            {task && (
              <div className="task-history-note">
                Created{" "}
                {new Date(task.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                <span>·</span>Last updated{" "}
                {new Date(task.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </div>
            )}
            {canDelete && remove && (
              <div className="task-delete-section">
                {!confirmDelete ? (
                  <button
                    className="text-button danger-text"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={13} />
                    Delete task
                  </button>
                ) : (
                  <div className="delete-task-confirm">
                    <strong>
                      Delete this task
                      {subtasks.length
                        ? ` and its ${subtasks.length} subtasks`
                        : ""}
                      ?
                    </strong>
                    <p>This cannot be undone.</p>
                    <div>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep task
                      </button>
                      <button
                        className="button danger"
                        disabled={busy}
                        onClick={async () => {
                          setError("");
                          try {
                            await remove(revision);
                          } catch (error) {
                            setError((error as Error).message);
                          }
                        }}
                      >
                        Delete task
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
