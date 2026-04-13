"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { GatewayConnection } from "./GatewayConnection";
import * as protocol from "./gatewayProtocol";

type BoundMethod<T> =
  T extends (call: protocol.CallFn, ...args: infer Params) => infer Result
    ? (...args: Params) => Result
    : never;

type GatewayContextValue = {
  connected: boolean;
  pairingRequired: boolean;
  error: string | null;
  reconnect: () => void;
  subscribe: (event: string, cb: (payload: unknown) => void) => () => void;
  health: BoundMethod<typeof protocol.health>;
  status: BoundMethod<typeof protocol.status>;
  agentsList: BoundMethod<typeof protocol.agentsList>;
  sessionsList: BoundMethod<typeof protocol.sessionsList>;
  sessionsGet: BoundMethod<typeof protocol.sessionsGet>;
  chatHistory: BoundMethod<typeof protocol.chatHistory>;
  chatSend: BoundMethod<typeof protocol.chatSend>;
  chatAbort: BoundMethod<typeof protocol.chatAbort>;
  cronList: BoundMethod<typeof protocol.cronList>;
  cronRuns: BoundMethod<typeof protocol.cronRuns>;
  cronUpdate: BoundMethod<typeof protocol.cronUpdate>;
  agentsFilesList: BoundMethod<typeof protocol.agentsFilesList>;
  agentsFilesGet: BoundMethod<typeof protocol.agentsFilesGet>;
  skillsStatus: BoundMethod<typeof protocol.skillsStatus>;
  logsTail: BoundMethod<typeof protocol.logsTail>;
  usageCost: BoundMethod<typeof protocol.usageCost>;
  sessionsUsage: BoundMethod<typeof protocol.sessionsUsage>;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

function throwMissingConnection(): never {
  throw new Error("Gateway connection is not ready");
}

export function GatewayProvider({
  children,
  url,
  token,
  password,
}: {
  children: ReactNode;
  url: string;
  token?: string;
  password?: string;
}) {
  const [connection, setConnection] = useState<GatewayConnection | null>(null);
  const [stateVersion, setStateVersion] = useState(0);

  useEffect(() => {
    if (!url) {
      setConnection(null);
      return;
    }
    const nextConnection = new GatewayConnection({
      url,
      token,
      password,
    });
    nextConnection.onStateChange = () => {
      setStateVersion((value) => value + 1);
    };
    setConnection(nextConnection);
    nextConnection.connect();
    return () => {
      nextConnection.onStateChange = null;
      nextConnection.disconnect();
      setConnection((current) => (current === nextConnection ? null : current));
    };
  }, [url, token, password]);

  const reconnect = useCallback(() => {
    connection?.connect();
  }, [connection]);

  const subscribe = useCallback<GatewayContextValue["subscribe"]>((event, cb) => {
    if (!connection) return () => {};
    return connection.subscribe(event, cb);
  }, [connection]);

  const call = useCallback((...args: Parameters<GatewayConnection["call"]>) => {
    if (!connection) throwMissingConnection();
    return connection.call(...args);
  }, [connection]);

  const value = useMemo<GatewayContextValue>(() => ({
    connected: connection?.connected ?? false,
    pairingRequired: connection?.pairingRequired ?? false,
    error: connection?.error ?? null,
    reconnect,
    subscribe,
    health: (...args) => protocol.health(call, ...args),
    status: (...args) => protocol.status(call, ...args),
    agentsList: (...args) => protocol.agentsList(call, ...args),
    sessionsList: (...args) => protocol.sessionsList(call, ...args),
    sessionsGet: (...args) => protocol.sessionsGet(call, ...args),
    chatHistory: (...args) => protocol.chatHistory(call, ...args),
    chatSend: (...args) => protocol.chatSend(call, ...args),
    chatAbort: (...args) => protocol.chatAbort(call, ...args),
    cronList: (...args) => protocol.cronList(call, ...args),
    cronRuns: (...args) => protocol.cronRuns(call, ...args),
    cronUpdate: (...args) => protocol.cronUpdate(call, ...args),
    agentsFilesList: (...args) => protocol.agentsFilesList(call, ...args),
    agentsFilesGet: (...args) => protocol.agentsFilesGet(call, ...args),
    skillsStatus: (...args) => protocol.skillsStatus(call, ...args),
    logsTail: (...args) => protocol.logsTail(call, ...args),
    usageCost: (...args) => protocol.usageCost(call, ...args),
    sessionsUsage: (...args) => protocol.sessionsUsage(call, ...args),
  }), [call, connection?.connected, connection?.error, connection?.pairingRequired, reconnect, stateVersion, subscribe]);

  return (
    <GatewayContext.Provider value={value}>
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) {
    throw new Error("useGateway must be used within a GatewayProvider");
  }
  return context;
}
