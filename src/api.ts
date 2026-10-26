export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type ApiOptions = RequestInit & { binary?: boolean };
export async function request<T>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const { binary, ...fetchOptions } = options;
  const response = await fetch(`/api${path}`, {
    ...fetchOptions,
    credentials: "same-origin",
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      "x-orbit-request": "1",
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  if (response.ok && binary) return (await response.blob()) as T;
  const body = await response.json().catch(() => ({
    error: "The server could not be reached. Please try again.",
  }));
  if (!response.ok)
    throw new ApiFailure(response.status, body.error ?? "Request failed.");
  return body;
}
export const json = (body: unknown) => JSON.stringify(body);
export type Role = "owner" | "admin" | "member" | "guest";
export type User = { id: string; name: string; email: string };
export type Workspace = {
  id: string;
  name: string;
  slug: string;
  description: string;
  role: Role;
  plan: string;
  createdAt: string;
};
export type Member = { id: string; role: Role; joinedAt: string; user: User };
export type Activity = {
  _id: string;
  actorId: string;
  actorName: string;
  action: string;
  detail: string;
  createdAt: string;
};
export type Invitation = {
  _id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
};
export type Overview = {
  workspace: Workspace;
  members: Member[];
  activity: Activity[];
  stats: { members: number };
  permissions: { manageMembers: boolean; editWorkspace: boolean };
};
