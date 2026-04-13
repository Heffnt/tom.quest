"use client";

import {
  createElement,
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
  sessionsMessagesSubscribe: BoundMethod<typeof protocol.sessionsMessagesSubscribe>;
  sessionsMessagesUnsubscribe: BoundMethod<typeof protocol.sessionsMessagesUnsubscribe>;
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
  const [, setStateVersion] = useState(0);
  const handleStateChange = useCallback(() => {
    setStateVersion((value) => value + 1);
  }, []);
  const connection = useMemo(() => {
    if (!url) return null;
    return new GatewayConnection({
      url,
      token,
      password,
      onStateChange: handleStateChange,
    });
  }, [handleStateChange, password, token, url]);

  useEffect(() => {
    if (!connection) return;
    connection.connect();
    return () => {
      connection.disconnect();
    };
  }, [connection]);

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
    sessionsMessagesSubscribe: (...args) => protocol.sessionsMessagesSubscribe(call, ...args),
    sessionsMessagesUnsubscribe: (...args) => protocol.sessionsMessagesUnsubscribe(call, ...args),
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
  }), [call, connection?.connected, connection?.error, connection?.pairingRequired, reconnect, subscribe]);

  return createElement(GatewayContext.Provider, { value }, children);
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) {
    throw new Error("useGateway must be used within a GatewayProvider");
  }
  return context;
}
