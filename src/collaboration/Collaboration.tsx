import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  CheckCheck,
  Copy,
  Download,
  Edit3,
  FileText,
  Inbox as InboxIcon,
  LoaderCircle,
  Mail,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { json, type ApiOptions, type Member, type User } from "../api";
import type {
  Attachment,
  Comment,
  Inbox,
  MailDelivery,
  Navigation,
} from "../../shared/collaboration";
import "./collaboration.css";
export type ScopedApi = <T>(path: string, options?: ApiOptions) => Promise<T>;
const ago = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((value) => value[0])
    .join("")
    .toUpperCase();
export function TaskCollaboration({
  projectId,
  taskId,
  user,
  members,
  guestIds,
  canWrite,
  manager,
  api,
  pulse,
  dirtyChanged,
}: {
  projectId: string;
  taskId: string;
  user: User;
  members: Member[];
  guestIds: string[];
  canWrite: boolean;
  manager: boolean;
  api: ScopedApi;
  pulse: number;
  dirtyChanged: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<{
    comments: Comment[];
    attachments: Attachment[];
  }>({ comments: [], attachments: [] });
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [editing, setEditing] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const path = `/projects/${projectId}/tasks/${taskId}`;
  async function load() {
    const current = ++sequence.current;
    try {
      const result = await api<typeof data>(`${path}/collaboration`);
      if (alive.current && current === sequence.current) setData(result);
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++sequence.current;
    };
  }, [projectId, taskId]);
  useEffect(() => {
    if (pulse) void load();
  }, [pulse]);
  useEffect(() => {
    dirtyChanged(!!draft.trim());
    return () => dirtyChanged(false);
  }, [draft]);
  const mentionMatch = draft.match(/(?:^|\s)@([^@\n]{0,45})$/);
  const mentionable = members.filter(
    (member) => member.role !== "guest" || guestIds.includes(member.user.id),
  );
  const suggestions = mentionMatch
    ? mentionable
        .filter((member) =>
          member.user.name
            .toLowerCase()
            .includes(mentionMatch[1].toLowerCase()),
        )
        .slice(0, 6)
    : [];
  async function post() {
    setBusy(true);
    setError("");
    try {
      const result = await api<typeof data>(
        `${path}/comments${editing ? `/${editing.id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          body: json({
            body: draft,
            mentionIds: mentions,
            ...(editing ? { revision: editing.revision } : {}),
          }),
        },
      );
      if (alive.current) {
        setData(result);
        setDraft("");
        setMentions([]);
        setEditing(null);
      }
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="task-collaboration">
      <div className="section-heading">
        <h2>
          <Paperclip size={14} />
          Attachments <span>{data.attachments.length}</span>
        </h2>
        {canWrite && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={12} />
            Attach file
          </button>
        )}
      </div>
      <input
        ref={fileInput}
        className="sr-only"
        aria-label="Attach file"
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.zip,.docx,.xlsx,.pptx"
        disabled={!canWrite || busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) {
            setError("Files must be 10 MB or smaller.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const body = new FormData();
            body.append("file", file);
            const result = await api<typeof data>(`${path}/attachments`, {
              method: "POST",
              body,
            });
            if (alive.current) setData(result);
          } catch (error) {
            setError((error as Error).message);
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
      />
      {data.attachments.length ? (
        <div className="attachment-list">
          {data.attachments.map((file) => (
            <div className="attachment-row" key={file.id}>
              <FileText size={18} />
              <span>
                <strong>{file.filename}</strong>
                <small>
                  {(file.size / 1024).toFixed(1)} KB · {file.uploaderName}
                </small>
              </span>
              <button
                className="icon-button"
                aria-label={`Download ${file.filename}`}
                disabled={busy}
                onClick={async () => {
                  setError("");
                  try {
                    const blob = await api<Blob>(
                      `${path}/attachments/${file.id}/download`,
                      { binary: true },
                    );
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = file.filename;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                <Download size={14} />
              </button>
              {canWrite && (manager || file.uploadedBy === user.id) && (
                <button
                  className="icon-button"
                  aria-label={`Remove attachment ${file.filename}`}
                  disabled={busy}
                  onClick={() => setConfirmDelete(`file:${file.id}`)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="collab-empty">
          Keep references and handoff files with this task.
        </p>
      )}
      <p className="attachment-hint">
        PDF, images, text, ZIP and Office files · Up to 10 MB each
      </p>
      <div className="section-heading comments-heading">
        <h2>
          <MessageSquare size={14} />
          Comments <span>{data.comments.length}</span>
        </h2>
        <button
          className="icon-button"
          aria-label="Refresh comments"
          onClick={load}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {!data.comments.length && (
        <p className="collab-empty">
          Share an update or ask your team a question.
        </p>
      )}
      <div className="comment-list">
        {data.comments.map((comment) => (
          <article key={comment.id} className="comment-row">
            <span className="comment-avatar">
              {initials(comment.authorName)}
            </span>
            <div>
              <div className="comment-author">
                <strong>{comment.authorName}</strong>
                <time>{ago(comment.createdAt)}</time>
                {comment.revision > 0 && <small>edited</small>}
              </div>
              <p>{comment.body}</p>
              {canWrite && (
                <div className="comment-actions">
                  {comment.authorId === user.id && (
                    <button
                      disabled={
                        busy || (!!draft.trim() && editing?.id !== comment.id)
                      }
                      onClick={() => {
                        setEditing({
                          id: comment.id,
                          revision: comment.revision,
                        });
                        setDraft(comment.body);
                        setMentions(comment.mentionIds);
                        setError("");
                        input.current?.focus();
                      }}
                    >
                      <Edit3 size={11} />
                      Edit
                    </button>
                  )}
                  {(manager || comment.authorId === user.id) && (
                    <button
                      disabled={busy}
                      onClick={() => setConfirmDelete(`comment:${comment.id}`)}
                    >
                      <Trash2 size={11} />
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
      {confirmDelete && (
        <div className="collab-confirm">
          <span>
            Remove this{" "}
            {confirmDelete.startsWith("file:") ? "attachment" : "comment"}?
          </span>
          <button
            className="text-button"
            onClick={() => setConfirmDelete(null)}
          >
            Keep it
          </button>
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              const [kind, id] = confirmDelete.split(":");
              try {
                const result = await api<typeof data>(
                  `${path}/${kind === "file" ? "attachments" : "comments"}/${id}`,
                  {
                    method: "DELETE",
                    ...(kind === "comment"
                      ? {
                          body: json({
                            revision: data.comments.find(
                              (comment) => comment.id === id,
                            )!.revision,
                          }),
                        }
                      : {}),
                  },
                );
                setData(result);
                setConfirmDelete(null);
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove
          </button>
        </div>
      )}
      {canWrite && (
        <div className="comment-compose">
          {editing && (
            <div className="editing-comment">
              Editing your comment
              <button
                className="text-button"
                onClick={() => {
                  setEditing(null);
                  setDraft("");
                  setMentions([]);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          <label>
            <span className="sr-only">Comment</span>
            <textarea
              ref={input}
              aria-label="Comment"
              placeholder="Write an update… type @ to mention a teammate"
              value={draft}
              maxLength={4000}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setMentions((ids) =>
                  ids.filter((id) =>
                    event.target.value.includes(
                      `@${members.find((member) => member.user.id === id)?.user.name}`,
                    ),
                  ),
                );
              }}
            />
          </label>
          {suggestions.length > 0 && (
            <div
              className="mention-suggestions"
              aria-label="Teammates to mention"
            >
              {suggestions.map((member) => (
                <button
                  key={member.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const index = draft.lastIndexOf("@");
                    setDraft(`${draft.slice(0, index)}@${member.user.name} `);
                    setMentions([...new Set([...mentions, member.user.id])]);
                    input.current?.focus();
                  }}
                >
                  <span className="comment-avatar">
                    {initials(member.user.name)}
                  </span>
                  <span>
                    {member.user.name}
                    <small>{member.user.email}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="comment-compose-footer">
            <small>Only selected mentions send a notification.</small>
            <button
              className="button primary"
              disabled={busy || !draft.trim()}
              onClick={post}
            >
              {busy ? (
                <LoaderCircle className="spinner" size={13} />
              ) : (
                <Send size={13} />
              )}{" "}
              {editing ? "Save comment" : "Post comment"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="work-error" role="alert">
          <span>{error}</span>
          {editing && (
            <button
              className="text-button"
              onClick={() => {
                const latest = data.comments.find(
                  (comment) => comment.id === editing.id,
                );
                if (latest) {
                  setDraft(latest.body);
                  setMentions(latest.mentionIds);
                  setEditing({ id: latest.id, revision: latest.revision });
                  setError("");
                }
              }}
            >
              Use latest comment
            </button>
          )}
        </div>
      )}
    </section>
  );
}
export function InboxView({
  data,
  api,
  refresh,
  open,
}: {
  data: Inbox;
  api: ScopedApi;
  refresh: () => Promise<void>;
  open: (navigation: Navigation) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  async function read(id?: string) {
    setBusy(true);
    try {
      await api(`/notifications/${id ? `${id}/` : ""}read`, {
        method: "PATCH",
        body: "{}",
      });
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const items = data.notifications.filter(
    (item) => !unreadOnly || !item.readAt,
  );
  return (
    <div className="inbox-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">KEEP IN THE LOOP</div>
          <h1>Your inbox</h1>
          <p>Mentions and task assignments, gathered in one place.</p>
        </div>
        <button
          className="button"
          disabled={busy || !data.unread}
          onClick={() => read()}
        >
          <CheckCheck size={15} />
          Mark all as read
        </button>
      </div>
      <div className="inbox-toolbar">
        <button
          className={!unreadOnly ? "selected" : ""}
          onClick={() => setUnreadOnly(false)}
        >
          All updates
        </button>
        <button
          className={unreadOnly ? "selected" : ""}
          onClick={() => setUnreadOnly(true)}
        >
          Unread <span>{data.unread}</span>
        </button>
      </div>
      {error && (
        <div className="work-error" role="alert">
          {error}
        </div>
      )}
      {items.length ? (
        items.map((item) => (
          <div
            className={`notification-row ${item.readAt ? "" : "unread"}`}
            key={item.id}
          >
            <span className="notification-symbol">
              {item.kind === "mention" ? "@" : <Bell size={17} />}
            </span>
            <button
              className="notification-open"
              onClick={() => {
                if (!item.readAt) void read(item.id);
                open({
                  projectId: item.projectId,
                  taskId: item.taskId,
                  nonce: Date.now(),
                });
              }}
            >
              <strong>
                {item.actorName}{" "}
                {item.kind === "mention"
                  ? "mentioned you in a comment"
                  : "assigned you a task"}
              </strong>
              <span>{item.title}</span>
              <small>{ago(item.createdAt)}</small>
            </button>
            {!item.readAt && (
              <button
                className="icon-button"
                aria-label={`Mark notification for ${item.title} as read`}
                disabled={busy}
                onClick={() => read(item.id)}
              >
                <Check size={15} />
              </button>
            )}
          </div>
        ))
      ) : (
        <div className="inbox-empty">
          <InboxIcon size={35} strokeWidth={1.1} />
          <h2>You’re all caught up.</h2>
          <p>Your next mention or assignment will appear here.</p>
        </div>
      )}
    </div>
  );
}
export function MailDeliveryPanel({
  api,
  pulse,
}: {
  api: ScopedApi;
  pulse: number;
}) {
  const [data, setData] = useState<{
    mode: string;
    deliveries: MailDelivery[];
  }>({ mode: "local", deliveries: [] });
  const [preview, setPreview] = useState<{
    subject: string;
    text: string;
    url: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<typeof data>("/mail")
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
  return (
    <section className="mail-delivery-panel">
      <div className="section-heading">
        <h2>
          <Mail size={15} />
          Invitation delivery
        </h2>
        <span className="mail-mode">
          {data.mode === "local" ? "Private local mailbox" : "SMTP delivery"}
        </span>
      </div>
      <p className="mail-intro">
        {data.mode === "local"
          ? "Invitation emails are captured here for local testing. They are not sent externally."
          : "Queued invitation emails are sent by your configured mail provider."}
      </p>
      {data.deliveries.length ? (
        data.deliveries.map((item) => (
          <div className="mail-row" key={item.id}>
            <Mail size={16} />
            <span>
              <strong>{item.email}</strong>
              <small>{ago(item.createdAt)}</small>
            </span>
            <span className={`delivery-status ${item.status}`}>
              {item.status === "local" ? "Captured locally" : item.status}
            </span>
            {item.canPreview && (
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    setPreview(await api(`/mail/${item.id}/preview`));
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Preview
              </button>
            )}
            {item.status === "failed" && (
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    await api(`/mail/${item.id}/retry`, { method: "POST" });
                    setData(await api("/mail"));
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                Retry
              </button>
            )}
          </div>
        ))
      ) : (
        <p className="collab-empty">New invitations will appear here.</p>
      )}
      {preview && (
        <div className="mail-preview">
          <div>
            <strong>{preview.subject}</strong>
            <button
              className="icon-button"
              aria-label="Close email preview"
              onClick={() => setPreview(null)}
            >
              <X size={15} />
            </button>
          </div>
          <pre>{preview.text}</pre>
          <button
            className="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(preview.url);
              } catch {
                setError(
                  "Select the link in the preview and copy it manually.",
                );
              }
            }}
          >
            <Copy size={14} />
            Copy invitation link
          </button>
        </div>
      )}
      {error && (
        <div className="work-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
