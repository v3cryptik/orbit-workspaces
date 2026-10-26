import { useEffect, useState } from "react";
import { CheckCheck, ListTodo } from "lucide-react";
import type { ScopedApi } from "./Collaboration";
import type { Navigation } from "../../shared/collaboration";
import {
  statusNames,
  priorityNames,
  type Project,
  type Task,
} from "../../shared/work";
export function MyTasks({
  api,
  pulse,
  open,
}: {
  api: ScopedApi;
  pulse: number;
  open: (navigation: Navigation) => void;
}) {
  const [data, setData] = useState<{ projects: Project[]; tasks: Task[] }>({
    projects: [],
    tasks: [],
  });
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<typeof data>("/my-tasks")
      .then((value) => {
        if (active) setData(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [pulse]);
  const tasks = data.tasks.filter(
    (task) =>
      filter === "all" ||
      (filter === "done" ? task.status === "done" : task.status !== "done"),
  );
  return (
    <div>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR NEXT STEPS</div>
          <h1>My tasks</h1>
          <p>Your assignments across active projects in this workspace.</p>
        </div>
        <span className="my-tasks-total">
          <ListTodo size={15} />
          {data.tasks.filter((task) => task.status !== "done").length} open
          tasks
        </span>
      </div>
      <div className="inbox-toolbar">
        {[
          { id: "open", label: "Open" },
          { id: "done", label: "Completed" },
          { id: "all", label: "All tasks" },
        ].map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? "selected" : ""}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="work-error" role="alert">
          {error}
        </div>
      )}
      {tasks.length ? (
        <div className="task-list-scroll">
          <table className="task-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Due date</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const project = data.projects.find(
                  (project) => project.id === task.projectId,
                )!;
                return (
                  <tr key={task.id}>
                    <td>
                      <button
                        className="task-list-title"
                        onClick={() =>
                          open({
                            projectId: task.projectId,
                            taskId: task.id,
                            nonce: Date.now(),
                          })
                        }
                      >
                        <span>
                          {project.key}-{task.number}
                        </span>
                        <strong>{task.title}</strong>
                        {task.parentTaskId && <CheckCheck size={12} />}
                      </button>
                    </td>
                    <td>{project.name}</td>
                    <td>{statusNames[task.status]}</td>
                    <td>{priorityNames[task.priority]}</td>
                    <td>
                      {task.dueDate
                        ? new Date(
                            `${task.dueDate}T12:00:00`,
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="inbox-empty">
          <ListTodo size={35} strokeWidth={1.1} />
          <h2>
            {filter === "done"
              ? "No completed assignments yet."
              : "A clear space to start."}
          </h2>
          <p>Tasks assigned to you will appear here.</p>
        </div>
      )}
    </div>
  );
}
