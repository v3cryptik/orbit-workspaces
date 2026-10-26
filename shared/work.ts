export const taskStatuses = ["backlog", "todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const taskPriorities = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof taskPriorities)[number];
export const statusNames: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
export const priorityNames: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
export type Project = {
  id: string;
  name: string;
  key: string;
  description: string;
  status: "active" | "archived";
  leadId: string | null;
  guestIds: string[];
  boardVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  completedCount: number;
};
export type Task = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  labels: string[];
  dueDate: string | null;
  estimateHours: number | null;
  order: number;
  parentTaskId: string | null;
  sprintId: string | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
export type ProjectValues = {
  name: string;
  key: string;
  description: string;
  leadId: string | null;
  guestIds: string[];
};
export type TaskValues = {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  labels: string[];
  dueDate: string | null;
  estimateHours: number | null;
};
export type BoardSnapshot = { project: Project; tasks: Task[] };
