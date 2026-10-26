import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
export function useWorkspaceLive(
  workspaceId: string | undefined,
  userId: string | undefined,
  token: () => Promise<string>,
  revoked: () => void,
) {
  const callbacks = useRef({ token, revoked });
  callbacks.current = { token, revoked };
  const [pulse, setPulse] = useState(0);
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    if (!workspaceId || !userId) return;
    let disposed = false;
    let debounce: ReturnType<typeof setTimeout>;
    let retry: ReturnType<typeof setTimeout>;
    const socket = io({
      path: "/api/socket.io",
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: (callback) => {
        callbacks.current
          .token()
          .then((token) => {
            if (!disposed) callback({ token });
          })
          .catch(() => {
            if (!disposed) {
              callbacks.current.revoked();
              callback({ token: "" });
            }
          });
      },
    });
    socket.on("connect", () => {
      if (!disposed) {
        setStatus("Live");
        setPulse((value) => value + 1);
      }
    });
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!disposed) setPulse((value) => value + 1);
      }, 80);
    };
    for (const event of [
      "workspace:changed",
      "project:changed",
      "task:moved",
      "task:updated",
      "comment:new",
      "notification:new",
    ])
      socket.on(event, refresh);
    socket.on("disconnect", (reason) => {
      if (!disposed) {
        setStatus("Reconnecting");
        if (reason === "io server disconnect") {
          retry = setTimeout(() => socket.connect(), 1000);
        }
      }
    });
    socket.on("connect_error", () => {
      if (!disposed) {
        setStatus("Offline");
        clearTimeout(retry);
        retry = setTimeout(() => socket.connect(), 5000);
      }
    });
    socket.on("access:revoked", () => {
      if (!disposed) {
        setStatus("Reconnecting");
        callbacks.current.revoked();
      }
    });
    const heartbeat = setInterval(() => {
      if (socket.connected) socket.emit("auth:check");
    }, 30000);
    const renewal = setInterval(() => {
      socket.disconnect();
      socket.connect();
    }, 50 * 60000);
    socket.connect();
    return () => {
      disposed = true;
      clearTimeout(debounce);
      clearTimeout(retry);
      clearInterval(heartbeat);
      clearInterval(renewal);
      socket.disconnect();
    };
  }, [workspaceId, userId]);
  return { pulse, status: workspaceId ? status : "Offline" };
}
