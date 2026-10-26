import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Plus,
  X,
  Play,
  CheckCheck,
  Clock3,
  Square,
  CalendarRange,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import type { ScopedApi } from "../collaboration/Collaboration";
import { json, type Workspace, type User, type Member } from "../api";
import {
  statusNames,
  priorityNames,
  type Project,
  type Task,
} from "../../shared/work";
import type {
  Sprint,
  SprintValues,
  SprintReport,
  TimeEntry,
  Timesheet,
  Workload,
} from "../../shared/planning";
import type { Navigation } from "../../shared/collaboration";
import "./planning.css";
type Plan = { sprints: Sprint[]; tasks: Task[]; boardVersion: number };
type Props = {
  api: ScopedApi;
  workspace: Workspace;
  user: User;
  members: Member[];
  pulse: number;
  notify: (text: string) => void;
  open: (navigation: Navigation) => void;
};
export function PlanningArea(
  props: Props & { view: "sprints" | "timesheets" | "reports" },
) {
  const Component =
    props.view === "sprints"
      ? Sprints
      : props.view === "timesheets"
        ? Timesheets
        : Reports;
  return <Component {...props} />;
}
const utcToday = () => new Date().toISOString().slice(0, 10);
const day = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const hours = (minutes: number) =>
  `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const canManage = (workspace: Workspace) =>
  ["owner", "admin"].includes(workspace.role);
function ErrorLine({ error }: { error: string }) {
  return error ? (
    <div className="work-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="planning-empty">
      <CalendarRange size={32} strokeWidth={1.2} />
      {children}
    </div>
  );
}
function SheetDialog({
  title,
  description,
  close,
  children,
}: {
  title: string;
  description: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content planning-dialog"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <button
            className="icon-button planning-dialog-close"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={18} />
          </button>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function useProjects(api: ScopedApi, pulse: number) {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ projects: Project[] }>("/projects")
      .then((value) => {
        if (active) {
          setProjects(value.projects);
          setProjectId((old) =>
            value.projects.some((p) => p.id === old)
              ? old
              : ((
                  value.projects.find((p) => p.status === "active") ??
                  value.projects[0]
                )?.id ?? ""),
          );
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [pulse]);
  return {
    projects,
    projectId,
    setProjectId,
    error,
    project: projects.find((p) => p.id === projectId),
  };
}
function ProjectPicker({
  projects,
  value,
  change,
  disabled = false,
}: {
  projects: Project[];
  value: string;
  change: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="planning-project">
      <span>Project</span>
      <select
        aria-label="Planning project"
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
function usePlan(api: ScopedApi, projectId: string, pulse: number) {
  const [data, setData] = useState<Plan | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const previousProject = useRef("");
  useEffect(() => {
    let active = true;
    if (previousProject.current !== projectId) {
      setData(null);
      previousProject.current = projectId;
    }
    setError("");
    if (!projectId) return;
    api<Plan>(`/projects/${projectId}/sprints`)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [projectId, pulse, reload]);
  return { data, error, refresh: () => setReload((n) => n + 1) };
}
export function Sprints(props: Props) {
  const { api, workspace, notify, open, members } = props,
    p = useProjects(api, props.pulse),
    plan = usePlan(api, p.projectId, props.pulse);
  const [selected, setSelected] = useState("all"),
    [checked, setChecked] = useState<string[]>([]),
    [destination, setDestination] = useState(""),
    [form, setForm] = useState<Sprint | "new" | null>(null),
    [finishing, setFinishing] = useState<Sprint | null>(null),
    [carry, setCarry] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const data = plan.data,
    selectedSprint = data?.sprints.find((s) => s.id === selected),
    editable = canManage(workspace) && p.project?.status === "active";
  useEffect(() => {
    setSelected("all");
    setChecked([]);
    setForm(null);
    setFinishing(null);
    setError("");
  }, [p.projectId]);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    message: string,
  ) {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${p.projectId}${path}`, {
        method,
        body: json(body),
      });
      plan.refresh();
      setChecked([]);
      notify(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      plan.refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const tasks =
    data?.tasks.filter(
      (t) =>
        !t.parentTaskId &&
        (selected === "all" ||
          (selected === "backlog" ? !t.sprintId : t.sprintId === selected)),
    ) ?? [];
  return (
    <div className="planning-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PLAN THE NEXT ITERATION</div>
          <h1>Sprints</h1>
          <p>
            Shape the scope, follow progress, and carry unfinished work forward.
          </p>
        </div>
        {editable && (
          <button
            className="button primary"
            onClick={() => {
              setError("");
              setForm("new");
            }}
          >
            <Plus size={16} />
            New sprint
          </button>
        )}
      </div>
      <div className="planning-controls">
        <ProjectPicker
          projects={p.projects}
          value={p.projectId}
          change={p.setProjectId}
          disabled={busy}
        />
        <button
          className="button secondary"
          aria-label="Refresh sprints"
          disabled={busy}
          onClick={plan.refresh}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
        <span className="planning-note">Dates and reports use UTC.</span>
      </div>
      <ErrorLine error={error || plan.error || p.error} />
      {!p.projects.length ? (
        <Empty>
          <h2>Create a project to plan a sprint.</h2>
          <p>Your project tasks will appear here.</p>
        </Empty>
      ) : !data ? (
        <p role="status">Loading sprint plan…</p>
      ) : (
        <>
          <div className="sprint-layout">
            <aside className="sprint-index" aria-label="Sprint selection">
              <button
                className={selected === "all" ? "selected" : ""}
                onClick={() => {
                  setSelected("all");
                  setChecked([]);
                }}
              >
                <span>All tasks</span>
                <strong>
                  {data.tasks.filter((t) => !t.parentTaskId).length}
                </strong>
              </button>
              <button
                className={selected === "backlog" ? "selected" : ""}
                onClick={() => {
                  setSelected("backlog");
                  setChecked([]);
                }}
              >
                <span>Not in a sprint</span>
                <strong>
                  {
                    data.tasks.filter((t) => !t.parentTaskId && !t.sprintId)
                      .length
                  }
                </strong>
              </button>
              <div className="sprint-index-label">ITERATIONS</div>
              {data.sprints.map((s) => (
                <button
                  key={s.id}
                  className={selected === s.id ? "selected" : ""}
                  onClick={() => {
                    setSelected(s.id);
                    setChecked([]);
                  }}
                >
                  <span>
                    <b>{s.name}</b>
                    <small>
                      {day(s.startDate)} – {day(s.endDate)}
                    </small>
                  </span>
                  <span className={`sprint-state ${s.status}`}>{s.status}</span>
                </button>
              ))}
              {!data.sprints.length && (
                <p className="planning-note">No sprints yet.</p>
              )}
            </aside>
            <section className="sprint-scope">
              <div className="sprint-summary">
                <div>
                  <span className="eyebrow">
                    {selectedSprint?.status ?? "PROJECT SCOPE"}
                  </span>
                  <h2>
                    {selectedSprint?.name ??
                      (selected === "backlog"
                        ? "Not in a sprint"
                        : "All project tasks")}
                  </h2>
                  <p>
                    {selectedSprint?.goal ||
                      (selectedSprint
                        ? "No sprint goal set."
                        : "Select tasks to add them to a sprint. Subtasks follow their parent.")}
                  </p>
                  {selectedSprint && (
                    <div className="sprint-counts">
                      <span>
                        <strong>
                          {selectedSprint.doneTasks}/{selectedSprint.totalTasks}
                        </strong>{" "}
                        tasks done
                      </span>
                      <span>
                        <strong>{selectedSprint.totalHours}</strong> estimated
                        hours
                      </span>
                      <span>
                        <strong>{selectedSprint.unestimated}</strong>{" "}
                        unestimated
                      </span>
                    </div>
                  )}
                </div>
                {editable && selectedSprint && (
                  <div className="planning-actions">
                    {selectedSprint.status === "planned" && (
                      <>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => {
                            setError("");
                            setForm(selectedSprint);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="button primary"
                          disabled={busy || !selectedSprint.totalTasks}
                          onClick={() =>
                            mutate(
                              `/sprints/${selectedSprint.id}/start`,
                              "POST",
                              {
                                revision: selectedSprint.revision,
                                boardVersion: data.boardVersion,
                              },
                              "Sprint started.",
                            )
                          }
                        >
                          <Play size={14} />
                          Start sprint
                        </button>
                      </>
                    )}
                    {selectedSprint.status === "active" && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => {
                          setCarry("");
                          setFinishing(selectedSprint);
                        }}
                      >
                        <CheckCheck size={16} />
                        Complete sprint
                      </button>
                    )}
                  </div>
                )}
              </div>
              {selectedSprint?.status === "completed" && (
                <p className="planning-callout">
                  Completion totals are saved history. Unfinished tasks were
                  moved when this sprint ended.
                </p>
              )}
              {editable && selectedSprint?.status !== "completed" && (
                <div className="allocation-bar">
                  <span>{checked.length} selected</span>
                  <select
                    aria-label="Destination sprint"
                    value={destination}
                    disabled={busy}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    <option value="">Not in a sprint</option>
                    {data.sprints
                      .filter((s) => s.status !== "completed")
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.status})
                        </option>
                      ))}
                  </select>
                  <button
                    className="button secondary"
                    disabled={busy || !checked.length}
                    onClick={() =>
                      mutate(
                        "/sprint-tasks",
                        "PATCH",
                        {
                          sprintId: destination || null,
                          taskIds: checked,
                          boardVersion: data.boardVersion,
                        },
                        "Sprint scope updated.",
                      )
                    }
                  >
                    Move selected
                  </button>
                </div>
              )}
              <div className="task-list-scroll">
                <table className="task-table">
                  <thead>
                    <tr>
                      {editable && (
                        <th>
                          <span className="sr-only">Select</span>
                        </th>
                      )}
                      <th>Task</th>
                      <th>Status</th>
                      <th>Assignee</th>
                      <th>Estimate</th>
                      <th>Sprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const sprint = data.sprints.find(
                        (s) => s.id === t.sprintId,
                      );
                      return (
                        <tr key={t.id}>
                          {editable && (
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${p.project?.key}-${t.number}`}
                                disabled={
                                  busy || sprint?.status === "completed"
                                }
                                checked={checked.includes(t.id)}
                                onChange={(e) =>
                                  setChecked((old) =>
                                    e.target.checked
                                      ? [...old, t.id]
                                      : old.filter((id) => id !== t.id),
                                  )
                                }
                              />
                            </td>
                          )}
                          <td>
                            <button
                              className="task-list-title"
                              onClick={() =>
                                open({
                                  projectId: p.projectId,
                                  taskId: t.id,
                                  nonce: Date.now(),
                                })
                              }
                            >
                              <span>
                                {p.project?.key}-{t.number}
                              </span>
                              <strong>{t.title}</strong>
                            </button>
                          </td>
                          <td>{statusNames[t.status]}</td>
                          <td>
                            {members.find((m) => m.user.id === t.assigneeId)
                              ?.user.name ??
                              (t.assigneeId ? "Former member" : "Unassigned")}
                          </td>
                          <td>
                            {t.estimateHours == null
                              ? "—"
                              : `${t.estimateHours}h`}
                          </td>
                          <td>{sprint?.name ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!tasks.length && (
                  <Empty>
                    <h3>No tasks in this view.</h3>
                    <p>
                      Use All tasks to select and move work into this sprint.
                    </p>
                  </Empty>
                )}
              </div>
            </section>
          </div>
        </>
      )}
      {form && (
        <SheetDialog
          title={form === "new" ? "New sprint" : "Edit sprint"}
          description="Choose a goal and up to 90 calendar days. Start dates must include today when you begin."
          close={() => {
            if (!busy) {
              setForm(null);
              setError("");
            }
          }}
        >
          <SprintForm
            sprint={form === "new" ? undefined : form}
            busy={busy}
            error={error}
            save={async (values) => {
              if (
                await mutate(
                  form === "new" ? "/sprints" : `/sprints/${form.id}`,
                  form === "new" ? "POST" : "PATCH",
                  {
                    ...values,
                    ...(form === "new" ? {} : { revision: form.revision }),
                  },
                  "Sprint saved.",
                )
              )
                setForm(null);
            }}
          />
        </SheetDialog>
      )}
      {finishing && data && (
        <SheetDialog
          title={`Complete ${finishing.name}`}
          description="Save this sprint’s results and move unfinished tasks. Their task status will be preserved."
          close={() => {
            if (!busy) setFinishing(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  `/sprints/${finishing.id}/complete`,
                  "POST",
                  {
                    revision: finishing.revision,
                    boardVersion: data.boardVersion,
                    carryToId: carry || null,
                  },
                  "Sprint completed.",
                )
              )
                setFinishing(null);
            }}
          >
            <ErrorLine error={error} />
            <label className="field">
              <span>Move unfinished work to</span>
              <select value={carry} onChange={(e) => setCarry(e.target.value)}>
                <option value="">Not in a sprint</option>
                {data.sprints
                  .filter((s) => s.status === "planned")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              Complete sprint
            </button>
          </form>
        </SheetDialog>
      )}
    </div>
  );
}
function SprintForm({
  sprint,
  busy,
  error,
  save,
}: {
  sprint?: Sprint;
  busy: boolean;
  error: string;
  save: (values: SprintValues) => Promise<void>;
}) {
  const [values, setValues] = useState<SprintValues>({
    name: sprint?.name ?? "",
    goal: sprint?.goal ?? "",
    startDate: sprint?.startDate ?? utcToday(),
    endDate:
      sprint?.endDate ??
      new Date(Date.now() + 13 * 86400000).toISOString().slice(0, 10),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(values);
      }}
    >
      <ErrorLine error={error} />
      <label className="field">
        <span>Sprint name</span>
        <input
          required
          minLength={2}
          maxLength={80}
          value={values.name}
          onChange={(e) => setValues({ ...values, name: e.target.value })}
          autoFocus
        />
      </label>
      <label className="field">
        <span>Goal</span>
        <textarea
          maxLength={1000}
          value={values.goal}
          onChange={(e) => setValues({ ...values, goal: e.target.value })}
        />
      </label>
      <div className="planning-form-row">
        <label className="field">
          <span>Start date (UTC)</span>
          <input
            type="date"
            required
            value={values.startDate}
            onChange={(e) =>
              setValues({ ...values, startDate: e.target.value })
            }
          />
        </label>
        <label className="field">
          <span>End date (UTC)</span>
          <input
            type="date"
            required
            min={values.startDate}
            value={values.endDate}
            onChange={(e) => setValues({ ...values, endDate: e.target.value })}
          />
        </label>
      </div>
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : "Save sprint"}
      </button>
    </form>
  );
}

export function Timesheets(props: Props) {
  const { api, workspace, user, notify } = props,
    p = useProjects(api, props.pulse);
  const [from, setFrom] = useState(
      new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(utcToday()),
    [scope, setScope] = useState("mine"),
    [person, setPerson] = useState(""),
    [projectFilter, setProjectFilter] = useState("");
  const [sheet, setSheet] = useState<Timesheet | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [form, setForm] = useState<TimeEntry | "new" | null>(null),
    [remove, setRemove] = useState<TimeEntry | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [taskId, setTaskId] = useState(""),
    [tick, setTick] = useState(Date.now());
  const refresh = () => setReload((n) => n + 1);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ from, to, scope });
    if (projectFilter) query.set("projectId", projectFilter);
    if (scope === "team" && person) query.set("userId", person);
    api<Timesheet>(`/timesheet?${query}`)
      .then((value) => {
        if (active) {
          setSheet(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) {
          setSheet(null);
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [from, to, scope, person, projectFilter, props.pulse, reload]);
  useEffect(() => {
    let active = true;
    setTasks([]);
    setTaskId("");
    if (!p.projectId) return;
    api<Plan>(`/projects/${p.projectId}/sprints`)
      .then((value) => {
        if (active) {
          setTasks(value.tasks);
          setTaskId(value.tasks[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [p.projectId, reload]);
  useEffect(() => {
    if (!sheet?.timer) return;
    const interval = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [sheet?.timer?.id]);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    message: string,
  ) {
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body: json(body) });
      refresh();
      notify(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (workspace.role === "guest")
    return (
      <Empty>
        <h2>Time tracking is available to workspace members.</h2>
      </Empty>
    );
  const timer = sheet?.timer,
    elapsed = timer
      ? Math.max(0, Math.floor((tick - Date.parse(timer.startedAt)) / 1000))
      : 0;
  return (
    <div className="planning-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE TIME VISIBLE</div>
          <h1>Timesheets</h1>
          <p>Log focused work and review time by date, project, or teammate.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setError("");
            setForm("new");
          }}
        >
          <Plus size={16} />
          Log time
        </button>
      </div>
      <ErrorLine error={error || p.error} />
      <section className="timer-strip" aria-label="Work timer">
        <Clock3 size={23} strokeWidth={1.4} />
        <div className="timer-text">
          <strong>{timer ? timer.taskTitle : "Track a work session"}</strong>
          <small>
            {timer
              ? "Running on the server · Entries use UTC dates"
              : "One timer per person in this workspace"}
          </small>
        </div>
        {timer ? (
          <>
            <span className="timer-digits" role="timer">
              {Math.floor(elapsed / 3600)
                .toString()
                .padStart(2, "0")}
              :
              {Math.floor((elapsed % 3600) / 60)
                .toString()
                .padStart(2, "0")}
              :{(elapsed % 60).toString().padStart(2, "0")}
            </span>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                mutate(
                  `/timer/${timer.id}/stop`,
                  "POST",
                  {},
                  "Timer saved to your timesheet.",
                )
              }
            >
              <Square size={13} />
              Stop & save
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                mutate(
                  `/timer/${timer.id}/stop`,
                  "POST",
                  { discard: true },
                  "Timer discarded.",
                )
              }
            >
              Discard timer
            </button>
          </>
        ) : (
          <>
            <select
              aria-label="Timer project"
              value={p.projectId}
              disabled={busy}
              onChange={(e) => p.setProjectId(e.target.value)}
            >
              {p.projects
                .filter((p) => p.status === "active")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              aria-label="Timer task"
              value={taskId}
              disabled={busy}
              onChange={(e) => setTaskId(e.target.value)}
            >
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {p.project?.key}-{t.number} · {t.title}
                </option>
              ))}
            </select>
            <button
              className="button secondary"
              disabled={busy || !taskId || p.project?.status !== "active"}
              onClick={() =>
                mutate(
                  `/projects/${p.projectId}/tasks/${taskId}/timer`,
                  "POST",
                  {},
                  "Timer started.",
                )
              }
            >
              <Play size={13} />
              Start timer
            </button>
          </>
        )}
      </section>
      <p className="planning-note timer-help">
        Saved timers round down to whole minutes, with a 1-minute minimum and a
        24-hour cap. Check long sessions before saving.
      </p>
      <div className="timesheet-controls">
        <label className="field">
          <span>From (UTC)</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span>To (UTC)</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="field">
          <span>View</span>
          <select
            aria-label="Timesheet scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setPerson("");
            }}
          >
            <option value="mine">My time</option>
            {canManage(workspace) && <option value="team">Team time</option>}
          </select>
        </label>
        <label className="field">
          <span>Project</span>
          <select
            aria-label="Timesheet project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All projects</option>
            {p.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {scope === "team" && (
          <label className="field">
            <span>Person</span>
            <select value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Everyone</option>
              {props.members
                .filter((m) => m.role !== "guest")
                .map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <button
          className="icon-button"
          aria-label="Refresh timesheet"
          onClick={refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {sheet && (
        <>
          <div className="timesheet-summary">
            <div>
              <span>Total logged</span>
              <strong>{hours(sheet.totalMinutes)}</strong>
            </div>
            <div>
              <span>Entries</span>
              <strong>{sheet.entries.length}</strong>
            </div>
            <div>
              <span>{scope === "team" ? "People" : "Days with time"}</span>
              <strong>
                {scope === "team" ? sheet.people.length : sheet.daily.length}
              </strong>
            </div>
          </div>
          <div className="task-list-scroll">
            <table className="task-table time-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Task / project</th>
                  {scope === "team" && <th>Person</th>}
                  <th>Time</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sheet.entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {day(e.date)}
                      <small>{e.date.slice(0, 4)}</small>
                    </td>
                    <td>
                      <strong>
                        {e.taskCode} · {e.taskTitle}
                      </strong>
                      <small>
                        {e.projectName} · {e.source}
                      </small>
                    </td>
                    {scope === "team" && <td>{e.userName}</td>}
                    <td>{hours(e.minutes)}</td>
                    <td>{e.note || "—"}</td>
                    <td>
                      {e.userId === user.id &&
                        p.projects.find((p) => p.id === e.projectId)?.status ===
                          "active" && (
                          <div className="planning-actions">
                            <button
                              className="text-button"
                              onClick={() => {
                                setError("");
                                setForm(e);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-button"
                              onClick={() => setRemove(e)}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!sheet.entries.length && (
              <Empty>
                <h3>No time in this range.</h3>
                <p>Log time or start a timer to record your work.</p>
              </Empty>
            )}
          </div>
          {sheet.daily.length > 0 && (
            <details className="report-details">
              <summary>Daily totals</summary>
              <table className="task-table">
                <thead>
                  <tr>
                    <th>Date (UTC)</th>
                    <th>Logged</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.daily.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{hours(d.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
      {form && (
        <SheetDialog
          title={form === "new" ? "Log time" : "Edit time entry"}
          description="Only you can change your entries. A person can log up to 24 hours per UTC date."
          close={() => {
            if (!busy) {
              setForm(null);
              setError("");
            }
          }}
        >
          <TimeForm
            api={api}
            projects={p.projects.filter((p) => p.status === "active")}
            entry={form === "new" ? undefined : form}
            busy={busy}
            error={error}
            save={async (projectId, taskId, values) => {
              if (
                await mutate(
                  form === "new"
                    ? `/projects/${projectId}/tasks/${taskId}/time`
                    : `/time/${form.id}`,
                  form === "new" ? "POST" : "PATCH",
                  {
                    ...values,
                    ...(form === "new" ? {} : { revision: form.revision }),
                  },
                  "Time entry saved.",
                )
              )
                setForm(null);
            }}
          />
        </SheetDialog>
      )}
      {remove && (
        <SheetDialog
          title="Remove time entry?"
          description={`${hours(remove.minutes)} on ${remove.taskCode}, ${remove.date}. This removes your entry from timesheet totals.`}
          close={() => {
            if (!busy) setRemove(null);
          }}
        >
          <ErrorLine error={error} />
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              if (
                await mutate(
                  `/time/${remove.id}`,
                  "DELETE",
                  { revision: remove.revision },
                  "Time entry removed.",
                )
              )
                setRemove(null);
            }}
          >
            Remove entry
          </button>
        </SheetDialog>
      )}
    </div>
  );
}
function TimeForm({
  api,
  projects,
  entry,
  busy,
  error,
  save,
}: {
  api: ScopedApi;
  projects: Project[];
  entry?: TimeEntry;
  busy: boolean;
  error: string;
  save: (
    project: string,
    task: string,
    values: { date: string; minutes: number; note: string },
  ) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(
      entry?.projectId ?? projects[0]?.id ?? "",
    ),
    [taskId, setTaskId] = useState(entry?.taskId ?? ""),
    [tasks, setTasks] = useState<Task[]>([]),
    [loadError, setLoadError] = useState("");
  const [date, setDate] = useState(entry?.date ?? utcToday()),
    [minutes, setMinutes] = useState(entry?.minutes ?? 60),
    [note, setNote] = useState(entry?.note ?? "");
  useEffect(() => {
    let active = true;
    if (entry || !projectId) return;
    setTasks([]);
    setTaskId("");
    api<Plan>(`/projects/${projectId}/sprints`)
      .then((value) => {
        if (active) {
          setTasks(value.tasks);
          setTaskId(value.tasks[0]?.id ?? "");
          setLoadError("");
        }
      })
      .catch((e) => {
        if (active) setLoadError(e.message);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(projectId, taskId, { date, minutes, note });
      }}
    >
      <ErrorLine error={error || loadError} />
      {entry ? (
        <p className="planning-callout">
          {entry.taskCode} · {entry.taskTitle}
        </p>
      ) : (
        <>
          <label className="field">
            <span>Project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Task</span>
            <select
              required
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {projects.find((p) => p.id === projectId)?.key}-{t.number} ·{" "}
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="planning-form-row">
        <label className="field">
          <span>Work date (UTC)</span>
          <input
            type="date"
            required
            max={utcToday()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Minutes</span>
          <input
            type="number"
            required
            min={1}
            max={1440}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="field">
        <span>Note</span>
        <textarea
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button className="button primary" disabled={busy || (!entry && !taskId)}>
        {busy ? "Saving…" : "Save time"}
      </button>
    </form>
  );
}

export function Reports(props: Props) {
  const p = useProjects(props.api, props.pulse),
    plan = usePlan(props.api, p.projectId, props.pulse),
    [tab, setTab] = useState("burndown"),
    [sprintId, setSprintId] = useState(""),
    [report, setReport] = useState<SprintReport | null>(null),
    [velocity, setVelocity] = useState<Sprint[]>([]),
    [load, setLoad] = useState<Workload | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setSprintId((old) =>
      plan.data?.sprints.some((s) => s.id === old)
        ? old
        : ((
            plan.data?.sprints.find((s) => s.status === "active") ??
            plan.data?.sprints[0]
          )?.id ?? ""),
    );
  }, [plan.data]);
  useEffect(() => {
    let active = true;
    setReport(null);
    setVelocity([]);
    setLoad(null);
    setError("");
    if (!p.projectId || (tab === "burndown" && !sprintId)) return;
    const path = `/projects/${p.projectId}/reports/${tab === "burndown" ? `burndown/${sprintId}` : tab}`;
    props
      .api<any>(path)
      .then((value) => {
        if (active) {
          if (tab === "burndown") setReport(value);
          else if (tab === "velocity") setVelocity(value.sprints);
          else setLoad(value);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [p.projectId, sprintId, tab, props.pulse]);
  return (
    <div className="planning-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SEE HOW WORK MOVES</div>
          <h1>Reports</h1>
          <p>
            Historical sprint progress, completed velocity, and current
            workload.
          </p>
        </div>
        <BarChart3
          className="planning-heading-icon"
          size={32}
          strokeWidth={1.2}
        />
      </div>
      <div className="planning-controls">
        <ProjectPicker
          projects={p.projects}
          value={p.projectId}
          change={p.setProjectId}
        />
        <span className="planning-note">
          Top-level tasks · UTC dates · Subtasks excluded from sprint totals
        </span>
      </div>
      <div className="inbox-toolbar">
        {[
          { id: "burndown", label: "Burndown" },
          { id: "velocity", label: "Velocity" },
          ...(props.workspace.role !== "guest"
            ? [{ id: "workload", label: "Workload" }]
            : []),
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "selected" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ErrorLine error={error || plan.error || p.error} />
      {!p.projects.length ? (
        <Empty>
          <h2>Reports begin with a project.</h2>
        </Empty>
      ) : tab === "burndown" ? (
        <>
          <label className="planning-project report-sprint-picker">
            <span>Sprint</span>
            <select
              aria-label="Report sprint"
              value={sprintId}
              onChange={(e) => setSprintId(e.target.value)}
            >
              {plan.data?.sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.status})
                </option>
              ))}
            </select>
          </label>
          {report ? (
            <>
              <div className="report-heading">
                <div>
                  <h2>{report.sprint.name}</h2>
                  <p>
                    {day(report.sprint.startDate)} –{" "}
                    {day(report.sprint.endDate)} · {report.sprint.status}
                  </p>
                </div>
                <span>
                  <strong>
                    {report.sprint.totalTasks - report.sprint.doneTasks}
                  </strong>{" "}
                  unfinished at{" "}
                  {report.sprint.status === "completed"
                    ? "completion"
                    : "latest update"}
                </span>
              </div>
              {report.points.length ? (
                <>
                  <Burndown report={report} />
                  <p className="planning-note">
                    Actual values are the last saved state each UTC day. Scope
                    changes can raise or lower the line; future days stay blank.
                    The ideal line uses the initial remaining task count.
                  </p>
                  <details className="report-details">
                    <summary>
                      View saved progress history ({report.points.length}{" "}
                      points)
                    </summary>
                    <div className="task-list-scroll">
                      <table className="task-table">
                        <thead>
                          <tr>
                            <th>Saved at (UTC)</th>
                            <th>Scope</th>
                            <th>Done</th>
                            <th>Remaining</th>
                            <th>Estimated hours remaining</th>
                            <th>Unestimated tasks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.points.map((point, i) => (
                            <tr key={i}>
                              <td>{point.at.replace("T", " ").slice(0, 19)}</td>
                              <td>{point.totalTasks}</td>
                              <td>{point.doneTasks}</td>
                              <td>{point.remainingTasks}</td>
                              <td>{point.remainingHours}</td>
                              <td>{point.unestimated}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              ) : (
                <Empty>
                  <h3>This sprint hasn’t started.</h3>
                  <p>Start it in Sprints to begin recording progress.</p>
                </Empty>
              )}
            </>
          ) : (
            <Empty>
              <h3>
                {sprintId ? "Loading sprint history…" : "No sprints yet."}
              </h3>
              <p>Create a sprint to begin tracking progress.</p>
            </Empty>
          )}
        </>
      ) : tab === "velocity" ? (
        velocity.length ? (
          <>
            <div className="report-heading">
              <div>
                <h2>Completed sprint velocity</h2>
                <p>
                  Last 12 completed sprints · Results frozen when each sprint
                  ended
                </p>
              </div>
            </div>
            <div
              className="velocity-chart"
              role="img"
              aria-label="Completed tasks per sprint"
            >
              {velocity.map((s) => (
                <div key={s.id} className="velocity-column">
                  <div className="velocity-bar-track">
                    <span
                      style={{
                        height: `${Math.max(2, (s.doneTasks / Math.max(1, ...velocity.map((s) => s.totalTasks))) * 100)}%`,
                      }}
                    >
                      <b>{s.doneTasks}</b>
                    </span>
                  </div>
                  <strong>{s.name}</strong>
                  <small>
                    {s.doneTasks}/{s.totalTasks} tasks · {s.doneHours}h
                  </small>
                </div>
              ))}
            </div>
            <div className="task-list-scroll">
              <table className="task-table">
                <thead>
                  <tr>
                    <th>Sprint</th>
                    <th>Completed</th>
                    <th>Scope at completion</th>
                    <th>Completed estimate</th>
                    <th>Unestimated</th>
                  </tr>
                </thead>
                <tbody>
                  {velocity.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.doneTasks} tasks</td>
                      <td>{s.totalTasks} tasks</td>
                      <td>{s.doneHours}h</td>
                      <td>{s.unestimated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="planning-note">
              Velocity counts completed tasks, not logged time. Estimates are
              hours; unestimated tasks contribute to task counts only.
            </p>
          </>
        ) : (
          <Empty>
            <h3>No completed sprints yet.</h3>
            <p>Complete a sprint to save its velocity.</p>
          </Empty>
        )
      ) : load ? (
        <>
          <div className="report-heading">
            <div>
              <h2>Current workload</h2>
              <p>Open top-level tasks across this project</p>
            </div>
            <span>
              <strong>{load.totalOpen}</strong> open tasks
            </span>
          </div>
          <div className="workload-rows">
            {load.rows.map((row) => (
              <div key={row.userId ?? "none"} className="workload-row">
                <strong>{row.name}</strong>
                <div className="workload-track">
                  <span
                    style={{
                      width: `${(row.estimatedHours / Math.max(1, ...load.rows.map((r) => r.estimatedHours))) * 100}%`,
                    }}
                  />
                </div>
                <span>
                  {row.estimatedHours}h · {row.tasks} tasks
                </span>
                <small>
                  {row.unestimated} unestimated · {row.overdue} overdue
                </small>
              </div>
            ))}
          </div>
          {!load.rows.length && (
            <Empty>
              <h3>No open work.</h3>
            </Empty>
          )}
          <p className="planning-note">
            Shows full task estimates, not remaining capacity or logged effort.
            Overdue means the due date is before today (UTC).
          </p>
        </>
      ) : (
        <p role="status">Loading workload…</p>
      )}
    </div>
  );
}
function Burndown({ report }: { report: SprintReport }) {
  const width = 820,
    height = 280,
    left = 44,
    top = 22,
    right = 22,
    bottom = 38;
  const max = Math.max(
      1,
      ...report.days.map((d) => Math.max(d.ideal, d.remaining ?? 0)),
    ),
    count = report.days.length;
  const x = (i: number) =>
      left + (i / Math.max(1, count - 1)) * (width - left - right),
    y = (value: number) => top + (1 - value / max) * (height - top - bottom);
  const actual = report.days
    .map((d, i) => (d.remaining == null ? null : `${x(i)},${y(d.remaining)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <div className="burndown-chart">
      <div className="chart-legend">
        <span>
          <i />
          Actual tasks remaining
        </span>
        <span>
          <i className="ideal" />
          Ideal
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Burndown for ${report.sprint.name}. ${report.sprint.totalTasks - report.sprint.doneTasks} tasks unfinished at the latest saved point.`}
      >
        <title>Tasks remaining over the planned sprint dates (UTC)</title>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1={left}
              x2={width - right}
              y1={y((max * i) / 4)}
              y2={y((max * i) / 4)}
              className="chart-grid"
            />
            <text x={left - 10} y={y((max * i) / 4) + 4} textAnchor="end">
              {Number(((max * i) / 4).toFixed(1))}
            </text>
          </g>
        ))}
        <polyline
          points={report.days.map((d, i) => `${x(i)},${y(d.ideal)}`).join(" ")}
          className="chart-ideal"
        />
        <polyline points={actual} className="chart-actual" />
        {report.days.map(
          (d, i) =>
            d.remaining != null && (
              <circle
                key={d.date}
                cx={x(i)}
                cy={y(d.remaining)}
                r={3}
                className="chart-dot"
              >
                <title>
                  {d.date}: {d.remaining} remaining
                </title>
              </circle>
            ),
        )}
        {report.days.map(
          (d, i) =>
            (i === 0 ||
              i === count - 1 ||
              (count > 4 && i === Math.floor(count / 2))) && (
              <text
                key={d.date}
                x={x(i)}
                y={height - 12}
                textAnchor={
                  i === 0 ? "start" : i === count - 1 ? "end" : "middle"
                }
              >
                {day(d.date)}
              </text>
            ),
        )}
      </svg>
    </div>
  );
}
