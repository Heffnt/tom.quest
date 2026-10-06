"use client";

// Which of the two Claude logins runs this session's next reply. The select
// shows the row's login, or the login the box holds when the row names none,
// which is the login such a session runs under.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "@/app/jarvis/components/info";
import { SESSION_LOGINS } from "@/convex/ttsShared";

type SessionLogin = (typeof SESSION_LOGINS)[number];
import type { Session } from "@/app/agents/lib";

export default function LoginSelect({
  session,
  boxLogin,
}: {
  session: Session;
  /** The session host's activeAccount: "wpi" or "gmail". */
  boxLogin?: string;
}) {
  const setSessionLogin = useMutation(api.claudeSessions.setSessionLogin);
  const [error, setError] = useState<string | null>(null);
  const value = session.login ?? boxLogin ?? "";

  const change = async (login: SessionLogin) => {
    setError(null);
    try {
      await setSessionLogin({ sessionId: session._id, login });
    } catch (e) {
      setError(e instanceof Error ? e.message : "login change failed");
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      <select
        aria-label="session login"
        value={value}
        // The options are SESSION_LOGINS and a disabled placeholder, so a
        // change is always one of the two logins.
        onChange={(e) => void change(e.target.value as SessionLogin)}
        className="shrink-0 bg-surface-alt border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent hover:border-accent/60"
      >
        {value === "" && (
          <option value="" disabled>
            login
          </option>
        )}
        {SESSION_LOGINS.map((login) => (
          <option key={login} value={login}>
            {login}
          </option>
        ))}
      </select>
      <Info call="claudeSessions.setSessionLogin({ sessionId, login })">
        Which Claude login runs this session&rsquo;s next reply. Writes the
        session row&rsquo;s login field and nothing else; a row that names no
        login runs under the login the box holds.
      </Info>
      {error !== null && <span className="text-error">{error}</span>}
    </span>
  );
}
