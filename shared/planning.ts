import type { Project, Task } from "./work";
export type Sprint = {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  status: "planned" | "active" | "completed";
  revision: number;
  startedAt: string | null;
  completedAt: string | null;
  totalTasks: number;
  doneTasks: number;
  totalHours: number;
  doneHours: number;
  unestimated: number;
};
export type SprintValues = Pick<
  Sprint,
  "name" | "goal" | "startDate" | "endDate"
>;
export type Planning = {
  projects: Project[];
  tasks: Task[];
  sprints: Sprint[];
  boardVersion: number;
};
export type ProgressPoint = {
  at: string;
  totalTasks: number;
  doneTasks: number;
  remainingTasks: number;
  totalHours: number;
  doneHours: number;
  remainingHours: number;
  unestimated: number;
};
export type SprintReport = {
  sprint: Sprint;
  points: ProgressPoint[];
  days: { date: string; ideal: number; remaining: number | null }[];
};
export type TimeEntry = {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  taskCode: string;
  userId: string;
  userName: string;
  date: string;
  minutes: number;
  note: string;
  revision: number;
  source: "manual" | "timer";
};
export type Timer = {
  id: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  startedAt: string;
};
export type Timesheet = {
  entries: TimeEntry[];
  totalMinutes: number;
  daily: { date: string; minutes: number }[];
  people: { userId: string; userName: string; minutes: number }[];
  timer: Timer | null;
};
export type Workload = {
  rows: {
    userId: string | null;
    name: string;
    tasks: number;
    estimatedHours: number;
    unestimated: number;
    overdue: number;
  }[];
  totalOpen: number;
};
