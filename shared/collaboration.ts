export type Comment = {
  id: string;
  body: string;
  mentionIds: string[];
  authorId: string;
  authorName: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type Attachment = {
  id: string;
  filename: string;
  size: number;
  uploadedBy: string;
  uploaderName: string;
  createdAt: string;
};
export type Notification = {
  id: string;
  kind: "mention" | "assignment";
  actorName: string;
  title: string;
  projectId: string;
  taskId: string;
  readAt: string | null;
  createdAt: string;
};
export type Inbox = { notifications: Notification[]; unread: number };
export type MailDelivery = {
  id: string;
  email: string;
  status: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  canPreview: boolean;
};
export type Navigation = { projectId: string; taskId?: string; nonce: number };
